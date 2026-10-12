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

describe("review 10 follow-ups", () => {
  it("/_aggregate can't group by a view's private columns", async () => {
    await createCollection({ name: "people", type: "view", view_query: "SELECT * FROM vb_users", list_rule: null, view_rule: null });
    const res = await list(`/_aggregate?agg=count&groupBy=password_hash`);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("secret-hash");
  });

  it("sorting by a private column is ignored, so row order doesn't leak it", async () => {
    await seedAuthUser({ collection: "users", email: "b@test.local", passwordHash: "$zzz" });
    await createCollection({ name: "people", type: "view", view_query: "SELECT * FROM vb_users", list_rule: null, view_rule: null });
    const order = async (sort: string) => ((await (await list(`?sort=${sort}`)).json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(await order("password_hash")).toEqual(await order("-password_hash"));
  });

  it("a base collection's password field can't be read through a view, nor renamed by UNION", async () => {
    await createCollection({ name: "vault", fields: JSON.stringify([{ name: "pin", type: "password" }]) });
    expect(() => validateViewQuery("SELECT id, pin AS p FROM vb_vault")).toThrow();
    expect(() => validateViewQuery("SELECT 1 AS id, 2 AS email, 3 AS a, 4 AS b, 5 AS c, 6 AS d, 7 AS e, 8 AS f, 9 AS g, 10 AS h UNION SELECT * FROM vb_users")).toThrow();
    expect(() => validateViewQuery("SELECT id FROM vb_vault UNION SELECT id FROM vb_users")).toThrow();
  });
});

describe("review 13 follow-ups", () => {
  it("a view joining two users doesn't return the second user's secrets as name:1", async () => {
    await createCollection({
      name: "pairs", type: "view", list_rule: null, view_rule: null,
      view_query: "SELECT a.id, a.email, b.email AS other_email, a.password_hash AS x FROM vb_users a, vb_users b",
    }).catch(() => undefined); // refused by name: fine
    await createCollection({
      name: "pairs2", type: "view", list_rule: null, view_rule: null,
      view_query: "SELECT * FROM vb_users a JOIN vb_users b ON 1 = 1",
    });
    const res = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/pairs2"));
    const text = await res.text();
    expect(text).not.toContain("secret-hash");
    expect(text).not.toContain("password_hash");
    expect(text).not.toContain("totp_secret");
  });

  it("a UNION through an intermediate view is refused", async () => {
    await createCollection({ name: "everyone", type: "view", view_query: "SELECT * FROM vb_users", list_rule: null, view_rule: null });
    expect(() => validateViewQuery("SELECT 1 AS a, 2 AS b UNION SELECT * FROM vb_everyone")).toThrow();
  });

  it("SELECT * over a collection with a password field doesn't return it", async () => {
    const { createRecord } = await import("../core/records.ts");
    await createCollection({ name: "vault2", fields: JSON.stringify([{ name: "label", type: "text" }, { name: "pin", type: "password" }]) });
    await createRecord("vault2", { label: "l", pin: "pin-secret-123" }, null);
    await createCollection({ name: "vaultview", type: "view", view_query: "SELECT * FROM vb_vault2", list_rule: null, view_rule: null });
    const res = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/vaultview"));
    const text = await res.text();
    expect(text).toContain('"label"');
    expect(text).not.toContain('"pin"');
    const agg = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/vaultview/_aggregate?agg=count&groupBy=pin"));
    expect(agg.status).toBe(400);
  });
});
