/**
 * Regressions for the November 2026 security audit. Each block reproduces
 * the reported path and expects the fixed behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import Elysia from "elysia";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { authTokens, files, recordHistory } from "../db/schema.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { checkBatchRateLimit, invalidateRateLimitCache, makeRateLimitPlugin } from "../api/ratelimit.ts";
import { perClientLimitIp, verifyAuthToken } from "../core/sec.ts";
import { isEmail } from "../core/email-address.ts";
import { createCollection, deleteCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { findUserById } from "../core/users-table.ts";
import { invalidateStorageCache, registerStorageDriver, setUploadDir } from "../core/storage.ts";
import { releaseIdentityRegexp } from "../scripts/update.ts";
import { createPublicCollection, ensureAuthCollection, hashedTokenId, onSqlite, seedAuthUser } from "./_helpers.ts";

const SECRET = "test-secret-audit-2026-11";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

const auth = () => makeAuthPlugin(SECRET);
const post = (path: string, body: unknown, token?: string) => auth().handle(new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));

describe("email check", () => {
  it("accepts ordinary addresses and refuses malformed ones", () => {
    for (const ok of ["a@b.co", "first.last+tag@sub.example.org", "x@y.z"]) expect(isEmail(ok)).toBe(true);
    for (const bad of ["", "a@b", "a@@b.co", "a b@c.de", "a@b..co", "a@.b.co", "a@b.co.", "@b.co", 42, null]) expect(isEmail(bad)).toBe(false);
  });

  it("refuses an oversized value without backtracking through it", () => {
    const evil = "a@" + "a".repeat(64 * 1024);
    const t0 = performance.now();
    expect(isEmail(evil)).toBe(false);
    // Also the shape alone, past the length cap: still linear.
    expect(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(evil)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("magic-link sign-in on a pre-registered address", () => {
  it("ends the squatter's password and sessions", async () => {
    setSetting("auth.otp.enabled", "1");
    const col = await ensureAuthCollection("users");
    const reg = await post("/auth/users/register", { email: "owner@test.local", password: "attacker-pass-123" });
    expect(reg.status).toBe(200);
    const uid = ((await reg.json()) as { data: { id: string } }).data.id;
    const login = await post("/auth/users/login", { email: "owner@test.local", password: "attacker-pass-123" });
    const squatterToken = ((await login.json()) as { data: { token: string } }).data.token;

    const link = "b".repeat(64);
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(authTokens).values({ id: hashedTokenId(link), user_id: uid, collection_id: col.id, purpose: "otp", code: "x", expires_at: now + 600 });
    const owner = await post("/auth/users/otp/auth", { token: link });
    expect(owner.status).toBe(200);
    const ownerToken = ((await owner.json()) as { data: { token: string } }).data.token;

    expect((await findUserById(col, uid))!.email_verified).toBe(1);
    expect(await verifyAuthToken(ownerToken, SECRET)).not.toBeNull();
    expect(await verifyAuthToken(squatterToken, SECRET)).toBeNull();
    expect((await post("/auth/users/login", { email: "owner@test.local", password: "attacker-pass-123" })).status).toBe(401);
  });

  it("leaves a verified account's password alone", async () => {
    setSetting("auth.otp.enabled", "1");
    const col = await ensureAuthCollection("users");
    const hash = await Bun.password.hash("owner-pass-12345");
    const uid = await seedAuthUser({ collection: "users", email: "v@test.local", passwordHash: hash, emailVerified: true });
    const link = "c".repeat(64);
    await getDb().insert(authTokens).values({ id: hashedTokenId(link), user_id: uid, collection_id: col.id, purpose: "otp", code: "x", expires_at: Math.floor(Date.now() / 1000) + 600 });
    expect((await post("/auth/users/otp/auth", { token: link })).status).toBe(200);
    expect((await findUserById(col, uid))!.password_hash).toBe(hash);
  });
});

describe("password reset right after a sign-in", () => {
  it("ends a token issued before it, and the next sign-in works", async () => {
    const col = await ensureAuthCollection("users");
    const id = await seedAuthUser({ collection: "users", email: "r@test.local", passwordHash: await Bun.password.hash("old-password-123"), emailVerified: true });
    const login = await post("/auth/users/login", { email: "r@test.local", password: "old-password-123" });
    const stolen = ((await login.json()) as { data: { token: string } }).data.token;
    const raw = "d".repeat(64);
    await getDb().insert(authTokens).values({ id: hashedTokenId(raw), user_id: id, collection_id: col.id, purpose: "password_reset", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    expect((await post("/auth/users/confirm-password-reset", { token: raw, password: "new-password-456" })).status).toBe(200);

    const iatMs = JSON.parse(Buffer.from(stolen.split(".")[1]!, "base64url").toString()).iat_ms as number;
    expect(iatMs).toBeLessThanOrEqual((await findUserById(col, id))!.password_reset_at);
    expect(await verifyAuthToken(stolen, SECRET)).toBeNull();

    const fresh = await post("/auth/users/login", { email: "r@test.local", password: "new-password-456" });
    expect(fresh.status).toBe(200);
    expect(await verifyAuthToken(((await fresh.json()) as { data: { token: string } }).data.token, SECRET)).not.toBeNull();
  });
});

describe("batch", () => {
  const batch = (requests: unknown[]) => makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }),
  }));

  beforeEach(async () => {
    await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  });

  it("refuses a list in a batch that writes, before writing anything", async () => {
    const res = await batch([
      { method: "POST", url: "/api/v1/posts", body: { title: "a" } },
      { method: "GET", url: "/api/v1/posts" },
    ]);
    expect(res.status).toBe(422);
    expect((await listRecords("posts", { perPage: 10 })).totalItems).toBe(0);
  });

  it("still runs lists in a batch of reads, and gets in a write batch", async () => {
    const r = await createRecord("posts", { title: "x" }, null);
    expect((await batch([{ method: "GET", url: "/api/v1/posts" }])).status).toBe(200);
    expect((await batch([
      { method: "POST", url: "/api/v1/posts", body: { title: "b" } },
      { method: "GET", url: `/api/v1/posts/${r.id}` },
    ])).status).toBe(200);
  });

  it("charges each op to its own rate-limit bucket", async () => {
    invalidateRateLimitCache();
    const req = new Request("http://localhost/api/v1/batch", { method: "POST" });
    const creates = Array.from({ length: 100 }, () => ({ method: "POST", url: "/api/v1/posts" }));
    // The default create rule is 60 per 5 s: a full batch drains it once...
    expect(await checkBatchRateLimit(req, "198.51.100.9", SECRET, creates)).toBeNull();
    // ...and the next has to wait for the refill.
    const refused = await checkBatchRateLimit(req, "198.51.100.9", SECRET, creates);
    expect(refused?.body.code).toBe(429);
    // Another client's buckets are untouched.
    expect(await checkBatchRateLimit(req, "198.51.100.10", SECRET, creates.slice(0, 10))).toBeNull();
    invalidateRateLimitCache();
  });

  it("leaves a bucket in debt for a batch larger than the rule, so batching doesn't beat the limit", async () => {
    invalidateRateLimitCache();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const req = new Request("http://localhost/api/v1/batch", { method: "POST" });
      const creates = Array.from({ length: 100 }, () => ({ method: "POST", url: "/api/v1/posts" }));
      // 60 per 5 s: 100 creates owe 40, which takes 40/60 of a window to repay
      // before the bucket can even start filling again.
      expect(await checkBatchRateLimit(req, "198.51.100.11", SECRET, creates)).toBeNull();
      now += 5000; // tokens back to 20
      expect((await checkBatchRateLimit(req, "198.51.100.11", SECRET, creates.slice(0, 30)))?.body.code).toBe(429);
      expect(await checkBatchRateLimit(req, "198.51.100.11", SECRET, creates.slice(0, 20))).toBeNull();
    } finally {
      Date.now = realNow;
      invalidateRateLimitCache();
    }
  });

  it("is charged per op by the server's rate limiter", async () => {
    invalidateRateLimitCache();
    try {
      const app = new Elysia({ prefix: "/api/v1" }).use(makeRateLimitPlugin(SECRET)).use(makeBatchPlugin(SECRET, { rateLimit: true }));
      const send = () => app.handle(new Request("http://localhost/api/v1/batch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests: Array.from({ length: 100 }, (_, i) => ({ method: "POST", url: "/api/v1/posts", body: { title: `t${i}` } })) }),
      }));
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(429);
    } finally {
      invalidateRateLimitCache();
    }
  });
});

describe("thumbnail of a file that isn't an image", () => {
  it("is served without reading the whole file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-audit-thumb-"));
    const store = new Map<string, Uint8Array>();
    let fullReads = 0;
    try {
      mkdirSync(join(dir, "uploads"), { recursive: true });
      setUploadDir(join(dir, "uploads"));
      registerStorageDriver({ name: "audit-counting", create: () => ({
        async write(k, d) { store.set(k, new Uint8Array(d as ArrayBuffer)); },
        async read(k) { const b = store.get(k); if (!b) return null; fullReads++; return b.slice().buffer; },
        async exists(k) { return store.has(k); },
        async delete(k) { store.delete(k); },
        async response(k) { const b = store.get(k); return b ? new Response(b) : null; },
      }) });
      setSetting("storage.driver", "audit-counting");
      invalidateStorageCache();
      const col = await createCollection({ name: "docs", type: "base", fields: JSON.stringify([{ name: "attachment", type: "file" }]), list_rule: null, view_rule: null });
      const rec = await createRecord("docs", {});
      const filename = "0123456789abcdef.pdf";
      const body = new Uint8Array(2 * 1024 * 1024);
      body.set(new TextEncoder().encode("%PDF-1.4"));
      store.set(filename, body);
      await getDb().insert(files).values({ id: crypto.randomUUID(), collection_id: col.id, record_id: rec["id"] as string,
        field_name: "attachment", filename, original_name: "a.pdf", mime_type: "application/pdf", size: body.length,
        created_at: Math.floor(Date.now() / 1000) });
      const app = makeFilesPlugin(join(dir, "uploads"), SECRET);
      for (let i = 0; i < 3; i++) {
        const r = await app.handle(new Request(`http://localhost/files/${filename}?thumb=16x16`));
        expect(r.status).toBe(200);
        await r.arrayBuffer();
      }
      expect(fullReads).toBe(0);
    } finally {
      setSetting("storage.driver", "local");
      invalidateStorageCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collection names", () => {
  it("refuses the API's own top-level paths", async () => {
    for (const name of ["admin", "auth", "files", "batch", "realtime"]) {
      const err = await createCollection({ name, type: "base", fields: "[]" }).then(() => null, (e: unknown) => e as { details?: Record<string, string> });
      expect(err?.details?.["name"]).toMatch(/reserved/);
    }
  });
});

describe("record history", () => {
  it("goes with its collection", async () => {
    await createCollection({ name: "notes", type: "base", fields: JSON.stringify([{ name: "t", type: "text" }]), history_enabled: 1 } as never);
    await createRecord("notes", { t: "secret" }, null);
    const rows = () => getDb().select().from(recordHistory).where(eq(recordHistory.collection, "notes"));
    expect((await rows()).length).toBeGreaterThan(0);
    await deleteCollection("notes");
    expect((await rows()).length).toBe(0);
  });
});

describe("per-client realtime cap", () => {
  it("keys IPv6 clients by their /64", () => {
    const a = perClientLimitIp(null, "2001:db8:1:2::1");
    expect(a).toBe(perClientLimitIp(null, "2001:db8:1:2:ffff:ffff:ffff:fffe"));
    expect(a).not.toBe(perClientLimitIp(null, "2001:db8:1:3::1"));
    expect(perClientLimitIp(null, "203.0.113.5")).toBe("203.0.113.5");
    expect(perClientLimitIp(null, "127.0.0.1")).toBeNull();
  });
});

describe("release signature identity", () => {
  it("accepts only the release workflow started from the version's tag", () => {
    const re = new RegExp(releaseIdentityRegexp("vaultbase-sh/vaultbase", "0.37.0"));
    const base = "https://github.com/vaultbase-sh/vaultbase/.github/workflows/";
    expect(re.test(`${base}release.yml@refs/tags/v0.37.0`)).toBe(true);
    expect(re.test(`${base}release.yml@refs/heads/main`)).toBe(false);
    expect(re.test(`${base}ci.yml@refs/heads/main`)).toBe(false);
    expect(re.test(`${base}release.yml@refs/heads/feature`)).toBe(false);
    expect(re.test(`${base}release.yml@refs/tags/v0x37x0`)).toBe(false);
  });
});

describe.skipIf(onSqlite)("Postgres", () => {
  it("binds a fractional number comparison in placeholder order", async () => {
    await createPublicCollection({ name: "items", fields: JSON.stringify([{ name: "n", type: "number" }, { name: "secret", type: "text" }]) });
    await createRecord("items", { n: 2, secret: "a" }, null);
    await createRecord("items", { n: 1, secret: "b" }, null);
    const r = await listRecords("items", { filter: "n > 1.5", perPage: 10 });
    expect(r.data.map((x) => (x as unknown as { n: number }).n)).toEqual([2]);
    expect(r.totalItems).toBe(1);
  });

  it("counts a list fresh when its rule reads the clock", async () => {
    const RULE = `strftime("%Y-%m-%d %H:%M:%S", "now") < until`;
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    await createPublicCollection({ name: "promo", list_rule: RULE, fields: JSON.stringify([{ name: "until", type: "text" }]) });
    await createRecord("promo", { until: fmt(Date.now() + 1500) });
    await createRecord("promo", { until: "9999-12-31 00:00:00" });
    const who = { id: "u1", type: "user", collection: "users" } as never;
    expect((await listRecords("promo", { accessRule: RULE, auth: who })).totalItems).toBe(2);
    await Bun.sleep(2500);
    const after = await listRecords("promo", { accessRule: RULE, auth: who });
    expect(after.data.length).toBe(1);
    expect(after.totalItems).toBe(1);
  }, 15000);
});
