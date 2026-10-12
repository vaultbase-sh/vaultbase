/**
 * A view collection over an auth table (`SELECT * FROM vb_users`) returned
 * password hashes and TOTP secrets: private columns were only stripped for
 * auth collections. And the view-query check stripped comments with a regex
 * before strings, so a `'--'` inside a string hid the rest of the line —
 * including `pragma_*` / `sqlite_*` references it is meant to refuse.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, validateViewQuery, _resetCollectionCache } from "../core/collections.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { seedAuthUser } from "./_helpers.ts";

const SECRET = "test-secret-view-private";

beforeEach(async () => {
  _resetCollectionCache();
  initDb(":memory:");
  await runMigrations();
  await seedAuthUser({ collection: "users", email: "a@test.local", passwordHash: "$argon2id$secret-hash" });
});

afterEach(() => closeDb());

const list = (q = "") => makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/people${q}`));

describe("views over auth tables", () => {
  it("SELECT * doesn't hand out password hashes or TOTP secrets", async () => {
    await createCollection({ name: "people", type: "view", view_query: "SELECT * FROM vb_users", list_rule: null, view_rule: null });
    const res = await list();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("secret-hash");
    expect(text).not.toContain("password_hash");
    expect(text).toContain("a@test.local");
  });

  it("the private columns can't be filtered on either", async () => {
    await createCollection({ name: "people", type: "view", view_query: "SELECT * FROM vb_users", list_rule: null, view_rule: null });
    expect((await list(`?filter=${encodeURIComponent('password_hash > "$"')}`)).status).toBe(400);
  });

  it("selecting them by name or alias is refused", () => {
    for (const q of [
      "SELECT id, password_hash FROM vb_users",
      "SELECT id, password_hash AS ph FROM vb_users",
      'SELECT id, "password_hash" AS ph FROM vb_users',
      "SELECT id, [totp_secret] AS t FROM vb_users",
    ]) expect(() => validateViewQuery(q)).toThrow();
  });
});

describe("view query check", () => {
  it("a '--' inside a string doesn't hide what follows", () => {
    expect(() => validateViewQuery("SELECT '--' AS a, (SELECT group_concat(name) FROM pragma_table_info('vb_users')) AS b")).toThrow();
    expect(() => validateViewQuery("SELECT '--' AS a, (SELECT sql FROM sqlite_master LIMIT 1) AS b")).toThrow();
  });

  it("ordinary views still pass (legitimate path)", () => {
    expect(() => validateViewQuery("SELECT id, email, created_at FROM vb_users WHERE email LIKE '%--%'")).not.toThrow();
  });
});
