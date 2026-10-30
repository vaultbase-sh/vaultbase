/**
 * Filters over group items: `items.qty ?> 2` (some item), `items.qty:each > 0`
 * (every item), `items:any(sku = "A" && qty > 2)` (one item meeting every
 * condition) and `items:length`. Every case runs through the list query
 * (SQL, on whichever database the suite uses) and through the rule engine
 * that single-record reads and realtime use, and the two must agree.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords, type RecordWithMeta } from "../core/records.ts";
import { evaluateRule, type AuthContext } from "../core/rules.ts";
import { ruleSyntaxError } from "../core/expression.ts";
import { parseFilter } from "../core/filter.ts";

const AUTH: AuthContext = { id: "u1", type: "user", email: "u1@test.local" };
const ids: Record<string, string> = {};
let all: RecordWithMeta[] = [];

beforeAll(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  await createCollection({
    name: "orders",
    list_rule: null,
    view_rule: null,
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "meta", type: "json" },
      { name: "list", type: "json" },
      { name: "secret", type: "password" },
      {
        name: "items", type: "group", options: { fields: [
          { name: "sku", type: "text" },
          { name: "qty", type: "number" },
          { name: "gift", type: "bool" },
          { name: "note", type: "text" },
          { name: "owner", type: "text" },
          { name: "tags", type: "select", options: { values: ["a", "b"], multiple: true } },
        ] },
      },
      { name: "address", type: "group", options: { multiple: false, fields: [{ name: "city", type: "text" }] } },
    ]),
  });
  _resetCollectionCache();
  const make = async (key: string, data: Record<string, unknown>) => { ids[key] = (await createRecord("orders", { title: key, ...data })).id; };
  await make("o1", {
    items: [{ sku: "A", qty: 1, gift: true, tags: ["a"] }, { sku: "B", qty: 5 }],
    address: { city: "Oslo" },
    meta: { tags: ["x", "y"], lines: [{ n: 1 }] },
    list: [{ n: 1 }],
  });
  await make("o2", { items: [{ sku: "A", qty: 3 }], address: { city: "Bergen" }, list: [5, "abc", null, [1], { n: 2 }] });
  await make("o3", { items: [] });
  await make("o4", {});
  await make("o5", { items: [{ sku: "C", qty: 2, note: "Wrap it", owner: "u1" }] });
  await make("o6", { title: "[draft] not json", items: [{ sku: "D", qty: 0, gift: false }] });
  all = (await listRecords("orders", { perPage: 100 })).data;
});
afterAll(async () => { _resetCollectionCache(); await closeDb(); });

const nameOf = (id: string) => Object.keys(ids).find((k) => ids[k] === id)!;

async function viaSql(filter: string): Promise<string[]> {
  const r = await listRecords("orders", { filter, auth: AUTH, perPage: 100 });
  return r.data.map((x) => nameOf(x.id)).sort();
}

function viaRules(filter: string): string[] {
  return all.filter((r) => evaluateRule(filter, AUTH, r as unknown as Record<string, unknown>)).map((r) => nameOf(r.id)).sort();
}

const CASES: Array<[string, string[]]> = [
  // some item
  [`items.qty ?> 2`, ["o1", "o2"]],
  [`items.sku ?= "A"`, ["o1", "o2"]],
  [`items.qty ?!= 1`, ["o1", "o2", "o5", "o6"]],
  [`items.gift ?= true`, ["o1"]],
  [`items.gift ?= false`, ["o6"]],
  [`items.note ?~ "wrap"`, ["o5"]],
  [`items.owner ?= @request.auth.id`, ["o5"]],
  // two conditions may hold for different items...
  [`items.sku ?= "A" && items.qty ?> 2`, ["o1", "o2"]],
  // ...unless :any asks for one item meeting both
  [`items:any(sku = "A" && qty > 2)`, ["o2"]],
  [`items:any(sku = "A" || qty = 2)`, ["o1", "o2", "o5"]],
  [`items:any(owner = @request.auth.id && note ~ "WRAP")`, ["o5"]],
  [`items:any(tags ?= "a")`, ["o1"]],
  [`items:any(tags:length = 1)`, ["o1"]],
  [`items:any(note = null)`, ["o1", "o2", "o6"]],
  [`items:any(gift = true) || title = "o3"`, ["o1", "o3"]],
  [`(items:any(qty >= 3)) && address.city = "Bergen"`, ["o2"]],
  // every item (and at least one)
  [`items.qty:each >= 1`, ["o1", "o2", "o5"]],
  [`items.qty:each > 1`, ["o2", "o5"]],
  [`items.note:each ~ "wrap"`, ["o5"]],
  // an item without the value fails "every"
  [`items.gift:each = true`, []],
  [`items.gift:each != true`, ["o6"]],
  // count
  [`items:length > 1`, ["o1"]],
  [`items:length = 0`, ["o3"]],
  // a single-object group is a JSON object
  [`address.city = "Oslo"`, ["o1"]],
  [`address:any(city = "Oslo")`, []],
  // JSON fields keep their meaning, and :any works on a JSON list of objects
  [`meta.tags ?= "x"`, ["o1"]],
  [`meta.lines:any(n = 1)`, ["o1"]],
  // only objects are items: a number, a string, null or a list in the list isn't one
  [`list:any(n = null)`, []],
  [`list:any(n != 1)`, ["o2"]],
  [`list.n ?= null`, []],
  [`list.n ?!~ "2"`, ["o1"]],
  [`list.n:each = 2`, []],
  [`list.n:each = 1`, ["o1"]],
  [`list.n:each !~ "1"`, []],
  // a path reads items only when the list is the field itself
  [`meta.lines.n ?= 1`, []],
  // a value that isn't a list has no items, without failing the query
  [`title:any(x = 1)`, []],
];

describe("filters over group items", () => {
  for (const [filter, expected] of CASES) {
    it(`${filter}`, async () => {
      expect(await viaSql(filter)).toEqual(expected);
      expect(viaRules(filter)).toEqual(expected);
    });
  }
});

describe(":any syntax", () => {
  it("parses, and says what's wrong when it can't", () => {
    expect(ruleSyntaxError(`items:any(sku = "A")`)).toBeNull();
    expect(ruleSyntaxError(`items:any(a:any(b = 1))`)).toContain("can't be used inside :any");
    expect(ruleSyntaxError(`items:any(@collection.users.id = owner)`)).toContain("@collection can't be used inside :any");
    expect(ruleSyntaxError(`items:any(posts_via_author.id = 1)`)).toContain("_via_ can't be used inside :any");
    expect(ruleSyntaxError(`posts_via_author:any(id = 1)`)).toContain("needs a field of this collection");
    expect(ruleSyntaxError(`items:any()`)).not.toBeNull();
    expect(ruleSyntaxError(`items:any(sku = "A"`)).not.toBeNull();
  });

  it("checks the list field like any other field", async () => {
    await expect(listRecords("orders", { filter: `nope:any(a = 1)`, auth: AUTH })).rejects.toThrow();
    await expect(listRecords("orders", { filter: `secret:any(a = 1)`, auth: AUTH })).rejects.toThrow();
  });

  it("binds values in order", () => {
    const r = parseFilter(`title = "t" && items:any(sku = "A" && qty > 2) && items.qty ?< 9`, "vb_orders")!;
    expect(r.params).toEqual(["t", "A", 2, 9, 9]);
  });

  it("works in an access rule", async () => {
    await createCollection({
      name: "shared",
      list_rule: `items:any(owner = @request.auth.id)`,
      view_rule: `items:any(owner = @request.auth.id)`,
      fields: JSON.stringify([{ name: "items", type: "group", options: { fields: [{ name: "owner", type: "text" }] } }]),
    });
    _resetCollectionCache();
    const mine = await createRecord("shared", { items: [{ owner: "x" }, { owner: "u1" }] });
    await createRecord("shared", { items: [{ owner: "x" }] });
    const r = await listRecords("shared", { accessRule: `items:any(owner = @request.auth.id)`, auth: AUTH });
    expect(r.data.map((x) => x.id)).toEqual([mine.id]);
  });
});

describe("item values compare as the SQL does", () => {
  const mids: Record<string, string> = {};
  let rows: RecordWithMeta[] = [];
  const name = (id: string) => Object.keys(mids).find((k) => mids[k] === id)!;

  beforeAll(async () => {
    await createCollection({
      name: "more",
      list_rule: null,
      view_rule: null,
      fields: JSON.stringify([
        { name: "title", type: "text" },
        { name: "list", type: "json" },
        { name: "items", type: "group", options: { fields: [{ name: "sku", type: "text" }, { name: "qty", type: "number" }, { name: "due", type: "date" }] } },
        { name: "address", type: "group", options: { multiple: false, fields: [{ name: "city", type: "text" }] } },
      ]),
    });
    _resetCollectionCache();
    const make = async (key: string, data: Record<string, unknown>) => { mids[key] = (await createRecord("more", { title: key, ...data })).id; };
    await make("m1", { items: [{ sku: "10", qty: 3, due: 1_700_000_000 }], list: [{ updated_at: "z", created_at: 1 }] });
    await make("m2", { items: [{ sku: "A", qty: 1 }], list: { n: 1 }, address: { city: "Oslo" } });
    await make("m3", { items: [{ sku: "BB", qty: 2 }], list: [{ n: 1, vals: [1, "2", null] }] });
    rows = (await listRecords("more", { perPage: 100 })).data;
  });

  const sql = async (filter: string) => (await listRecords("more", { filter, auth: AUTH, perPage: 100 })).data.map((x) => name(x.id)).sort();
  const rules = (filter: string) => rows.filter((r) => evaluateRule(filter, AUTH, r as unknown as Record<string, unknown>)).map((r) => name(r.id)).sort();

  const MORE: Array<[string, string[]]> = [
    // :length of text inside an item (SQLite failed on "A", gave 0 for "10")
    [`items:any(sku:length = 2)`, ["m1", "m3"]],
    [`items:any(sku:length = 1)`, ["m2"]],
    [`title:length = 2`, ["m1", "m2", "m3"]],
    // an item's keys are its own: no created/updated twins
    [`list:any(updated = "z")`, []],
    [`list:any(updated_at = "z")`, ["m1"]],
    [`list:any(created = 1)`, []],
    // values of different JSON types match nothing
    [`items:any(qty = "3")`, []],
    [`items.qty ?= "3"`, []],
    [`items:any(sku = 10)`, []],
    [`items.qty:each > "0"`, []],
    [`items:any(sku > 9)`, []],
    [`items:any(due < "2050-01-01")`, []],
    [`items:any(qty = 3)`, ["m1"]],
    [`items:any(sku = "10")`, ["m1"]],
    [`items:any(due < @now)`, ["m1"]],
    // ?= over a value that isn't a list has nothing to match (Postgres failed on {n:1})
    [`list.n ?= 1`, ["m3"]],
    [`address.city ?= "Oslo"`, []],
    [`list ?= 1`, []],
    // a list inside an item compares by type too, and a value that doesn't compare fails "every"
    [`list:any(vals ?= 1)`, ["m3"]],
    [`list:any(vals ?= "1")`, []],
    [`list:any(vals ?= "2")`, ["m3"]],
    [`list:any(vals ?> 0)`, ["m3"]],
    [`list:any(vals ?> 5)`, []],
    [`list:any(vals:each > 0)`, []],
    [`list:any(vals:each != 5)`, []],
  ];
  for (const [filter, expected] of MORE) {
    it(`${filter}`, async () => {
      expect(await sql(filter)).toEqual(expected);
      expect(rules(filter)).toEqual(expected);
    });
  }

  it("parses :any with spaces, and not on a literal", () => {
    expect(ruleSyntaxError(`items :any(sku = "A")`)).toBeNull();
    expect(ruleSyntaxError(`items:any (sku = "A")`)).toBeNull();
    expect(ruleSyntaxError(`true:any(a = 1)`)).toContain("needs a field");
  });
});
