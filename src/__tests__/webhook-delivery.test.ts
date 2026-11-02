/**
 * Webhook delivery goes through the same egress filter as helpers.http
 * (guardedFetch), and signs with the shared HMAC helper.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { webhooks, webhookDeliveries } from "../db/schema.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateEgressCache } from "../core/hook-egress.ts";
import { dispatchEvent, invalidateWebhookCache, _webhookTickOnce } from "../core/webhooks.ts";

let receiver: ReturnType<typeof Bun.serve>;
let seen: Array<{ headers: Headers; body: string; path: string }> = [];

beforeEach(async () => {
  seen = [];
  receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ headers: req.headers, body: await req.text(), path });
      if (path === "/moved") return new Response(null, { status: 302, headers: { location: "/hook" } });
      return new Response("ok");
    },
  });
  await initDb(":memory:");
  await runMigrations();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(webhooks).values({
    id: "wh1", name: "t", url: `http://127.0.0.1:${receiver.port}/hook`,
    events: JSON.stringify(["*"]), secret: "s3cret", enabled: 1,
    retry_max: 1, retry_backoff: "fixed", retry_delay_ms: 1000, timeout_ms: 5000,
    custom_headers: "{}", created_at: now, updated_at: now,
  });
  invalidateWebhookCache();
});

afterEach(async () => {
  receiver.stop(true);
  await closeDb();
  invalidateEgressCache();
});

const delivery = async () => (await getDb().select().from(webhookDeliveries).where(eq(webhookDeliveries.webhook_id, "wh1")))[0]!;

describe("webhook delivery", () => {
  it("is refused for a blocked address, and not retried", async () => {
    invalidateEgressCache();
    await dispatchEvent({ event: "posts.create", data: { id: "p1" } });
    await _webhookTickOnce();
    expect(seen).toHaveLength(0);
    const row = await delivery();
    expect(row.status).toBe("dead");
    expect(row.error).not.toMatch(/^helpers\.http: /);
    expect(row.error).toContain("127.0.0.1");
  });

  it("signs the timestamp and payload with the secret", async () => {
    setSetting("hooks.http.allow", "127.0.0.1/32");
    invalidateEgressCache();
    await dispatchEvent({ event: "posts.create", data: { id: "p2" } });
    await _webhookTickOnce();
    expect(seen).toHaveLength(1);
    const { headers, body } = seen[0]!;
    const ts = headers.get("x-vaultbase-timestamp")!;
    const expected = createHmac("sha256", "s3cret").update(`${ts}.${body}`).digest("hex");
    expect(headers.get("x-vaultbase-signature")).toBe(`sha256=${expected}`);
    expect((await delivery()).status).toBe("succeeded");
  });

  it("doesn't follow a redirect", async () => {
    setSetting("hooks.http.allow", "127.0.0.1/32");
    invalidateEgressCache();
    await getDb().update(webhooks).set({ url: `http://127.0.0.1:${receiver.port}/moved` }).where(eq(webhooks.id, "wh1"));
    invalidateWebhookCache();
    await dispatchEvent({ event: "posts.create", data: { id: "p3" } });
    await _webhookTickOnce();
    expect(seen.map((s) => s.path)).toEqual(["/moved"]);
    const row = await delivery();
    expect(row.status).not.toBe("succeeded");
    expect(row.error).toContain("refusing redirect");
  });
});
