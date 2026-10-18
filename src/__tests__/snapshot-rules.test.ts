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
