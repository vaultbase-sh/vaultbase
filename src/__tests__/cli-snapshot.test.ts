import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  _resetCollectionCache,
  createCollection,
  getCollection,
  parseFields,
} from "../core/collections.ts";
import {
  applySnapshot,
  SnapshotShapeError,
  type Snapshot,
  type CollectionSnapshot,
} from "../core/migrations.ts";

beforeEach(async () => {
  initDb(":memory:");
  _resetCollectionCache();
  await runMigrations();
});

afterEach(() => closeDb());

function snap(collections: CollectionSnapshot[]): Snapshot {
  return { generated_at: new Date().toISOString(), version: 1, collections };
}

describe("applySnapshot — shape validation", () => {
  it("throws SnapshotShapeError on a non-object", async () => {
    await expect(applySnapshot(null)).rejects.toBeInstanceOf(SnapshotShapeError);
    await expect(applySnapshot("nope" as unknown)).rejects.toBeInstanceOf(SnapshotShapeError);
  });

  it("throws on missing/wrong version", async () => {
    await expect(applySnapshot({ collections: [] })).rejects.toBeInstanceOf(SnapshotShapeError);
    await expect(applySnapshot({ version: 2, collections: [] })).rejects.toBeInstanceOf(SnapshotShapeError);
  });

  it("throws when collections is not an array", async () => {
    await expect(
      applySnapshot({ generated_at: "x", version: 1, collections: "no" })
    ).rejects.toBeInstanceOf(SnapshotShapeError);
  });

  it("throws on a collection entry missing name/type/fields", async () => {
    await expect(
      applySnapshot({ generated_at: "x", version: 1, collections: [{}] })
    ).rejects.toBeInstanceOf(SnapshotShapeError);
    await expect(
      applySnapshot({
        generated_at: "x",
        version: 1,
        collections: [{ name: "x", type: "weird", fields: [] }],
      })
    ).rejects.toBeInstanceOf(SnapshotShapeError);
    await expect(
      applySnapshot({
        generated_at: "x",
        version: 1,
        collections: [{ name: "x", type: "base", fields: "no" }],
      })
    ).rejects.toBeInstanceOf(SnapshotShapeError);
  });

  it("rejects unknown mode values", async () => {
    await expect(
      applySnapshot(snap([]), { mode: "weird" as unknown as "additive" })
    ).rejects.toBeInstanceOf(SnapshotShapeError);
  });
});

describe("applySnapshot — empty cases", () => {
  it("empty snapshot vs empty DB → all zero", async () => {
    const r = await applySnapshot(snap([]));
    expect(r.created).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.unchanged).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe("applySnapshot — additive mode (default)", () => {
  it("creates a missing collection (created: 1), and is idempotent on re-apply", async () => {
    const s = snap([
      { name: "posts", type: "base", fields: [{ name: "title", type: "text" }] },
    ]);

    const first = await applySnapshot(s);
    expect(first.created).toEqual(["posts"]);
    expect(first.updated).toEqual([]);
    expect(first.unchanged).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(await getCollection("posts")).not.toBeNull();

    // Idempotent: second run is a no-op.
    const second = await applySnapshot(s);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toEqual(["posts"]);
    expect(second.errors).toEqual([]);
  });

  it("skips updating an existing collection that drifts from the snapshot", async () => {
    await createCollection({
      name: "posts",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    const s = snap([
      {
        name: "posts",
        type: "base",
        fields: [
          { name: "title", type: "text" },
          { name: "body", type: "text" },
        ],
      },
    ]);

    const r = await applySnapshot(s, { mode: "additive" });
    expect(r.created).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.unchanged).toEqual([]);
    expect(r.skipped).toEqual(["posts"]);

    // Field count unchanged on disk — `body` was NOT added.
    const after = await getCollection("posts");
    expect(parseFields(after!.fields).length).toBe(1);
  });
});

describe("applySnapshot — sync mode", () => {
  it("updates an existing collection that drifts", async () => {
    await createCollection({
      name: "posts",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    const s = snap([
      {
        name: "posts",
        type: "base",
        fields: [
          { name: "title", type: "text" },
          { name: "body", type: "text" },
        ],
      },
    ]);

    const r = await applySnapshot(s, { mode: "sync" });
    expect(r.updated).toEqual(["posts"]);
    expect(r.created).toEqual([]);
    expect(r.unchanged).toEqual([]);
    expect(r.errors).toEqual([]);

    const after = await getCollection("posts");
    const fieldNames = parseFields(after!.fields).map((f) => f.name).sort();
    expect(fieldNames).toEqual(["body", "title"]);
  });

  it("reports unchanged when collection is already in sync (idempotent)", async () => {
    await createCollection({
      name: "posts",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    const s = snap([
      { name: "posts", type: "base", fields: [{ name: "title", type: "text" }] },
    ]);

    const r = await applySnapshot(s, { mode: "sync" });
    expect(r.unchanged).toEqual(["posts"]);
    expect(r.updated).toEqual([]);
    expect(r.created).toEqual([]);
  });
});
