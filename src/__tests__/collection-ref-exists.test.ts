/**
 * `@collection.members.user = @request.auth.id` compiled to
 * `(SELECT user FROM vb_members LIMIT 1) = ?`: it compared against one
 * arbitrary row, so only whichever member came first passed. A comparison
 * with an `@collection.*` operand now means "some row of that collection
 * (that the caller may view) matches".
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-collection-ref";
const ids: Record<string, string> = {};

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  for (const n of ["alice", "bob", "carol"]) ids[n] = await seedAuthUser({ collection: "users", email: `${n}@test.local` });
  await createCollection({
    name: "members", fields: JSON.stringify([{ name: "user", type: "text" }, { name: "role", type: "text" }]),
    list_rule: null, view_rule: null,
  });
  await createRecord("members", { user: ids["alice"], role: "editor" }, null);
  await createRecord("members", { user: ids["bob"], role: "viewer" }, null);
});

afterEach(() => closeDb());

async function count(rule: string, who: string): Promise<number> {
  await createCollection({ name: "docs", fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: rule, view_rule: rule });
  await createRecord("docs", { t: "x" }, null);
  const res = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/docs", {
    headers: { authorization: `Bearer ${await signUserJwt(ids[who]!, `${who}@test.local`, "users", SECRET)}` },
  }));
  return ((await res.json()) as { data: unknown[] }).data.length;
}

describe("@collection.* comparisons", () => {
  it("match any row, not just the first", async () => {
    expect(await count("@collection.members.user = @request.auth.id", "bob")).toBe(1);
  });

  it("still refuse a caller with no matching row", async () => {
    expect(await count("@collection.members.user = @request.auth.id", "carol")).toBe(0);
  });

  it("the first row's member keeps access (legitimate path)", async () => {
    expect(await count("@collection.members.user = @request.auth.id", "alice")).toBe(1);
  });

  it("the reference on the right works the same way", async () => {
    expect(await count("@request.auth.id = @collection.members.user", "bob")).toBe(1);
  });

  it("so does ~", async () => {
    expect(await count('@collection.members.role ~ "view"', "bob")).toBe(1);
  });
});

describe("@collection.* on the right of ~", () => {
  it("uses each row's value as the pattern", async () => {
    // bob's role "viewer" is contained in "viewers-only"; alice's isn't.
    expect(await count('"viewers-only" ~ @collection.members.role', "carol")).toBe(1);
  });
});
