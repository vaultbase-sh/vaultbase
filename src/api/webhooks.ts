/**
 * /api/v1/admin/webhooks/* — admin CRUD + delivery log + manual test fire.
 */
import Elysia, { t } from "elysia";
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { webhooks, webhookDeliveries } from "../db/schema.ts";
import { dispatchEvent, invalidateWebhookCache } from "../core/webhooks.ts";
import { adminGuard } from "./_admin.ts";

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function makeWebhooksPlugin(jwtSecret: string) {
  return new Elysia({ name: "webhooks" })
    .use(adminGuard(jwtSecret))
    .get("/admin/webhooks", async () => {
      const rows = await getDb().select().from(webhooks).orderBy(desc(webhooks.created_at));
      return { data: rows };
    }, { requireAdmin: true })

    .get("/admin/webhooks/:id", async ({ params, set }) => {
      const rows = await getDb().select().from(webhooks).where(eq(webhooks.id, params.id)).limit(1);
      if (rows.length === 0) { set.status = 404; return { error: "Webhook not found", code: 404 }; }
      return { data: rows[0] };
    }, { requireAdmin: true })

    .post("/admin/webhooks", async ({ body, set }) => {
      if (!body.url || !/^https?:\/\//i.test(body.url)) {
        set.status = 422; return { error: "url must be http(s)://", code: 422 };
      }
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await getDb().insert(webhooks).values({
        id,
        name: body.name ?? "",
        url: body.url,
        events: JSON.stringify(body.events ?? []),
        secret: body.secret ?? generateSecret(),
        enabled: body.enabled === false ? 0 : 1,
        retry_max: body.retry_max ?? 3,
        retry_backoff: body.retry_backoff ?? "exponential",
        retry_delay_ms: body.retry_delay_ms ?? 1000,
        timeout_ms: body.timeout_ms ?? 30000,
        custom_headers: JSON.stringify(body.custom_headers ?? {}),
        created_at: now, updated_at: now,
      });
      invalidateWebhookCache();
      const fresh = await getDb().select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
      return { data: fresh[0] };
    }, {
      requireAdmin: true,
      body: t.Object({
        name: t.Optional(t.String()),
        url: t.String(),
        events: t.Optional(t.Array(t.String())),
        secret: t.Optional(t.String()),
        enabled: t.Optional(t.Boolean()),
        retry_max: t.Optional(t.Number()),
        retry_backoff: t.Optional(t.Union([t.Literal("exponential"), t.Literal("fixed")])),
        retry_delay_ms: t.Optional(t.Number()),
        timeout_ms: t.Optional(t.Number()),
        custom_headers: t.Optional(t.Record(t.String(), t.String())),
      }),
    })

    .patch("/admin/webhooks/:id", async ({ params, body, set }) => {
      if (body.url !== undefined && !/^https?:\/\//i.test(body.url)) {
        set.status = 422; return { error: "url must be http(s)://", code: 422 };
      }
      const patch: Record<string, unknown> = { updated_at: Math.floor(Date.now() / 1000) };
      if (body.name !== undefined)            patch["name"] = body.name;
      if (body.url !== undefined)             patch["url"] = body.url;
      if (body.events !== undefined)          patch["events"] = JSON.stringify(body.events);
      if (body.secret !== undefined)          patch["secret"] = body.secret;
      if (body.enabled !== undefined)         patch["enabled"] = body.enabled ? 1 : 0;
      if (body.retry_max !== undefined)       patch["retry_max"] = body.retry_max;
      if (body.retry_backoff !== undefined)   patch["retry_backoff"] = body.retry_backoff;
      if (body.retry_delay_ms !== undefined)  patch["retry_delay_ms"] = body.retry_delay_ms;
      if (body.timeout_ms !== undefined)      patch["timeout_ms"] = body.timeout_ms;
      if (body.custom_headers !== undefined)  patch["custom_headers"] = JSON.stringify(body.custom_headers);
      await getDb().update(webhooks).set(patch).where(eq(webhooks.id, params.id));
      invalidateWebhookCache();
      const fresh = await getDb().select().from(webhooks).where(eq(webhooks.id, params.id)).limit(1);
      if (fresh.length === 0) { set.status = 404; return { error: "Webhook not found", code: 404 }; }
      return { data: fresh[0] };
    }, {
      requireAdmin: true,
      body: t.Object({
        name: t.Optional(t.String()),
        url: t.Optional(t.String()),
        events: t.Optional(t.Array(t.String())),
        secret: t.Optional(t.String()),
        enabled: t.Optional(t.Boolean()),
        retry_max: t.Optional(t.Number()),
        retry_backoff: t.Optional(t.Union([t.Literal("exponential"), t.Literal("fixed")])),
        retry_delay_ms: t.Optional(t.Number()),
        timeout_ms: t.Optional(t.Number()),
        custom_headers: t.Optional(t.Record(t.String(), t.String())),
      }),
    })

    .delete("/admin/webhooks/:id", async ({ params }) => {
      await getDb().delete(webhooks).where(eq(webhooks.id, params.id));
      invalidateWebhookCache();
      return { data: { deleted: params.id } };
    }, { requireAdmin: true })

    // Fire a test event so the operator can confirm wiring without
    // touching real records.
    .post("/admin/webhooks/:id/test", async ({ params, set }) => {
      const rows = await getDb().select().from(webhooks).where(eq(webhooks.id, params.id)).limit(1);
      const w = rows[0];
      if (!w) { set.status = 404; return { error: "Webhook not found", code: 404 }; }
      // Delivered to this webhook only. (It used to add the test event to
      // this webhook's list and dispatch it, which every `*` webhook
      // received too.)
      await dispatchEvent({ event: `__test.${params.id}`, data: { test: true, webhook_id: w.id }, webhookId: w.id });
      return { data: { ok: true } };
    }, { requireAdmin: true })

    // Delivery log — per-webhook recent deliveries.
    .get("/admin/webhooks/:id/deliveries", async ({ params, query }) => {
      const limit = Math.min(200, Math.max(1, parseInt(query.limit ?? "50", 10)));
      const sinceRaw = query.since ? parseInt(query.since, 10) : 0;
      const conds = sinceRaw > 0
        ? and(eq(webhookDeliveries.webhook_id, params.id), gte(webhookDeliveries.created_at, sinceRaw))
        : eq(webhookDeliveries.webhook_id, params.id);
      const rows = await getDb()
        .select()
        .from(webhookDeliveries)
        .where(conds)
        .orderBy(desc(webhookDeliveries.created_at))
        .limit(limit);
      return { data: rows };
    }, {
      requireAdmin: true,
      query: t.Object({ limit: t.Optional(t.String()), since: t.Optional(t.String()) }),
    });
}
