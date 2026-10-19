/**
 * The admin's "Fire test" reaches only the webhook it was fired on. It used to
 * add `__test.<id>` to that webhook's events and dispatch it, so every `*`
 * webhook received the test delivery too.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
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
});
