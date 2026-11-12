/**
 * Schema snapshots keep access rules: a rule the snapshot leaves out keeps
 * the existing collection's rule on sync (admin-only when it creates one),
 * and the HTTP export writes all five rules, public ones included, so an
 * export / import round trip changes nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, createCollection, getCollection } from "../core/collections.ts";
import { applySnapshot, computeSnapshotDiff, type Snapshot } from "../core/migrations.ts";
import { makeMigrationsPlugin } from "../api/migrations.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-snapshot-rules";
const RULES = ["list_rule", "view_rule", "create_rule", "update_rule", "delete_rule"] as const;
const rulesOf = async (name: string) => {
  const c = await getCollection(name);
  return RULES.map((r) => c?.[r]);
};
const ruleless = (name: string, fields: Array<{ name: string; type: string }>): Snapshot => ({
  generated_at: new Date().toISOString(),
  version: 1,
  collections: [{ name, type: "base", fields }],
});

async function exportSnapshot(): Promise<Snapshot> {
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 }).onConflictDoNothing();
  const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
  const res = await makeMigrationsPlugin(SECRET).handle(
    new Request("http://localhost/admin/migrations/snapshot", { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Snapshot;
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});
afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

describe("snapshot rules", () => {
  it("a rule-less sync that changes fields keeps an admin-only collection admin-only", async () => {
    await createCollection({ name: "secrets", fields: JSON.stringify([{ name: "note", type: "text" }]) });
    expect(await rulesOf("secrets")).toEqual(["", "", "", "", ""]);
    const res = await applySnapshot(ruleless("secrets", [{ name: "note", type: "text" }, { name: "extra", type: "text" }]), { mode: "sync" });
    expect(res.updated).toEqual(["secrets"]);
    expect(await rulesOf("secrets")).toEqual(["", "", "", "", ""]);
  });

  it("a rule-less sync keeps a public collection public", async () => {
    await createCollection({
      name: "pub", fields: JSON.stringify([{ name: "t", type: "text" }]),
      list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    });
    await applySnapshot(ruleless("pub", [{ name: "t", type: "text" }, { name: "u", type: "text" }]), { mode: "sync" });
    expect(await rulesOf("pub")).toEqual([null, null, null, null, null]);
  });

  it("a rule the snapshot carries is applied; the ones it leaves out are kept", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: null });
    const snap = ruleless("posts", [{ name: "t", type: "text" }]);
    snap.collections[0]!.view_rule = '@request.auth.id != ""';
    await applySnapshot(snap, { mode: "sync" });
    expect(await rulesOf("posts")).toEqual([null, '@request.auth.id != ""', "", "", ""]);
  });

  it("a rule-less snapshot is in sync with any rules, and creates admin-only", async () => {
    await createCollection({ name: "pub", fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: null });
    const diff = await computeSnapshotDiff(ruleless("pub", [{ name: "t", type: "text" }]));
    expect(diff.unchanged.map((c) => c.name)).toEqual(["pub"]);
    await applySnapshot(ruleless("fresh", [{ name: "t", type: "text" }]), { mode: "additive" });
    expect(await rulesOf("fresh")).toEqual(["", "", "", "", ""]);
  });

  it("export writes all five rules, public ones as null", async () => {
    await createCollection({
      name: "mixed", fields: JSON.stringify([{ name: "t", type: "text" }]),
      list_rule: null, view_rule: "", create_rule: '@request.auth.id != ""',
    });
    const snap = await exportSnapshot();
    const c = snap.collections.find((x) => x.name === "mixed")!;
    expect(RULES.map((r) => c[r])).toEqual([null, "", '@request.auth.id != ""', "", ""]);
  });

  it("an export / import round trip into a fresh database keeps every rule", async () => {
    await createCollection({
      name: "pub", fields: JSON.stringify([{ name: "t", type: "text" }]),
      list_rule: null, view_rule: null, create_rule: '@request.auth.id != ""', update_rule: "", delete_rule: null,
    });
    const before = await rulesOf("pub");
    const snap = await exportSnapshot();
    _resetCollectionCache();
    await closeDb();
    await initDb(":memory:");
    await runMigrations();
    const res = await applySnapshot(snap, { mode: "additive" });
    expect(res.created).toContain("pub");
    expect(await rulesOf("pub")).toEqual(before);
    expect((await computeSnapshotDiff(snap)).modified).toEqual([]);
  });
});

describe("snapshots carry history and admin indexes", () => {
  it("export them, and apply them to a fresh install", async () => {
    const { updateCollection } = await import("../core/collections.ts");
    const { createCollectionIndex, listIndexes } = await import("../api/indexes.ts");
    const col = await createCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "rank", type: "number" }]) });
    await updateCollection(col.id, { history_enabled: 1 });
    await createCollectionIndex((await getCollection("notes"))!, ["title", "rank"]);
    const snap = await exportSnapshot();
    const notes = snap.collections.find((c) => c.name === "notes")!;
    expect(notes.history_enabled).toBe(true);
    expect(notes.indexes).toEqual([{ fields: ["title", "rank"], unique: false }]);

    // A fresh install.
    await closeDb(); _resetCollectionCache();
    await initDb(":memory:"); await runMigrations();
    const r = await applySnapshot(snap, { mode: "additive" });
    expect(r.errors).toEqual([]);
    expect((await getCollection("notes"))!.history_enabled).toBe(1);
    expect((await listIndexes("vb_notes")).some((i) => i.fields.join(",") === "title,rank")).toBe(true);
  });

  it("re-applies a snapshot whose index ends with id (Postgres appends id as a tie-break itself)", async () => {
    const { createCollectionIndex, listIndexes } = await import("../api/indexes.ts");
    const snap: Snapshot = {
      generated_at: new Date().toISOString(), version: 1,
      collections: [{
        name: "zz_probe", type: "base", fields: [{ name: "a", type: "text" }, { name: "b", type: "text" }],
        indexes: [{ fields: ["a", "id"], unique: false }, { fields: ["a", "b"], unique: false }, { fields: ["b", "id"], unique: true }, { fields: ["b"], unique: false }],
      }],
    };
    for (let i = 0; i < 3; i++) expect((await applySnapshot(snap, { mode: "additive" })).errors).toEqual([]);
    // Listed as they were asked for, so an export applies again unchanged.
    // (Without the indexes every collection gets on created_at and updated_at.)
    const mine = async () => (await listIndexes("vb_zz_probe")).filter((i) => !i.name.startsWith("idx_vb_"));
    const listed = (await mine()).map((i) => `${i.name}:${i.fields.join(",")}:${i.unique}`).sort();
    expect(listed).toEqual([
      "idx_zz_probe_a_b:a,b:false", "idx_zz_probe_a_id:a,id:false", "idx_zz_probe_b:b:false", "uniq_zz_probe_b_id:b,id:true",
    ]);
    const exported = (await exportSnapshot()).collections.find((c) => c.name === "zz_probe")!;
    expect((await applySnapshot({ ...snap, collections: [exported] }, { mode: "additive" })).errors).toEqual([]);
    expect((await mine()).length).toBe(4);
    // The same index asked for again through the admin API is the one there.
    expect((await createCollectionIndex((await getCollection("zz_probe"))!, ["a", "id"])).name).toBe("idx_zz_probe_a_id");
  });

  it("an auth collection's built-in fields aren't a difference when the snapshot leaves them out", async () => {
    const snap: Snapshot = {
      generated_at: new Date().toISOString(), version: 1,
      collections: [{ name: "owners", type: "auth", fields: [{ name: "name", type: "text" }] }],
    };
    const first = await applySnapshot(snap, { mode: "additive" });
    expect([first.created, first.errors]).toEqual([["owners"], []]);
    const stored = JSON.parse((await getCollection("owners"))!.fields) as Array<{ name: string }>;
    expect(stored.map((f) => f.name)).toEqual(["email", "verified", "name"]);

    const diff = await computeSnapshotDiff(snap);
    expect(diff.modified).toEqual([]);
    expect(diff.unchanged).toEqual([{ name: "owners" }]);
    const again = await applySnapshot(snap, { mode: "additive" });
    expect([again.unchanged, again.skipped]).toEqual([["owners"], []]);
    const sync = await applySnapshot(snap, { mode: "sync" });
    expect([sync.unchanged, sync.updated]).toEqual([["owners"], []]);

    // A real change is still one.
    const more = { ...snap, collections: [{ ...snap.collections[0]!, fields: [{ name: "name", type: "text" }, { name: "phone", type: "text" }] }] };
    expect((await computeSnapshotDiff(more)).modified[0]?.changes).toEqual(["fields: 1 added"]);
  });
});
