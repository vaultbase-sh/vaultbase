import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  _resetCollectionCache,
  createCollection,
  type FieldDef,
} from "../core/collections.ts";
import { computeSnapshotDiff } from "../api/migrations.ts";

beforeEach(async () => {
  initDb(":memory:");
  _resetCollectionCache();
  await runMigrations();
});

afterEach(() => closeDb());

interface CollectionSnapshot {
  name: string;
  type: "base" | "auth" | "view";
  fields: FieldDef[];
  view_query?: string | null;
  list_rule?: string | null;
  view_rule?: string | null;
  create_rule?: string | null;
  update_rule?: string | null;
  delete_rule?: string | null;
}
interface Snapshot {
  generated_at: string;
  version: 1;
  collections: CollectionSnapshot[];
}

function snap(collections: CollectionSnapshot[]): Snapshot {
  return { generated_at: new Date().toISOString(), version: 1, collections };
}

describe("computeSnapshotDiff", () => {
  it("flags every local collection as removed when snapshot is empty", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createCollection({ name: "tags",  fields: JSON.stringify([{ name: "label", type: "text" }]) });

    const diff = await computeSnapshotDiff(snap([]));

    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.removed.map((r) => r.name).sort()).toEqual(["posts", "tags"]);
  });

  it("flags every collection as unchanged for an identical snapshot", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });

    const diff = await computeSnapshotDiff(snap([
      { name: "posts", type: "base", fields: [{ name: "title", type: "text" }] },
    ]));

    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged.map((u) => u.name)).toEqual(["posts"]);
  });

  it("reports a brand new collection as added", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });

    const diff = await computeSnapshotDiff(snap([
      { name: "posts", type: "base", fields: [{ name: "title", type: "text" }] },
      { name: "comments", type: "base", fields: [{ name: "body", type: "text" }] },
    ]));

    expect(diff.added).toEqual([{ name: "comments", type: "base" }]);
    expect(diff.unchanged.map((u) => u.name)).toEqual(["posts"]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("flags a new field as modified with a fields-mentioning change entry", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });

    const diff = await computeSnapshotDiff(snap([
      {
        name: "posts",
        type: "base",
        fields: [
          { name: "title", type: "text" },
          { name: "body",  type: "text" },
        ],
      },
    ]));

    expect(diff.modified.length).toBe(1);
    expect(diff.modified[0]!.name).toBe("posts");
    const changeStr = diff.modified[0]!.changes.join("|");
    expect(changeStr).toContain("fields");
    expect(changeStr).toContain("1 added");
    // Only the field count should change, not rules.
    expect(diff.modified[0]!.changes.some((c) => c.includes("rule"))).toBe(false);
  });

  it("flags a list_rule change as modified mentioning list_rule", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });

    const diff = await computeSnapshotDiff(snap([
      {
        name: "posts",
        type: "base",
        fields: [{ name: "title", type: "text" }],
        list_rule: '@request.auth.id != ""',
      },
    ]));

    expect(diff.modified.length).toBe(1);
    expect(diff.modified[0]!.name).toBe("posts");
    expect(diff.modified[0]!.changes).toContain("list_rule changed");
    // Field set is unchanged in this scenario.
    expect(diff.modified[0]!.changes.some((c) => c.startsWith("fields:"))).toBe(false);
  });
});
