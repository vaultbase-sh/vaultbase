import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { webhooks, webhookDeliveries } from "../db/schema.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateEgressCache } from "../core/hook-egress.ts";
import { dispatchEvent, _webhookTickOnce } from "../core/webhooks.ts";

// The dispatcher used to select due deliveries every tick and fire them
// without claiming, so a receiver slower than the 2 s tick got the same
// delivery again on every tick until the first attempt finished.

let receiver: ReturnType<typeof Bun.serve>;
let hits = 0;

beforeEach(async () => {
  hits = 0;
  receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      hits++;
      await Bun.sleep(400);
      return new Response("ok");
    },
  });
  initDb(":memory:");
  await runMigrations();
  setSetting("hooks.http.allow", "127.0.0.1/32");
  invalidateEgressCache();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(webhooks).values({
    id: "wh1", name: "t", url: `http://127.0.0.1:${receiver.port}/hook`,
    events: JSON.stringify(["*"]), secret: "s", enabled: 1,
    retry_max: 3, retry_backoff: "fixed", retry_delay_ms: 1000, timeout_ms: 5000,
    custom_headers: "{}", created_at: now, updated_at: now,
  });
});

afterEach(() => {
  receiver.stop(true);
  closeDb();
  invalidateEgressCache();
});

describe("webhook dispatcher claims deliveries", () => {
  it("overlapping ticks deliver a slow webhook exactly once", async () => {
    await dispatchEvent({ event: "posts.create", data: { id: "p1" } });
    // Second tick starts while the first delivery is still in flight.
    const first = _webhookTickOnce();
    await Bun.sleep(50);
    const second = _webhookTickOnce();
    await Promise.all([first, second]);
    expect(hits).toBe(1);
    const rows = await getDb().select().from(webhookDeliveries).where(eq(webhookDeliveries.webhook_id, "wh1"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("succeeded");
  });
});
