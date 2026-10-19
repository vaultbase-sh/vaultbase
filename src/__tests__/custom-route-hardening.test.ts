/**
 * Custom routes answered from `onRequest`, ahead of the rest of the
 * pipeline: no rate limit, no security headers, no CORS, and a thrown error
 * echoed its message to the caller. They now get all three, a generic 500,
 * and an optional per-route sign-in requirement (off for existing routes).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { invalidateRoutesCache } from "../core/routes.ts";
import { routes } from "../db/schema.ts";
import { tryDispatchCustom } from "../api/routes.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateRateLimitCache } from "../api/ratelimit.ts";
import { rememberPeer } from "../core/sec.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-custom-route";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vb-croute-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  invalidateRoutesCache();
  invalidateRateLimitCache();
});

afterEach(async () => {
  await closeDb();
  invalidateRateLimitCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function route(path: string, code: string, requireAuth = 0) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(routes).values({ id: crypto.randomUUID(), name: "", method: "GET", path, code, enabled: 1, require_auth: requireAuth, created_at: now, updated_at: now });
  invalidateRoutesCache();
}

function get(path: string, headers: Record<string, string> = {}, peer = "203.0.113.9"): Promise<Response | undefined> {
  const r = new Request(`http://localhost/api/v1/custom${path}`, { headers });
  rememberPeer(r, peer);
  return tryDispatchCustom(r, SECRET);
}

describe("custom route hardening", () => {
  it("responses carry the security headers (legitimate path)", async () => {
    await route("/hello", `return { ok: true };`);
    const res = (await get("/hello"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("are rate limited", async () => {
    await route("/hello", `return { ok: true };`);
    setSetting("rate_limit.enabled", "1");
    setSetting("rate_limit.rules", JSON.stringify([{ label: "/api/*", max: 2, windowMs: 60000, audience: "all" }]));
    invalidateRateLimitCache();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await get("/hello"))!.status);
    expect(statuses).toContain(429);
  });

  it("a thrown error doesn't reach the caller", async () => {
    await route("/boom", `throw new Error("SELECT secret FROM vb_internal failed at /srv/app");`);
    const res = (await get("/boom"))!;
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("vb_internal");
  });

  it("require_auth refuses anonymous callers and serves signed-in ones", async () => {
    await route("/mine", `return { me: ctx.auth?.id ?? null };`, 1);
    expect((await get("/mine"))!.status).toBe(401);
    const id = await seedAuthUser({ collection: "users", email: "u@test.local" });
    const ok = (await get("/mine", { authorization: `Bearer ${await signUserJwt(id, "u@test.local", "users", SECRET)}` }))!;
    expect(ok.status).toBe(200);
  });

  it("require_auth doesn't accept a self-issued guest session (review 17 F-7)", async () => {
    await route("/mine", `return { ok: true };`, 1);
    const jose = await import("jose");
    const id = await seedAuthUser({ collection: "users", email: "g@test.local", isAnonymous: true });
    const now = Math.floor(Date.now() / 1000);
    const guest = await new jose.SignJWT({ id, email: "", collection: "users", anonymous: true })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("user")
      .setIssuedAt(now).setExpirationTime("1h").setJti(crypto.randomUUID())
      .sign(new TextEncoder().encode(SECRET));
    // Own peer address, so rate-limit buckets from other tests can't interfere.
    expect((await get("/mine", { authorization: `Bearer ${guest}` }, "198.51.100.77"))!.status).toBe(401);
  });

  it("a returned Response is answered as is, with the security headers added", async () => {
    await route("/sitemap.xml", `return new Response("<urlset/>", { status: 200, headers: { "Content-Type": "application/xml" } });`);
    const res = (await get("/sitemap.xml"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("<urlset/>");
  });

  it("a rate-limit rule written with /api/v1/ matches", async () => {
    setSetting("rate_limit.enabled", "1");
    setSetting("rate_limit.rules", JSON.stringify([{ label: "/api/v1/custom/limited", max: 1, windowMs: 60000, audience: "all" }]));
    invalidateRateLimitCache();
    await route("/limited", `return { ok: true };`);
    expect((await get("/limited"))!.status).toBe(200);
    expect((await get("/limited"))!.status).toBe(429);
  });
});
