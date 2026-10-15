/**
 * - The HTML sanitizer trimmed only whitespace before its scheme check, but
 *   the URL parser drops every leading C0 control too: `\x01javascript:`
 *   got through and ran.
 * - With `metrics.enabled` and no `metrics.token`, /metrics answered anyone.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { sanitizeHtml } from "../core/html-sanitize.ts";
import { makeMetricsPlugin } from "../api/metrics.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-lows";

describe("sanitizeHtml", () => {
  it("drops javascript: hidden behind leading C0 controls", () => {
    for (const ctl of ["\u0001", "\u0000", "\u001f", "\u0008 "]) {
      expect(sanitizeHtml(`<a href="${ctl}javascript:alert(1)">x</a>`)).not.toContain("javascript");
    }
    expect(sanitizeHtml(`<a href="https://example.com">x</a>`)).toContain("https://example.com");
  });
});

describe("/metrics", () => {
  beforeEach(async () => { await initDb(":memory:"); await runMigrations(); setSetting("metrics.enabled", "1"); });
  afterEach(() => closeDb());
  const get = (bearer?: string) => makeMetricsPlugin(SECRET).handle(new Request("http://localhost/metrics", { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));

  it("isn't public when no scrape token is set", async () => {
    expect((await get()).status).toBe(401);
  });

  it("answers an admin, or the scrape token when set (legitimate paths)", async () => {
    await getDb().insert(admin).values({ id: "a1", email: "a@x", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const { token } = await signAuthToken({ payload: { id: "a1", email: "a@x" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET });
    expect((await get(token)).status).toBe(200);
    setSetting("metrics.token", "scrape-secret");
    expect((await get("scrape-secret")).status).toBe(200);
    expect((await get()).status).toBe(401);
  });
});
