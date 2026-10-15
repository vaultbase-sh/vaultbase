/**
 * `expand` must obey the target collection's view rule.
 *
 * The expand query was `SELECT * FROM <target> WHERE id IN (...)` with no rule
 * check. Anyone who could read a record carrying a relation got the full
 * related row back, even for records the target's view_rule would have hidden
 * — an authorization bypass. For a relation to an auth collection, that meant
 * harvesting every user's row (minus the output-stripped secrets) via any
 * public collection that points at it.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { signAuthToken } from "../core/sec.ts";
import type { AuthContext } from "../core/rules.ts";
import { admin } from "../db/schema.ts";
import { seedAuthUser } from "./_helpers.ts";

const SECRET = "test-secret-expand";
const OWNER = "u-owner";
const OTHER = "u-other";

let ownerAuth: AuthContext;
const adminAuth: AuthContext = { id: "admin-1", type: "admin", email: "a@test.local" };

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  await getDb().insert(admin).values({
    id: "admin-1", email: "a@test.local", password_hash: "x",
    password_reset_at: 0, created_at: Math.floor(Date.now() / 1000),
  });

  // An auth collection whose rows are owner-visible only.
  await createCollection({
    name: "users",
    type: "auth",
    fields: JSON.stringify([]),
    list_rule: null,
    view_rule: "id = @request.auth.id",
  });
  // A public collection that relates to it.
  await createCollection({
    name: "posts",
    type: "base",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "author", type: "relation", collection: "users" },
    ]),
    list_rule: null,
    view_rule: null,
  });
  _resetCollectionCache();

  await seedAuthUser({ collection: "users", id: OWNER, email: "owner@test.local" });
  await seedAuthUser({ collection: "users", id: OTHER, email: "other@test.local" });
  ownerAuth = { id: OWNER, type: "user", email: "owner@test.local" };
});
afterEach(() => closeDb());

describe("expand respects the target view rule", () => {
  it("does not expand a related row the caller may not view", async () => {
    // A post authored by OTHER; OWNER can read the post (public) but not OTHER.
    await createRecord("posts", { title: "p", author: OTHER });
    const res = await listRecords("posts", { expand: "author", auth: ownerAuth });
    const row = res.data[0] as { expand?: { author?: unknown } };
    // Previously: the full OTHER user row came back here.
    expect(row.expand?.author).toBeUndefined();
  });

  it("does expand a related row the caller may view", async () => {
    await createRecord("posts", { title: "p", author: OWNER });
    const res = await listRecords("posts", { expand: "author", auth: ownerAuth });
    const row = res.data[0] as { expand?: { author?: { id: string } } };
    expect(row.expand?.author?.id).toBe(OWNER);
  });

  it("never leaks password_hash / totp_secret even when expansion is allowed", async () => {
    await createRecord("posts", { title: "p", author: OWNER });
    const res = await listRecords("posts", { expand: "author", auth: ownerAuth });
    const author = (res.data[0] as { expand?: { author?: Record<string, unknown> } }).expand?.author;
    expect(author).toBeDefined();
    expect(author).not.toHaveProperty("password_hash");
    expect(author).not.toHaveProperty("totp_secret");
  });

  it("admin can expand any related row", async () => {
    await createRecord("posts", { title: "p", author: OTHER });
    const res = await listRecords("posts", { expand: "author", auth: adminAuth });
    const row = res.data[0] as { expand?: { author?: { id: string } } };
    expect(row.expand?.author?.id).toBe(OTHER);
  });

  it("blocks expansion into an admin-only collection for a non-admin", async () => {
    await createCollection({
      name: "secrets",
      type: "base",
      fields: JSON.stringify([{ name: "v", type: "text" }]),
      list_rule: null,
      view_rule: "", // admin-only
    });
    await createCollection({
      name: "refs",
      type: "base",
      fields: JSON.stringify([{ name: "s", type: "relation", collection: "secrets" }]),
      list_rule: null,
      view_rule: null,
    });
    _resetCollectionCache();
    const sec = await createRecord("secrets", { v: "classified" });
    await createRecord("refs", { s: sec["id"] });

    const asUser = await listRecords("refs", { expand: "s", auth: ownerAuth });
    expect((asUser.data[0] as { expand?: { s?: unknown } }).expand?.s).toBeUndefined();

    const asAdmin = await listRecords("refs", { expand: "s", auth: adminAuth });
    expect((asAdmin.data[0] as { expand?: { s?: { id: string } } }).expand?.s?.id).toBe(sec["id"]);
  });
});
