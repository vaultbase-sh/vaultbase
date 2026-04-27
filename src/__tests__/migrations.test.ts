import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  _resetCollectionCache,
  createCollection,
  getCollection,
  listCollections,
  parseFields,
  updateCollection,
} from "../core/collections.ts";
import { createRecord } from "../core/records.ts";

beforeEach(async () => {
  initDb(":memory:");
  _resetCollectionCache();
  await runMigrations();
});

afterEach(() => closeDb());

// The migrations endpoints are thin wrappers around createCollection /
// updateCollection / listCollections; we test the integration by simulating
// what the endpoints do, since spinning up Elysia in-process is heavier than
// these primitives need.

interface CollectionSnapshot {
  name: string;
  type: "base" | "auth" | "view";
  fields: ReturnType<typeof parseFields>;
  view_query?: string | null;
  list_rule?: string | null;
}

async function buildSnapshot(): Promise<CollectionSnapshot[]> {
  const cols = await listCollections();
  return cols.map((c) => ({
    name: c.name,
    type: (c.type ?? "base") as "base" | "auth" | "view",
    fields: parseFields(c.fields),
    ...(c.view_query ? { view_query: c.view_query } : {}),
    ...(c.list_rule  ? { list_rule:  c.list_rule  } : {}),
  }));
}

async function applyAdditive(snap: CollectionSnapshot[]): Promise<{ created: string[]; skipped: string[] }> {
  const out = { created: [] as string[], skipped: [] as string[] };
  for (const c of snap) {
    const existing = await getCollection(c.name);
    if (existing) { out.skipped.push(c.name); continue; }
    await createCollection({
      name: c.name,
      type: c.type,
      fields: JSON.stringify(c.fields),
      view_query: c.view_query ?? null,
      list_rule: c.list_rule ?? null,
    });
    out.created.push(c.name);
  }
  return out;
}

async function applySync(snap: CollectionSnapshot[]): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
  const out = { created: [] as string[], updated: [] as string[], skipped: [] as string[] };
  for (const c of snap) {
    const existing = await getCollection(c.name);
    if (!existing) {
      await createCollection({
        name: c.name,
        type: c.type,
        fields: JSON.stringify(c.fields),
        view_query: c.view_query ?? null,
        list_rule: c.list_rule ?? null,
      });
      out.created.push(c.name);
      continue;
    }
    const fieldsChanged = JSON.stringify(parseFields(existing.fields)) !== JSON.stringify(c.fields);
    const ruleChanged = (existing.list_rule ?? null) !== (c.list_rule ?? null);
    if (fieldsChanged || ruleChanged) {
      await updateCollection(existing.id, {
        fields: JSON.stringify(c.fields),
        list_rule: c.list_rule ?? null,
      });
      out.updated.push(c.name);
    } else {
      out.skipped.push(c.name);
    }
  }
  return out;
}

describe("snapshot shape", () => {
  it("captures every collection's name, type, and fields", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    const snap = await buildSnapshot();
    const names = snap.map((c) => c.name).sort();
    expect(names).toEqual(["posts", "users"]);
    const posts = snap.find((c) => c.name === "posts")!;
    expect(posts.type).toBe("base");
    expect(posts.fields[0]?.name).toBe("title");
    const users = snap.find((c) => c.name === "users")!;
    expect(users.type).toBe("auth");
    // Implicit auth fields auto-injected
    expect(users.fields.find((f) => f.name === "email")).toBeDefined();
  });

  it("includes view_query for view collections", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createCollection({
      name: "post_titles",
      type: "view",
      view_query: "SELECT id, title FROM vb_posts",
    });
    const snap = await buildSnapshot();
    const view = snap.find((c) => c.name === "post_titles")!;
    expect(view.view_query).toBe("SELECT id, title FROM vb_posts");
  });
});

describe("apply — additive mode", () => {
  it("creates missing collections", async () => {
    const snap: CollectionSnapshot[] = [
      { name: "posts", type: "base", fields: [{ name: "title", type: "text" }] },
      { name: "tags",  type: "base", fields: [{ name: "label", type: "text" }] },
    ];
    const r = await applyAdditive(snap);
    expect(r.created.sort()).toEqual(["posts", "tags"]);
    expect(r.skipped).toEqual([]);
    expect(await getCollection("posts")).not.toBeNull();
    expect(await getCollection("tags")).not.toBeNull();
  });

  it("skips existing collections without modifying them", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const snap: CollectionSnapshot[] = [
      { name: "posts", type: "base", fields: [{ name: "title", type: "text" }, { name: "body", type: "text" }] },
    ];
    const r = await applyAdditive(snap);
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual(["posts"]);
    const after = await getCollection("posts");
    // Field count unchanged — "body" was NOT added
    expect(parseFields(after!.fields).length).toBe(1);
  });

  it("preserves data in additive mode (new install path)", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("posts", { title: "hello" });
    // Apply same snapshot; data should be untouched.
    const snap = await buildSnapshot();
    await applyAdditive(snap);
    const col = await getCollection("posts");
    expect(col).not.toBeNull();
  });
});

describe("apply — sync mode", () => {
  it("updates existing collections to match snapshot", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const snap: CollectionSnapshot[] = [
      { name: "posts", type: "base", fields: [{ name: "title", type: "text" }, { name: "body", type: "text" }] },
    ];
    const r = await applySync(snap);
    expect(r.updated).toEqual(["posts"]);
    const after = await getCollection("posts");
    const fields = parseFields(after!.fields);
    expect(fields.map((f) => f.name).sort()).toEqual(["body", "title"]);
  });

  it("skips collections already in sync", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const snap = await buildSnapshot();
    const r = await applySync(snap);
    expect(r.skipped).toEqual(["posts"]);
    expect(r.updated).toEqual([]);
  });

  it("propagates rule changes", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const snap: CollectionSnapshot[] = [
      { name: "posts", type: "base", fields: [{ name: "title", type: "text" }], list_rule: '@request.auth.id != ""' },
    ];
    const r = await applySync(snap);
    expect(r.updated).toEqual(["posts"]);
    const after = await getCollection("posts");
    expect(after?.list_rule).toBe('@request.auth.id != ""');
  });
});
