/**
 * `~` compiles to SQL LIKE, so a `%` or `_` in the right-hand value is a
 * wildcard. When that value comes from the request (`@request.headers.*`,
 * `@request.body.*`, …), the caller picks the pattern: a rule like
 * `tag ~ @request.headers.x_tag` matched every row when sent `%`. Runtime
 * values are now matched as plain text — what the in-process rule engine
 * already did — while literals a rule or filter author writes keep LIKE's
 * wildcards.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";

const SECRET = "test-secret-like-escape";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createCollection({
    name: "docs",
    fields: JSON.stringify([{ name: "tag", type: "text" }]),
    list_rule: "tag ~ @request.headers.x_tag",
  });
  for (const tag of ["alpha", "beta", "100%"]) await createRecord("docs", { tag }, null);
});

afterEach(() => closeDb());

async function list(xTag: string, filter?: string): Promise<string[]> {
  const q = filter ? `?filter=${encodeURIComponent(filter)}` : "";
  const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/docs${q}`, { headers: { "x-tag": xTag } }));
  const body = await res.json() as { data: Array<{ tag: string }> };
  return body.data.map((r) => r.tag).sort();
}

describe("~ with request values", () => {
  it("a % sent by the caller is not a wildcard", async () => {
    expect(await list("%")).toEqual(["100%"]);
    expect(await list("_")).toEqual([]);
  });

  it("plain substrings still match (legitimate path)", async () => {
    expect(await list("lph")).toEqual(["alpha"]);
  });

  it("a literal in a filter keeps LIKE wildcards", async () => {
    expect(await list("a", 'tag ~ "a_p"')).toEqual(["alpha"]);
  });
});

describe("~ with a field on the right", () => {
  it("compares against that field's value, not a match-everything pattern", async () => {
    const { createPublicCollection } = await import("./_helpers.ts");
    await createPublicCollection({ name: "pairs", fields: JSON.stringify([{ name: "a", type: "text" }, { name: "b", type: "text" }]) });
    await createRecord("pairs", { a: "hello", b: "ell" }, null);
    await createRecord("pairs", { a: "xyz", b: "zz" }, null);
    await createRecord("pairs", { a: "abc", b: "%" }, null);
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/pairs?filter=${encodeURIComponent("a ~ b")}`));
    const body = await res.json() as { data: Array<{ a: string }> };
    expect(body.data.map((r) => r.a)).toEqual(["hello"]);
  });
});
