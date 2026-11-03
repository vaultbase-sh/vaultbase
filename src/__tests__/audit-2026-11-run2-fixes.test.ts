/**
 * Regressions for the second November 2026 security audit pass (run-2).
 * Each block reproduces the reported path and expects the fixed behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Elysia from "elysia";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { makeRateLimitPlugin, invalidateRateLimitCache } from "../api/ratelimit.ts";
import { createCollection, updateCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { listRecordHistory } from "../core/record-history.ts";
import { encryptValue } from "../core/encryption.ts";
import { evaluateRule } from "../core/rules.ts";
import { lockoutIp, rememberPeer, signAuthToken } from "../core/sec.ts";
import { maintenanceRefusal } from "../core/maintenance-mode.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const SECRET = "test-secret-audit-run2";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

const records = () => makeRecordsPlugin(SECRET);
const get = (path: string) => records().handle(new Request(`http://localhost${path}`));

describe("client filter vs list rule", () => {
  it("gives the same answer whether or not a hidden row matches", async () => {
    await createCollection({
      name: "notes", type: "base",
      fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "secret", type: "text" }, { name: "title", type: "text" }]),
      list_rule: "owner = @request.auth.id", view_rule: "owner = @request.auth.id",
    });
    await createRecord("notes", { owner: "victim-1", secret: "s3cret-value", title: "plain text" }, null);
    const probe = (guess: string) => get(`/notes?filter=${encodeURIComponent(`secret ~ "${guess}" && title.x = 1`)}`);
    const hit = await probe("s3c");
    const miss = await probe("zzz");
    expect(hit.status).toBe(miss.status);
    expect(await hit.json()).toEqual(await miss.json());
  });
});

describe("record history decryption", () => {
  const ENC_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
  beforeEach(() => { process.env["VAULTBASE_ENCRYPTION_KEY"] = ENC_KEY; });
  afterEach(() => { delete process.env["VAULTBASE_ENCRYPTION_KEY"]; });

  it("decrypts only fields the schema marks encrypted", async () => {
    const c = await createCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "secret", type: "text", options: { encrypted: true } }]) });
    await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    const foreign = await encryptValue("another-slot-secret");
    const r = await createRecord("notes", { title: foreign, secret: "mine" }, null);
    const hist = await listRecordHistory("notes", r.id as string);
    const snap = hist.data[0]!.snapshot as Record<string, unknown>;
    expect(snap["title"]).toBe(foreign);
    expect(snap["secret"]).toBe("mine");
  });
});

describe("password sign-in dated by its credential check", () => {
  it("ends a token whose check came before a reset in the same second", async () => {
    const checkedAt = Math.floor(Date.now() / 1000);
    const { token } = await signAuthToken({ payload: { id: "a1", email: "a@x.io" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET, issuedAt: checkedAt - 1 });
    expect(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).iat).toBe(checkedAt - 1);
  });
});

describe("rules: in-process engine agrees with SQL", () => {
  it("compares a whole JSON value as its stored text", () => {
    const rec = { data: { a: 1 }, tags: ["x"] };
    expect(evaluateRule(`data = '{"a":1}'`, null, rec)).toBe(true);
    expect(evaluateRule(`data = "[object Object]"`, null, rec)).toBe(false);
    expect(evaluateRule(`tags = "x"`, null, rec)).toBe(false);
    expect(evaluateRule(`tags ~ "x"`, null, rec)).toBe(true);
  });

  it("matches % patterns in linear time", () => {
    const long = "a".repeat(200_000);
    const t0 = performance.now();
    expect(evaluateRule(`title ~ "%a%b%"`, null, { title: long })).toBe(false);
    expect(evaluateRule(`title ~ "%a_a%"`, null, { title: long })).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it.skipIf(!onSqlite)("folds case as SQLite does (ASCII only)", () => {
    expect(evaluateRule(`title:lower != "privé"`, null, { title: "PRIVÉ" })).toBe(true);
    expect(evaluateRule(`title ~ "PRIV"`, null, { title: "privé" })).toBe(true);
  });

  it.skipIf(onSqlite)("folds case as Postgres does (every letter)", () => {
    expect(evaluateRule(`title !~ "privé"`, null, { title: "PRIVÉ notes" })).toBe(false);
  });
});

describe("create rule sees dates as stored", () => {
  it("refuses an ISO date the rule would refuse as a number", async () => {
    await createPublicCollection({ name: "events", fields: JSON.stringify([{ name: "starts_at", type: "date" }]) });
    await updateCollection("events", { create_rule: "starts_at > @now" } as Parameters<typeof updateCollection>[1]);
    const post = (v: unknown) => records().handle(new Request("http://localhost/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ starts_at: v }) }));
    expect((await post("2001-01-01T00:00:00Z")).status).toBe(403);
    expect((await post(978307200)).status).toBe(403);
    expect((await post(new Date(Date.now() + 86_400_000).toISOString())).status).toBe(200);
  });
});

describe("batch", () => {
  const batch = (requests: unknown[]) => makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }),
  }));

  it("reads a singleton under its view rule", async () => {
    await createCollection({ name: "config", type: "singleton", fields: JSON.stringify([{ name: "v", type: "text" }]), list_rule: null, view_rule: "" } as never);
    expect((await batch([{ method: "GET", url: "/api/v1/config" }])).status).toBe(403);
    expect((await get("/config/_aggregate?agg=count()")).status).toBe(403);
  });

  it("refuses an oversized batch without charging its ops", async () => {
    invalidateRateLimitCache();
    try {
      const app = new Elysia({ prefix: "/api/v1" }).use(makeRateLimitPlugin(SECRET)).use(makeBatchPlugin(SECRET));
      const ops = Array.from({ length: 5000 }, () => ({ method: "POST", url: "/api/v1/posts" }));
      const t0 = performance.now();
      const res = await app.handle(new Request("http://localhost/api/v1/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests: ops }) }));
      expect(res.status).toBe(422);
      expect(performance.now() - t0).toBeLessThan(1000);
    } finally {
      invalidateRateLimitCache();
    }
  });
});

describe("sign-in lockout address", () => {
  it("counts by account only behind a loopback proxy with no trusted proxies", () => {
    const local = new Request("http://localhost/x");
    rememberPeer(local, "127.0.0.1");
    expect(lockoutIp(local)).toBeNull();
    const remote = new Request("http://localhost/x");
    rememberPeer(remote, "203.0.113.9");
    expect(lockoutIp(remote)).toBe("203.0.113.9");
  });
});

describe("maintenance mode", () => {
  it("lets through only API tokens that act as admin for the request", async () => {
    for (const [k, v] of Object.entries({ enabled: "1", level: "full" })) await setSetting(`maintenance_mode.${k}`, v);
    const { mintApiToken } = await import("../core/api-tokens.ts");
    const req = (method: string, token: string) => new Request("http://localhost/api/v1/notes", { method, headers: { authorization: `Bearer ${token}` } });
    const mint = async (scopes: string[]) => (await mintApiToken({ name: `t-${scopes.join("-")}`, scopes, createdBy: await adminId(), createdByEmail: "root@test.local", ttlSeconds: 3600 }, SECRET)).token;
    expect(await maintenanceRefusal(req("POST", await mint(["write"])), SECRET)).not.toBeNull();
    expect(await maintenanceRefusal(req("POST", await mint(["admin"])), SECRET)).toBeNull();
    expect(await maintenanceRefusal(req("GET", await mint(["read"])), SECRET)).toBeNull();
  });
});

async function adminId(): Promise<string> {
  const { getDb } = await import("../db/client.ts");
  const { admin } = await import("../db/schema.ts");
  const rows = await getDb().select().from(admin).limit(1);
  if (rows[0]) return rows[0].id;
  const id = crypto.randomUUID();
  await getDb().insert(admin).values({ id, email: "root@test.local", password_hash: "x", password_reset_at: 0, created_at: Math.floor(Date.now() / 1000) });
  return id;
}

describe.skipIf(onSqlite)("Postgres clock literals", () => {
  it("count fresh for 'NOW' too", async () => {
    const RULE = `strftime("%Y-%m-%d %H:%M:%S", "NOW") < until`;
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    await createPublicCollection({ name: "promo", list_rule: RULE, fields: JSON.stringify([{ name: "until", type: "text" }]) });
    await createRecord("promo", { until: fmt(Date.now() + 1500) });
    await createRecord("promo", { until: "9999-12-31 00:00:00" });
    const { listRecords } = await import("../core/records.ts");
    const who = { id: "u1", type: "user", collection: "users" } as never;
    expect((await listRecords("promo", { accessRule: RULE, auth: who })).totalItems).toBe(2);
    await Bun.sleep(2500);
    expect((await listRecords("promo", { accessRule: RULE, auth: who })).totalItems).toBe(1);
  }, 15000);
});

