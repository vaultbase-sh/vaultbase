/**
 * Regressions for the fourth November 2026 security audit pass (run-4):
 * the in-process rule engine (get-by-id, update, delete, realtime) decides
 * as the list query's SQL does, or denies where it can't be sure.
 *
 * - Case folding follows the Postgres database's locale: ASCII only under a
 *   C ctype, per code point under libc (Σ folds to σ, never ς).
 * - A nested JSON object compared as text is jsonb's text on Postgres
 *   (`{"a": 1, "bb": 2}`), not JSON.stringify's.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { PostgresDriver } from "../db/postgres.ts";
import { _resetCollectionCache, createCollection, getCollection, updateCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import * as rules from "../core/rules.ts";
import { onSqlite } from "./_helpers.ts";

const SECRET = "test-secret-audit-run4-rules";
const TEST_DB = process.env["VAULTBASE_TEST_DB"] ?? "";

const rec = (path: string) => makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`));
/** Absent before the fix: then the first rule reads the locale itself. */
const prime = async () => { await (rules as { primeRuleCaseFolding?: () => Promise<void> }).primeRuleCaseFolding?.(); };

const RECORDS: Record<string, Record<string, unknown>> = {
  greek: { body: "ΟΔΟΣ report" },
  umlaut: { body: "GEHEIMNISÖ report" },
  ascii: { body: "CONFIDENTIAL plan" },
  secret: { body: "x", info: { m: { secret: true } } },
  keys: { body: "x", info: { m: { bb: "x", a: "y" } } },
  number: { body: "x", info: { m: { n: 1.5 } } },
  list: { body: "x", info: { m: "plain" }, items: [{ a: "b" }] },
};

async function seed(): Promise<Record<string, string>> {
  await createCollection({
    name: "notes",
    fields: JSON.stringify([{ name: "body", type: "text" }, { name: "info", type: "json" }, { name: "items", type: "json" }]),
    list_rule: null, view_rule: null,
  });
  const ids: Record<string, string> = {};
  for (const [name, data] of Object.entries(RECORDS)) ids[name] = (await createRecord("notes", data)).id as string;
  return ids;
}

/** The records the list returns under `rule`, and those get-by-id serves. */
async function decisions(ids: Record<string, string>, rule: string): Promise<{ listed: string[]; got: string[] }> {
  const col = (await getCollection("notes"))!;
  await updateCollection(col.id, { list_rule: rule, view_rule: rule });
  const list = await rec("/notes?perPage=50");
  expect(list.status).toBe(200);
  const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  const listed = ((await list.json()) as { data: Array<{ id: string }> }).data.map((r) => byId[r.id]!).sort();
  const got: string[] = [];
  for (const [name, id] of Object.entries(ids)) {
    const res = await rec(`/notes/${id}`);
    if (res.status === 200) got.push(name);
    else expect([403, 404]).toContain(res.status);
  }
  return { listed, got: got.sort() };
}

describe("rule parity on the test database", () => {
  let ids: Record<string, string>;
  beforeAll(async () => {
    await initDb(":memory:");
    await runMigrations();
    await prime();
    ids = await seed();
  });
  afterAll(async () => {
    _resetCollectionCache();
    await closeDb();
  });

  // Rules both engines must decide the same way, on either database.
  const exact = [
    // Postgres folds Σ to σ; JS's toLowerCase gave ς at the end of a word.
    'body !~ "οδος"',
    'body ~ "οδος"',
    'body !~ "οδοσ"',
    'body ~ "ΟΔΟΣ"',
    'body:lower = "οδοσ report"',
    'body:lower != "οδος report"',
    'body !~ "confidential"',
    // jsonb's text of a nested object: ", " / ": " and keys shortest first.
    `info.m !~ '"secret":true'`,
    `info.m ~ '"secret":true'`,
    `info.m ~ '"secret": true'`,
    `info.m ~ '{"a": "y", "bb": "x"}'`,
    `info.m ~ '{"bb":"x","a":"y"}'`,
  ];
  for (const rule of exact) {
    it(`list and get-by-id agree: ${rule}`, async () => {
      const { listed, got } = await decisions(ids, rule);
      // A number inside the object makes its jsonb text unsure (see below).
      const sure = (names: string[]) => (onSqlite ? names : names.filter((n) => n !== "number"));
      expect(sure(got)).toEqual(sure(listed));
    });
  }

  // Rules where the engine may deny what the list shows, never the reverse.
  const failClosed = [
    // A nested object compared with a value: typed on Postgres, so no match.
    `info.m != "x"`,
    `info.m = '{"secret": true}'`,
    // An element of a list that is an object: the same.
    'items ?!= "x"',
    // A number inside JSON: jsonb keeps it as written ("1.50"); JS lost that.
    `info.m !~ "1.5"`,
    `info.m ~ "1.5"`,
  ];
  for (const rule of failClosed) {
    it(`get-by-id never allows what the list refuses: ${rule}`, async () => {
      const { listed, got } = await decisions(ids, rule);
      for (const name of got) expect(listed).toContain(name);
    });
  }

  it.skipIf(onSqlite)("denies a nested object compared with a value, as the typed SQL does", () => {
    const record = { info: { m: { secret: true } }, items: [{ a: "b" }] };
    expect(rules.evaluateRule(`info.m != "x"`, null, record)).toBe(false);
    expect(rules.evaluateRule(`items ?!= "x"`, null, record)).toBe(false);
    expect(rules.evaluateRule(`info.m !~ '"secret":true'`, null, record)).toBe(true);
  });
});

/**
 * A database created with LOCALE 'C': Postgres folds ASCII letters only, so
 * `GEHEIMNISÖ` doesn't contain "geheimnisö". Opening it after the test
 * database also checks that the locale read for one database isn't reused
 * for the next.
 */
describe.skipIf(onSqlite)("rule parity on a C-locale Postgres database", () => {
  const name = `vb_run4_c_${process.pid}`;
  let ids: Record<string, string>;
  let url: string;

  beforeAll(async () => {
    const admin = new PostgresDriver(TEST_DB, { max: 1 });
    try {
      await admin.exec(`DROP DATABASE IF EXISTS ${name}`);
      await admin.exec(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C'`);
    } finally { admin.close(); }
    const u = new URL(TEST_DB);
    u.pathname = `/${name}`;
    url = u.toString();
    // The test database first, so its locale is the one cached.
    await initDb(":memory:");
    await prime();
    expect(rules.evaluateRule('body ~ "geheimnisö"', null, { body: "GEHEIMNISÖ" })).toBe(true);
    await closeDb();
    await initDb(url);
    await runMigrations();
    await prime();
    ids = await seed();
  });

  afterAll(async () => {
    _resetCollectionCache();
    await closeDb();
    const admin = new PostgresDriver(TEST_DB, { max: 1 });
    try { await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { admin.close(); }
  });

  for (const rule of ['body !~ "geheimnisö"', 'body ~ "geheimnisö"', 'body:lower = "geheimnisÖ report"', 'body !~ "confidential"', 'body !~ "οδος"']) {
    it(`list and get-by-id agree: ${rule}`, async () => {
      const { listed, got } = await decisions(ids, rule);
      expect(got).toEqual(listed);
    });
  }
});

describe.skipIf(onSqlite)("before the locale has been read", () => {
  beforeAll(async () => { await initDb(":memory:"); });
  afterAll(async () => { await closeDb(); });

  it("denies a fold it can't be sure of, then decides once the locale is read", async () => {
    rules._resetRuleCaseFolding();
    // Either answer could be wrong for this database, so both deny.
    expect(rules.evaluateRule('body ~ "geheimnisö"', null, { body: "GEHEIMNISÖ" })).toBe(false);
    expect(rules.evaluateRule('body !~ "geheimnisö"', null, { body: "GEHEIMNISÖ" })).toBe(false);
    // ASCII folds the same way under every locale.
    expect(rules.evaluateRule('body ~ "confidential"', null, { body: "CONFIDENTIAL" })).toBe(true);
    await rules.primeRuleCaseFolding();
    expect(rules.evaluateRule('body ~ "geheimnisö"', null, { body: "GEHEIMNISÖ" })).toBe(true);
  });
});
