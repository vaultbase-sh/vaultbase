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
  await initDb(":memory:");
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

describe("~ with an empty or missing right side", () => {
  it("an empty or absent request value matches nothing", async () => {
    expect(await list("")).toEqual([]);
    const res = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/docs"));
    const body = await res.json() as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("!~ with an empty value is the negation: every row", async () => {
    const { createPublicCollection } = await import("./_helpers.ts");
    await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "t", type: "text" }]) });
    await createRecord("notes", { t: "x" }, null);
    await createRecord("notes", { t: null }, null);
    const q = async (f: string) => {
      const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/notes?filter=${encodeURIComponent(f)}`));
      return ((await res.json()) as { data: unknown[] }).data.length;
    };
    expect(await q('t ~ ""')).toBe(0);
    expect(await q('t !~ ""')).toBe(2);
    expect(await q('t ~ "x"')).toBe(1);
    expect(await q('t !~ "x"')).toBe(1);
  });

  it("an empty field on the right matches nothing", async () => {
    const { createPublicCollection } = await import("./_helpers.ts");
    await createPublicCollection({ name: "pairs2", fields: JSON.stringify([{ name: "a", type: "text" }, { name: "b", type: "text" }]) });
    await createRecord("pairs2", { a: "hello", b: "" }, null);
    await createRecord("pairs2", { a: "hello", b: null }, null);
    await createRecord("pairs2", { a: "hello", b: "ell" }, null);
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/pairs2?filter=${encodeURIComponent("a ~ b")}`));
    expect(((await res.json()) as { data: unknown[] }).data.length).toBe(1);
  });

  it("the rule engine agrees: empty or missing needle never matches", async () => {
    const { evaluateRule } = await import("../core/rules.ts");
    expect(evaluateRule('tag ~ @request.headers.x_tag', null, { tag: "alpha" }, { headers: {} } as never)).toBe(false);
    expect(evaluateRule('tag ~ @request.headers.x_tag', null, { tag: "alpha" }, { headers: { x_tag: "" } } as never)).toBe(false);
    expect(evaluateRule('tag !~ @request.headers.x_tag', null, { tag: "alpha" }, { headers: {} } as never)).toBe(true);
    expect(evaluateRule('tag ~ @request.headers.x_tag', null, { tag: "alpha" }, { headers: { x_tag: "lph" } } as never)).toBe(true);
  });
});

describe("~ with a _via_ back-relation on the right", () => {
  it("does not become a match-everything pattern", async () => {
    const { createPublicCollection } = await import("./_helpers.ts");
    const posts = await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createPublicCollection({
      name: "comments",
      fields: JSON.stringify([{ name: "post", type: "relation", collection: posts.id }, { name: "body", type: "text" }]),
    });
    const lonely = await createRecord("posts", { title: "no comments here" }, null);
    const quoted = await createRecord("posts", { title: 'says ["hi"]' }, null);
    await createRecord("comments", { post: quoted.id, body: "hi" }, null);
    expect(lonely.id).toBeTruthy();
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/posts?filter=${encodeURIComponent("title ~ comments_via_post.body")}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ title: string }> };
    expect(body.data.map((r) => r.title)).toEqual(['says ["hi"]']);
  });
});
