/**
 * The admin's "Fire test" reaches only the webhook it was fired on. It used to
 * add `__test.<id>` to that webhook's events and dispatch it, so every `*`
 * webhook received the test delivery too.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin, webhooks, webhookDeliveries } from "../db/schema.ts";
import { invalidateWebhookCache } from "../core/webhooks.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeWebhooksPlugin } from "../api/webhooks.ts";

const SECRET = "test-secret-webhook-test-fire";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@x", password_hash: "x", password_reset_at: 0, created_at: 0 });
  const now = Math.floor(Date.now() / 1000);
  for (const [id, events] of [["all", ["*"]], ["mine", ["posts.create"]]] as const) {
    await getDb().insert(webhooks).values({
      id, name: id, url: "https://example.test/hook", events: JSON.stringify(events), secret: "s", enabled: 1,
      retry_max: 3, retry_backoff: "fixed", retry_delay_ms: 1000, timeout_ms: 5000,
      custom_headers: "{}", created_at: now, updated_at: now,
    });
  }
  invalidateWebhookCache();
});
afterEach(async () => { await closeDb(); });

describe("webhook test fire", () => {
  it("delivers to the one webhook only, and leaves its events as they were", async () => {
    const token = (await signAuthToken({ payload: { id: "a1", email: "a@x" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
    const res = await makeWebhooksPlugin(SECRET).handle(new Request("http://localhost/admin/webhooks/mine/test", {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));
    expect(res.status).toBe(200);
    const rows = await getDb().select().from(webhookDeliveries);
    expect(rows.map((r) => r.webhook_id)).toEqual(["mine"]);
    const hooks = await getDb().select().from(webhooks);
    expect(JSON.parse(hooks.find((h) => h.id === "mine")!.events)).toEqual(["posts.create"]);
  });

  async function post(path: string) {
    const token = (await signAuthToken({ payload: { id: "a1", email: "a@x" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
    return makeWebhooksPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));
  }

  it("refuses a test on a disabled webhook instead of queueing nothing", async () => {
    await getDb().update(webhooks).set({ enabled: 0 }).where(eq(webhooks.id, "mine"));
    invalidateWebhookCache();
    const res = await post("/admin/webhooks/mine/test");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("disabled");
  });

  it("redelivers a past delivery as a new pending one with the same payload", async () => {
    await post("/admin/webhooks/mine/test");
    const [first] = await getDb().select().from(webhookDeliveries);
    await getDb().update(webhookDeliveries).set({ status: "dead" }).where(eq(webhookDeliveries.id, first!.id));
    const res = await post(`/admin/webhooks/mine/deliveries/${first!.id}/redeliver`);
    expect(res.status).toBe(200);
    const rows = await getDb().select().from(webhookDeliveries);
    expect(rows).toHaveLength(2);
    const again = rows.find((r) => r.id !== first!.id)!;
    expect(again.status).toBe("pending");
    expect(again.payload).toBe(first!.payload);
    // Another webhook's delivery id isn't reachable through this one.
    expect((await post(`/admin/webhooks/all/deliveries/${first!.id}/redeliver`)).status).toBe(404);
  });
});
