/**
 * Sign-up, invitations and guest upgrades write an auth collection's table
 * directly. They stored body values as sent: a `json` field (an object or a
 * list) failed to bind and answered 500, an `encrypted` field was stored in
 * the clear, a `password` field unhashed, and an `autodate` field took the
 * client's value. What a `beforeCreate` hook returned wasn't validated.
 * They now store values as a record write does.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin, hooks as hooksTable } from "../db/schema.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { createCollection, getCollection, relaxAuthFieldColumns, strictAuthFieldColumns, updateCollection, _resetCollectionCache } from "../core/collections.ts";
import { findUserByEmail } from "../core/users-table.ts";
import { createRecord, getRecord } from "../core/records.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { setSetting } from "../api/settings.ts";
import { startSmtpSink, type SmtpSink } from "./_smtp.ts";
import { onSqlite } from "./_helpers.ts";
import { Database } from "bun:sqlite";
import { runDoctor } from "../scripts/doctor.ts";

const SECRET = "test-secret-auth-field-encoding";
const ENC_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
let tmpDir: string;
let smtp: SmtpSink;

const FIELDS = [
  { name: "prefs", type: "json" },
  { name: "tags", type: "select", options: { values: ["a", "b"], multiple: true } },
  { name: "secret", type: "text", options: { encrypted: true } },
  { name: "pin", type: "password" },
  { name: "joined", type: "autodate", onCreate: true },
  { name: "touched", type: "autodate", onCreate: true, onUpdate: true },
  { name: "level", type: "number", options: { max: 10 } },
];

beforeEach(async () => {
  process.env["VAULTBASE_ENCRYPTION_KEY"] = ENC_KEY;
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-auth-enc-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  await createCollection({ name: "users", type: "auth", create_rule: null, view_rule: null, fields: JSON.stringify(FIELDS) });
  _resetCollectionCache();
});

afterEach(async () => {
  smtp?.stop();
  invalidateHookCache();
  _resetCollectionCache();
  await closeDb();
  delete process.env["VAULTBASE_ENCRYPTION_KEY"];
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const post = (path: string, body: unknown, token?: string) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

async function adminToken() {
  const iat = Math.floor(Date.now() / 1000) - 60;
  return new jose.SignJWT({ id: "a1" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("admin")
    .setIssuedAt(iat).setExpirationTime(iat + 3600).setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
}

async function installHook(event: string, code: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(hooksTable).values({
    id: crypto.randomUUID(), name: `users-${event}`, collection_name: "users", event, code, enabled: 1, created_at: now, updated_at: now,
  });
  invalidateHookCache();
}

async function rawRow(email: string): Promise<Record<string, unknown>> {
  const u = await findUserByEmail((await getCollection("users"))!, email);
  return (await db.get<Record<string, unknown>>(`SELECT * FROM vb_users WHERE id = ?`, [u!.id]))!;
}

const BODY = {
  prefs: { theme: "dark", n: [1, 2] },
  tags: ["a", "b"],
  secret: "s3cret-value",
  pin: "1234",
  joined: 5,
  touched: 5,
  level: 3,
};

/** The stored row holds every value as a record write would store it. */
async function expectStored(email: string, opts: { pin: boolean }) {
  const row = await rawRow(email);
  expect(JSON.parse(String(row["prefs"]))).toEqual(BODY.prefs);
  expect(JSON.parse(String(row["tags"]))).toEqual(["a", "b"]);
  expect(String(row["secret"]).startsWith("vbenc:")).toBe(true);
  if (opts.pin) expect(await Bun.password.verify("1234", String(row["pin"]))).toBe(true);
  expect(Number(row["touched"])).toBeGreaterThan(1_000_000_000);
  const rec = await getRecord("users", String(row["id"]));
  expect(rec!["prefs"]).toEqual(BODY.prefs);
  expect(rec!["secret"]).toBe("s3cret-value");
  return row;
}

describe("sign-up stores field values as a record write does", () => {
  it("register", async () => {
    const res = await post("/auth/users/register", { email: "r@test.local", password: "a-good-password-1", ...BODY });
    expect(res.status).toBe(200);
    const row = await expectStored("r@test.local", { pin: true });
    expect(Number(row["joined"])).toBeGreaterThan(1_000_000_000);
  });

  it("register checks what a beforeCreate hook returns", async () => {
    await installHook("beforeCreate", "ctx.record.level = 99;");
    const res = await post("/auth/users/register", { email: "h@test.local", password: "a-good-password-1", level: 1 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details: Record<string, string> }).details["level"]).toContain("at most 10");
    expect(await findUserByEmail((await getCollection("users"))!, "h@test.local")).toBeNull();
  });

  it("register stores what a valid hook returns", async () => {
    await installHook("beforeCreate", "ctx.record.prefs = { from: 'hook' };");
    expect((await post("/auth/users/register", { email: "h2@test.local", password: "a-good-password-1" })).status).toBe(200);
    expect(JSON.parse(String((await rawRow("h2@test.local"))["prefs"]))).toEqual({ from: "hook" });
  });

  it("invite", async () => {
    smtp = startSmtpSink();
    const res = await post("/admin/users/users/invite", { email: "i@test.local", data: BODY }, await adminToken());
    expect(res.status).toBe(200);
    const row = await expectStored("i@test.local", { pin: true });
    expect(Number(row["joined"])).toBeGreaterThan(1_000_000_000);
  });

  it("invite validates the data", async () => {
    smtp = startSmtpSink();
    const res = await post("/admin/users/users/invite", { email: "i2@test.local", data: { level: 50 } }, await adminToken());
    expect(res.status).toBe(422);
  });

  it("invite with an email alone works when a field is required", async () => {
    smtp = startSmtpSink();
    await createCollection({ name: "members", type: "auth", create_rule: null, fields: JSON.stringify([{ name: "name", type: "text", required: true }]) });
    _resetCollectionCache();
    expect((await post("/admin/users/members/invite", { email: "m@test.local" }, await adminToken())).status).toBe(200);
  });

  it("invite may link records only admins can see", async () => {
    smtp = startSmtpSink();
    await createCollection({ name: "orgs", fields: JSON.stringify([{ name: "title", type: "text" }]), list_rule: "", view_rule: "" });
    await createCollection({ name: "staff", type: "auth", create_rule: null, fields: JSON.stringify([{ name: "org", type: "relation", collection: "orgs" }]) });
    _resetCollectionCache();
    const org = await createRecord("orgs", { title: "Private" });
    expect((await post("/admin/users/staff/invite", { email: "s@test.local", data: { org: org.id } }, await adminToken())).status).toBe(200);
    // Sign-up is still held to what a visitor can see.
    const res = await post("/auth/users/register", { email: "v@test.local", password: "a-good-password-1" });
    expect(res.status).toBe(200);
    const visitor = await post("/auth/staff/register", { email: "v2@test.local", password: "a-good-password-1", org: org.id });
    expect(visitor.status).toBe(422);
  });

  it("guest upgrade", async () => {
    setSetting("auth.anonymous.enabled", "1");
    const anon = await (await post("/auth/users/anonymous", {})).json() as { data: { token: string } };
    const res = await post("/auth/users/promote", { email: "p@test.local", password: "a-good-password-1", ...BODY }, anon.data.token);
    expect(res.status).toBe(200);
    const row = await expectStored("p@test.local", { pin: true });
    // Set when the guest was created, never the client's value.
    expect(Number(row["joined"])).toBeGreaterThan(1_000_000_000);
  });
});

describe("a field made required with an auth collection", () => {
  const REQUIRED = JSON.stringify([{ name: "name", type: "text", required: true }]);

  it("doesn't stop guest sign-up, and sign-up still needs it", async () => {
    setSetting("auth.anonymous.enabled", "1");
    await createCollection({ name: "members", type: "auth", create_rule: null, fields: REQUIRED });
    _resetCollectionCache();
    expect((await post("/auth/members/anonymous", {})).status).toBe(200);
    expect((await post("/auth/members/register", { email: "n@test.local", password: "a-good-password-1" })).status).toBe(422);
    expect((await post("/auth/members/register", { email: "n@test.local", password: "a-good-password-1", name: "N" })).status).toBe(200);
  });

  it.skipIf(onSqlite)("loses NOT NULL on Postgres at start, on own fields only", async () => {
    await createCollection({ name: "members", type: "auth", create_rule: null, fields: REQUIRED });
    await createCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text", required: true }]) });
    _resetCollectionCache();
    // As a collection made before 0.31.1 has it.
    await db.exec(`ALTER TABLE "vb_members" ALTER COLUMN "name" SET NOT NULL`);
    const nullable = async (table: string, col: string) =>
      (await db.get<{ n: string }>(`SELECT is_nullable AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`, [table, col]))!.n;
    expect(await nullable("vb_members", "name")).toBe("NO");
    expect(await relaxAuthFieldColumns("members", JSON.parse(REQUIRED))).toEqual(["name"]);
    expect(await nullable("vb_members", "name")).toBe("YES");
    // System columns and base collections keep theirs.
    expect(await nullable("vb_members", "email_verified")).toBe("NO");
    expect(await nullable("vb_notes", "title")).toBe("NO");
    expect(await relaxAuthFieldColumns("members", JSON.parse(REQUIRED))).toEqual([]);
  });

  it.skipIf(!onSqlite)("can be moved to a column that takes no value on SQLite, keeping its values", async () => {
    // A table as a collection made before 0.31.1 has it.
    await createCollection({ name: "members", type: "auth", create_rule: null, fields: JSON.stringify([]) });
    await db.exec(`ALTER TABLE vb_members ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
    await db.exec(`UPDATE vaultbase_collections SET fields = '${REQUIRED}' WHERE name = 'members'`);
    _resetCollectionCache();
    setSetting("auth.anonymous.enabled", "1");
    expect((await post("/auth/members/register", { email: "k@test.local", password: "a-good-password-1", name: "Kept" })).status).toBe(200);
    expect(await strictAuthFieldColumns("members", JSON.parse(REQUIRED))).toEqual(["name"]);
    // The server says so when it starts.
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
    try { await runMigrations(); } finally { console.warn = warn; }
    expect(warned.some((w) => w.includes("members: name can't be empty"))).toBe(true);

    // The documented steps.
    await updateCollection("members", { fields: JSON.stringify([...JSON.parse(REQUIRED), { name: "name_new", type: "text" }]) });
    await db.exec(`UPDATE vb_members SET name_new = name`);
    await updateCollection("members", { fields: JSON.stringify([{ name: "name_new", type: "text" }]) });
    await updateCollection("members", { fields: JSON.stringify([{ name: "name", type: "text", required: true, renamedFrom: "name_new" }]) });
    _resetCollectionCache();

    expect(await strictAuthFieldColumns("members", JSON.parse(REQUIRED))).toEqual([]);
    const u = await findUserByEmail((await getCollection("members"))!, "k@test.local");
    expect((await getRecord("members", u!.id))!["name"]).toBe("Kept");
    expect((await post("/auth/members/anonymous", {})).status).toBe(200);
  });

  it("doctor names NOT NULL own fields on SQLite", () => {
    const path = join(tmpDir, "old.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE vaultbase_collections (id TEXT, name TEXT, type TEXT, fields TEXT)`);
    const fields = JSON.stringify([...JSON.parse(REQUIRED), { name: "joined", type: "autodate", required: true, onCreate: true }]);
    old.exec(`INSERT INTO vaultbase_collections VALUES ('c1', 'members', 'auth', '${fields}')`);
    old.exec(`CREATE TABLE vb_members (id TEXT PRIMARY KEY, name TEXT NOT NULL, joined INTEGER NOT NULL, email TEXT, password_hash TEXT, email_verified INTEGER NOT NULL DEFAULT 0)`);
    old.close();
    const report = runDoctor(path);
    const w = report.warnings.find((x) => x.collection === "members");
    expect(w?.message).toContain("'name' can't be empty in vb_members");
    expect(w?.message).not.toContain("email_verified");
    // Sign-up sets an autodate made on create.
    expect(w?.message).not.toContain("joined");
    expect(report.ok).toBe(true);
  });
});
