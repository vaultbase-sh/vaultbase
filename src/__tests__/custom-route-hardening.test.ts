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
  initDb(":memory:");
  await runMigrations();
  invalidateRoutesCache();
  invalidateRateLimitCache();
});

afterEach(() => {
  closeDb();
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
});
