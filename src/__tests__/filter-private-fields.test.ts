/**
 * Hidden columns must not be reachable from a filter expression.
 *
 * Stripping `password_hash` and `totp_secret` from response bodies is not
 * enough on its own. A filter never returns the column, but it does change the
 * row count, so
 *
 *   GET /api/v1/users?filter=id="victim" && password_hash > "$argon2id$...M"
 *
 * is an oracle: binary-search the hash one character at a time. The same trick
 * works through `@collection.X.col` and `_via_` joins, and against any
 * user-declared `password` field on an ordinary collection.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { listRecords, createRecord, FilterError } from "../core/records.ts";
import { aggregateRecords } from "../core/aggregate.ts";
import { getCollection } from "../core/collections.ts";
import { admin } from "../db/schema.ts";

import type { AuthContext } from "../core/rules.ts";

const USER: AuthContext = { id: "u1", type: "user", email: "u@test.local" };
const ADMIN: AuthContext = { id: "admin-1", type: "admin", email: "a@test.local" };

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  await getDb().insert(admin).values({
    id: "admin-1", email: "a@test.local", password_hash: "x",
    password_reset_at: 0, created_at: Math.floor(Date.now() / 1000),
  });
  await createCollection({
    name: "users",
    type: "auth",
    fields: JSON.stringify([]),
    list_rule: null,
    view_rule: null,
  });
  await createCollection({
    name: "posts",
    type: "base",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "author", type: "relation", collection: "users" },
      { name: "secret", type: "password" },
    ]),
    list_rule: null,
    view_rule: null,
  });
  _resetCollectionCache();
});
afterEach(() => closeDb());

async function listWith(collection: string, filter: string, auth: AuthContext = USER) {
  return listRecords(collection, { filter, auth });
}

describe("filters cannot reach auth secrets", () => {
  for (const column of ["password_hash", "totp_secret", "password_reset_at"]) {
    it(`rejects a direct reference to ${column}`, async () => {
      await expect(listWith("users", `${column} > "a"`)).rejects.toThrow(FilterError);
    });
  }

  it("rejects the binary-search oracle shape specifically", async () => {
    await expect(
      listWith("users", `id = "victim" && password_hash > "$argon2id$v=19$m"`),
    ).rejects.toThrow(FilterError);
  });

  it("rejects it through an @collection.* join", async () => {
    await expect(
      listWith("posts", `@collection.users.password_hash > "a"`),
    ).rejects.toThrow(FilterError);
  });

  it("rejects it through a _via_ back-relation path", async () => {
    await expect(
      listWith("users", `posts_via_author.secret > "a"`),
    ).rejects.toThrow(FilterError);
  });

  it("rejects a user-declared password field on a base collection", async () => {
    await expect(listWith("posts", `secret > "a"`)).rejects.toThrow(FilterError);
  });

  it("refuses admins too — hidden means hidden", async () => {
    // Simpler to reason about than a per-role carve-out, and an admin has the
    // SQL runner if they genuinely need the column.
    await expect(listWith("users", `password_hash > "a"`, ADMIN)).rejects.toThrow(FilterError);
  });

  it("does not confirm whether the column exists", async () => {
    // Same wording for a hidden column on any collection, so the error can't
    // be used to probe the schema.
    const grab = async (c: string, f: string): Promise<Error> => {
      try { await listWith(c, f); throw new Error("expected a rejection"); }
      catch (e) { return e as Error; }
    };
    const e1 = await grab("users", `password_hash > "a"`);
    const e2 = await grab("posts", `secret > "a"`);
    expect(e1.message).toContain("unknown field");
    expect(e2.message).toContain("unknown field");
    expect(e1.message).not.toContain("private");
    expect(e1.message).not.toContain("password_hash is");
  });
});

describe("the schema is not probeable", () => {
  it("gives a non-existent column the same error as a hidden one", async () => {
    const grab = async (c: string, f: string): Promise<Error> => {
      try { await listWith(c, f); throw new Error("expected a rejection"); }
      catch (e) { return e as Error; }
    };
    const hidden = await grab("users", `password_hash > "a"`);
    const absent = await grab("users", `nonexistent_xyz > "a"`);
    // Identical wording apart from the name the caller already supplied, so
    // the response can't be used to enumerate columns.
    expect(hidden.message.replace("password_hash", "X"))
      .toBe(absent.message.replace("nonexistent_xyz", "X"));
  });

  it("rejects an unknown column as a 400-mapped FilterError, not a SQL 500", async () => {
    // This used to reach SQLite and surface "no such column: vb_users.zzz".
    await expect(listWith("users", `zzz_probe = 1`)).rejects.toThrow(FilterError);
  });

  it("rejects a declared field that has no column", async () => {
    // `verified` is an implicit auth field whose storage column is
    // `email_verified`; filtering on it was a 500 before.
    await expect(listWith("users", `verified = true`)).rejects.toThrow(FilterError);
  });

  it("still allows the auth system columns that do exist", async () => {
    for (const f of ["email_verified = 1", "totp_enabled = 0", "is_anonymous = 0", `email != ""`]) {
      await expect(listWith("users", f)).resolves.toBeDefined();
    }
  });

  it("rejects an unknown column through a join too", async () => {
    await expect(listWith("posts", `@collection.users.zzz_probe = 1`)).rejects.toThrow(FilterError);
  });
});

describe("ordinary filtering still works", () => {
  it("allows a normal field", async () => {
    await createRecord("posts", { title: "hello" });
    const res = await listRecords("posts", { filter: `title = "hello"`, auth: USER });
    expect(res.totalItems).toBe(1);
  });

  it("allows a legitimate @collection join", async () => {
    await createRecord("posts", { title: "hello" });
    const res = await listRecords("posts", {
      filter: `@collection.users.email != ""`,
      auth: USER,
    });
    expect(res.totalItems).toBeGreaterThanOrEqual(0);
  });
});

describe("aggregates cannot reach hidden columns either", () => {
  it("refuses min() on an auth secret", async () => {
    const col = (await getCollection("users"))!;
    await expect(aggregateRecords(col, { agg: "min(password_hash)", auth: USER }))
      .rejects.toThrow();
  });

  it("refuses an aggregate on a password-typed field", async () => {
    const col = (await getCollection("posts"))!;
    await expect(aggregateRecords(col, { agg: "max(secret)", auth: USER }))
      .rejects.toThrow();
  });

  it("refuses grouping by a password-typed field", async () => {
    const col = (await getCollection("posts"))!;
    await expect(aggregateRecords(col, { agg: "count", groupBy: "secret", auth: USER }))
      .rejects.toThrow();
  });
});
