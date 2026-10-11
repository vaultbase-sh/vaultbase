import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords, AccessRuleError, FilterError } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-list-rule";

// A list rule or filter that cannot be compiled must never widen the result
// set. Previously the compile error was swallowed and no WHERE was emitted,
// so a broken rule (or a valid one hitting a cold collection cache) returned
// the whole table to non-admins.

const OWNER = { id: "owner-1", type: "user" as const };
const STRANGER = { id: "stranger-1", type: "user" as const };
const TEAM_RULE = "@collection.teams.owner = @request.auth.id";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "teams", fields: JSON.stringify([{ name: "owner", type: "text" }]) });
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  await createRecord("teams", { owner: OWNER.id });
  await createRecord("posts", { title: "one" });
  await createRecord("posts", { title: "two" });
});

afterEach(() => {
  _resetCollectionCache();
  closeDb();
});

describe("list access rule — fail closed", () => {
  it("@collection rule works on a cold cache (right after restart)", async () => {
    _resetCollectionCache();
    const stranger = await listRecords("posts", { accessRule: TEAM_RULE, auth: STRANGER });
    expect(stranger.data.length).toBe(0);
    _resetCollectionCache();
    const owner = await listRecords("posts", { accessRule: TEAM_RULE, auth: OWNER });
    expect(owner.data.length).toBe(2);
  });

  it("a rule referencing an unknown collection is refused, not dropped", async () => {
    await expect(
      listRecords("posts", { accessRule: "@collection.nope.owner = @request.auth.id", auth: STRANGER }),
    ).rejects.toBeInstanceOf(AccessRuleError);
  });

  it("a syntactically broken rule is refused, not dropped", async () => {
    await expect(
      listRecords("posts", { accessRule: "title = = 'x'", auth: STRANGER }),
    ).rejects.toBeInstanceOf(AccessRuleError);
  });
});

describe("list endpoint — HTTP status", () => {
  it("broken list_rule → 403, no rows leaked", async () => {
    await createPublicCollection({
      name: "secrets",
      fields: JSON.stringify([{ name: "v", type: "text" }]),
      list_rule: "@collection.missing.owner = @request.auth.id",
    });
    await createRecord("secrets", { v: "hidden" });
    const res = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/secrets"));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("hidden");
  });

  it("invalid filter → 400", async () => {
    const res = await makeRecordsPlugin(SECRET).handle(
      new Request(`http://localhost/posts?filter=${encodeURIComponent("title = = 'x'")}`),
    );
    expect(res.status).toBe(400);
  });
});

describe("list filter — invalid input is rejected", () => {
  it("throws FilterError instead of silently ignoring the filter", async () => {
    await expect(listRecords("posts", { filter: "title = = 'x'" })).rejects.toBeInstanceOf(FilterError);
  });

  it("a valid filter still narrows the result", async () => {
    const r = await listRecords("posts", { filter: 'title = "one"' });
    expect(r.data.length).toBe(1);
  });
});
