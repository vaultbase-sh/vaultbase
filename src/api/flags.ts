/**
 * Feature flags API.
 *
 * Admin (auth required, `audience: "admin"`):
 *   GET    /api/admin/flags                — list all
 *   GET    /api/admin/flags/:key           — read one
 *   POST   /api/admin/flags                — create
 *   PATCH  /api/admin/flags/:key           — update
 *   DELETE /api/admin/flags/:key           — delete
 *   POST   /api/admin/flags/:key/evaluate  — admin "test context" preview
 *
 * Public (auth optional — but evaluation context typically carries the
 * caller's user info):
 *   POST /api/flags/evaluate    body: { context, keys?: string[] }
 *      → returns { data: { <key>: <value>, ... } }
 *      Returns ALL flags when `keys` is omitted; otherwise only those.
 *      Bulk-eval is the recommended client-SDK path: one round trip,
 *      one flag map you can refresh on websocket deltas later.
 */
import Elysia, { t } from "elysia";
import { verifyAuthToken } from "../core/sec.ts";
import {
  listFlags, getFlag, upsertFlag, deleteFlag, evaluate, evaluateAll,
  listSegments, getSegment, upsertSegment, deleteSegment,
  type FlagValue, type Variation, type Rule, type Condition,
} from "../core/flags.ts";
import { broadcastSystem } from "../realtime/manager.ts";

const FLAGS_TOPIC = "__flags";

function pushFlagDelta(payload: { type: "flag_changed" | "flag_deleted"; key: string }): void {
  try { broadcastSystem(FLAGS_TOPIC, payload); } catch { /* swallow */ }
}

async function requireAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

export function makeFlagsPlugin(jwtSecret: string) {
  return new Elysia({ name: "flags" })
    // ── Admin CRUD ────────────────────────────────────────────────────────
    .get("/api/admin/flags", async ({ request, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return { data: await listFlags() };
    })
    .get("/api/admin/flags/:key", async ({ request, params, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const flag = await getFlag(params.key);
      if (!flag) { set.status = 404; return { error: "Flag not found", code: 404 }; }
      return { data: flag };
    })
    .post("/api/admin/flags", async ({ request, body, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      try {
        const input: Parameters<typeof upsertFlag>[0] = { key: body.key };
        if (body.description !== undefined)   input.description = body.description;
        if (body.type !== undefined)          input.type = body.type;
        if (body.enabled !== undefined)       input.enabled = body.enabled;
        if (body.default_value !== undefined) input.default_value = body.default_value as FlagValue;
        if (body.variations !== undefined)    input.variations = body.variations as Variation[];
        if (body.rules !== undefined)         input.rules = body.rules as Rule[];
        const created = await upsertFlag(input);
        pushFlagDelta({ type: "flag_changed", key: created.key });
        return { data: created };
      } catch (e) {
        set.status = 422; return { error: e instanceof Error ? e.message : String(e), code: 422 };
      }
    }, {
      body: t.Object({
        key: t.String(),
        description: t.Optional(t.String()),
        type: t.Optional(t.Union([t.Literal("bool"), t.Literal("string"), t.Literal("number"), t.Literal("json")])),
        enabled: t.Optional(t.Boolean()),
        default_value: t.Optional(t.Any()),
        variations: t.Optional(t.Array(t.Any())),
        rules: t.Optional(t.Array(t.Any())),
      }),
    })
    .patch("/api/admin/flags/:key", async ({ request, params, body, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      try {
        const input: Parameters<typeof upsertFlag>[0] = { key: params.key };
        if (body.description !== undefined)   input.description = body.description;
        if (body.type !== undefined)          input.type = body.type;
        if (body.enabled !== undefined)       input.enabled = body.enabled;
        if (body.default_value !== undefined) input.default_value = body.default_value as FlagValue;
        if (body.variations !== undefined)    input.variations = body.variations as Variation[];
        if (body.rules !== undefined)         input.rules = body.rules as Rule[];
        const updated = await upsertFlag(input);
        pushFlagDelta({ type: "flag_changed", key: updated.key });
        return { data: updated };
      } catch (e) {
        set.status = 422; return { error: e instanceof Error ? e.message : String(e), code: 422 };
      }
    }, {
      body: t.Object({
        description: t.Optional(t.String()),
        type: t.Optional(t.Union([t.Literal("bool"), t.Literal("string"), t.Literal("number"), t.Literal("json")])),
        enabled: t.Optional(t.Boolean()),
        default_value: t.Optional(t.Any()),
        variations: t.Optional(t.Array(t.Any())),
        rules: t.Optional(t.Array(t.Any())),
      }),
    })
    .delete("/api/admin/flags/:key", async ({ request, params, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      await deleteFlag(params.key);
      pushFlagDelta({ type: "flag_deleted", key: params.key });
      return { data: { deleted: params.key } };
    })
    // Test-evaluate: takes an arbitrary context, returns the resolved value
    // plus the trace (matched rule id, reason). Drives the "test context"
    // panel in the admin Flag editor.
    .post("/api/admin/flags/:key/evaluate", async ({ request, params, body, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const result = await evaluate(params.key, (body.context ?? {}) as Record<string, unknown>);
      return { data: result };
    }, {
      body: t.Object({ context: t.Optional(t.Record(t.String(), t.Any())) }),
    })

    // ── Segments ─────────────────────────────────────────────────────────
    .get("/api/admin/flag-segments", async ({ request, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return { data: await listSegments() };
    })
    .get("/api/admin/flag-segments/:name", async ({ request, params, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const seg = await getSegment(params.name);
      if (!seg) { set.status = 404; return { error: "Segment not found", code: 404 }; }
      return { data: seg };
    })
    .post("/api/admin/flag-segments", async ({ request, body, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      try {
        const input: Parameters<typeof upsertSegment>[0] = { name: body.name };
        if (body.description !== undefined) input.description = body.description;
        if (body.conditions !== undefined)  input.conditions  = body.conditions as Condition;
        const seg = await upsertSegment(input);
        pushFlagDelta({ type: "flag_changed", key: `__segment:${seg.name}` });
        return { data: seg };
      } catch (e) {
        set.status = 422; return { error: e instanceof Error ? e.message : String(e), code: 422 };
      }
    }, {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        conditions: t.Optional(t.Any()),
      }),
    })
    .patch("/api/admin/flag-segments/:name", async ({ request, params, body, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      try {
        const input: Parameters<typeof upsertSegment>[0] = { name: params.name };
        if (body.description !== undefined) input.description = body.description;
        if (body.conditions !== undefined)  input.conditions  = body.conditions as Condition;
        const seg = await upsertSegment(input);
        pushFlagDelta({ type: "flag_changed", key: `__segment:${seg.name}` });
        return { data: seg };
      } catch (e) {
        set.status = 422; return { error: e instanceof Error ? e.message : String(e), code: 422 };
      }
    }, {
      body: t.Object({
        description: t.Optional(t.String()),
        conditions: t.Optional(t.Any()),
      }),
    })
    .delete("/api/admin/flag-segments/:name", async ({ request, params, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      await deleteSegment(params.name);
      pushFlagDelta({ type: "flag_deleted", key: `__segment:${params.name}` });
      return { data: { deleted: params.name } };
    })

    // ── Public bulk eval ──────────────────────────────────────────────────
    .post("/api/flags/evaluate", async ({ body }) => {
      const ctx = (body.context ?? {}) as Record<string, unknown>;
      if (Array.isArray(body.keys) && body.keys.length > 0) {
        const out: Record<string, FlagValue> = {};
        for (const k of body.keys) {
          const r = await evaluate(k, ctx);
          out[k] = r.value;
        }
        return { data: out };
      }
      return { data: await evaluateAll(ctx) };
    }, {
      body: t.Object({
        context: t.Optional(t.Record(t.String(), t.Any())),
        keys: t.Optional(t.Array(t.String())),
      }),
    });
}
