import { AsyncLocalStorage } from "node:async_hooks";
import { guardedFetch } from "./hook-egress.ts";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { hooks, type Collection } from "../db/schema.ts";
import { ValidationError } from "./validate.ts";
import { appendHookLog } from "./file-logger.ts";
import { sendEmail } from "./email.ts";
import { recordRuleEval, type RuleOutcome } from "./request-context.ts";
import type { AuthContext } from "./rules.ts";
import { makeExtraHelpers, type ExtraHookHelpers } from "./hook-helpers-extra.ts";
import { dbScopedTtlCache } from "./ttl-cache.ts";
import { compileCode } from "./code-loader.ts";
import { announceInvalidation, onPeerInvalidation } from "./peers.ts";

/**
 * Per-async-context store carrying the active HTTP Request through
 * records-core into hook execution. Set by `runWithHookRequest` (called from
 * `src/api/records.ts` create/update/delete handlers) so that
 * `helpers.recordRule(...)` can attach rule outcomes to the request log
 * without records-core needing to know about Request.
 */
const hookRequestStorage = new AsyncLocalStorage<Request>();

/**
 * Run `fn` with `request` available to any hook helpers fired during the
 * call. Hooks invoked outside this scope (cron jobs, custom routes,
 * post-cascade flows) get `undefined` and `recordRule` becomes a no-op.
 */
export function runWithHookRequest<T>(request: Request, fn: () => T): T {
  return hookRequestStorage.run(request, fn);
}

export function getActiveHookRequest(): Request | undefined {
  return hookRequestStorage.getStore();
}

export type HookEvent =
  | "beforeCreate" | "afterCreate"
  | "beforeUpdate" | "afterUpdate"
  | "beforeDelete" | "afterDelete";

export const HOOK_EVENTS: HookEvent[] = [
  "beforeCreate", "afterCreate",
  "beforeUpdate", "afterUpdate",
  "beforeDelete", "afterDelete",
];

export interface HookContext {
  record: Record<string, unknown>;
  existing: Record<string, unknown> | null;
  auth: AuthContext | null;
  helpers: HookHelpers;
}

export interface HookRecordRuleOpts {
  /** Logical name of the rule (e.g. "custom-quota"). */
  rule: string;
  /** Collection the rule applies to. Defaults to the active hook's collection. */
  collection?: string;
  /** Optional human-readable expression text. */
  expression?: string | null;
  /** "allow" | "deny" | "filter" — same shape as the records-API rule eval. */
  outcome: RuleOutcome;
  /** Human-readable explanation. */
  reason: string;
}

export interface HookHelpers extends ExtraHookHelpers {
  slug(s: string): string;
  abort(message: string): never;
  /** Mint a fresh UUIDv4. Same as `crypto.randomUUID()` but discoverable. */
  uuid(): string;
  /** Alias of `uuid()` — common name LLMs reach for when generating ids. */
  id(): string;
  find(collection: string, id: string): Promise<Record<string, unknown> | null>;
  query(
    collection: string,
    opts?: { filter?: string; sort?: string; perPage?: number }
  ): Promise<{ data: Record<string, unknown>[]; totalItems: number }>;
  fetch: typeof globalThis.fetch;
  log(...args: unknown[]): void;
  email(opts: { to: string; subject: string; body: string }): Promise<void>;
  /**
   * Record a custom policy decision on the active request log (records API).
   * No-op when the hook runs without a Request in scope (cron jobs, post-cascade
   * hooks, custom routes invoking records-core directly, etc.). Multiple calls
   * accumulate.
   */
  recordRule(opts: HookRecordRuleOpts): void;
  /**
   * Enqueue a job onto a named queue. Returns the job id and a `deduped`
   * flag (true when an existing non-finished job with the same `uniqueKey`
   * was returned instead of creating a new one).
   */
  enqueue(
    queue: string,
    payload: unknown,
    opts?: {
      delay?: number;
      uniqueKey?: string;
      retries?: number;
      backoff?: "exponential" | "fixed";
      retryDelayMs?: number;
    }
  ): Promise<{ jobId: string; deduped: boolean }>;
  /**
   * Push notification + in-app inbox shorthand. Inserts one row in
   * `vb_notifications` (drives realtime + the in-app inbox UI) and enqueues
   * one `_notify` queue job per enabled provider (OneSignal, FCM). The
   * trigger code is provider-agnostic — operators flip providers in
   * Settings, not in hook code.
   *
   * No-ops gracefully when notifications haven't been bootstrapped: the
   * inbox insert is skipped (table missing) and the push fan-out is empty
   * (no enabled providers). Returns whatever was actually dispatched.
   */
  notify(
    userId: string,
    payload: { title: string; body: string; data?: Record<string, unknown> },
    opts?: {
      /** Push provider names (built-in or registered). Default: every enabled one. */
      providers?: string[];
      inbox?: boolean;
      push?: boolean;
    }
  ): Promise<{
    inboxRowId: string | null;
    enqueued: { provider: string; jobId: string; deduped: boolean }[];
  }>;
}

interface HookRow {
  id: string;
  name: string;
  collection_name: string;
  event: string;
  code: string;
  enabled: number;
}

interface CompiledHook {
  id: string;
  name: string;
  fn: (ctx: HookContext) => Promise<unknown>;
}

// hook id → compiled code, tagged with the row's updated_at so an edit made
// through another cluster worker recompiles here once the row cache expires.
const compiledCache = new Map<string, { version: number; hook: CompiledHook }>();

// Enabled hook rows, cached briefly: these were two SELECTs on every record
// write (before + after hook), most of a create's cost.
const HOOK_ROWS_TTL_MS = 1000;
const enabledHookRows = dbScopedTtlCache(HOOK_ROWS_TTL_MS, () =>
  getDb().select().from(hooks).where(eq(hooks.enabled, 1)),
);

/**
 * An enabled hook whose code doesn't compile still runs, as a function that
 * fails: a before-hook then blocks the write instead of being skipped (it
 * may be the check that guards it), and an after-hook logs the error. The
 * failure is logged once per version of the hook.
 */
function compileHook(row: HookRow): CompiledHook {
  try {
    const fn = compileCode<HookContext>(row);
    return { id: row.id, name: row.name ?? "", fn };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[hooks] Failed to compile hook ${row.id}:`, e);
    const label = row.name || row.id;
    return {
      id: row.id,
      name: row.name ?? "",
      fn: async () => { throw new ValidationError({ _hook: `hook '${label}' does not compile: ${msg}` }); },
    };
  }
}

// ── Hooks registered from code ──────────────────────────────────────────────

export interface HookRegistration {
  /** Shown in logs. */
  name: string;
  /** Collection name, or "" / omitted for every collection. */
  collection?: string;
  event: HookEvent;
  run(ctx: HookContext): unknown;
}

const registeredHooks: Array<{ collection: string; event: HookEvent; hook: CompiledHook }> = [];

/**
 * Add a record hook from code (an extension). It runs after the hooks
 * defined in the admin UI for the same event, with the same context and
 * error handling.
 */
export function registerHook(def: HookRegistration): () => void {
  if (!HOOK_EVENTS.includes(def.event)) throw new Error(`unknown hook event '${String(def.event)}'`);
  const entry = {
    collection: def.collection ?? "",
    event: def.event,
    hook: { id: `ext:${def.name}`, name: def.name, fn: async (ctx: HookContext) => def.run(ctx) },
  };
  registeredHooks.push(entry);
  return () => {
    const i = registeredHooks.indexOf(entry);
    if (i >= 0) registeredHooks.splice(i, 1);
  };
}

export function listRegisteredHooks(): Array<{ name: string; collection: string; event: HookEvent }> {
  return registeredHooks.map((r) => ({ name: r.hook.name, collection: r.collection, event: r.event }));
}

export function invalidateHookCache(): void {
  compiledCache.clear();
  enabledHookRows.invalidate();
  announceInvalidation("hooks");
}
onPeerInvalidation("hooks", invalidateHookCache);

async function lookupEnabledHooks(
  collectionName: string,
  event: HookEvent
): Promise<CompiledHook[]> {
  const rows = await enabledHookRows.get();
  // Match either the specific collection or global ('') hooks
  const matching = rows.filter(
    (r) => r.event === event && (r.collection_name === "" || r.collection_name === collectionName)
  );

  const compiled: CompiledHook[] = [];
  for (const r of matching) {
    const cached = compiledCache.get(r.id);
    let hook = cached && cached.version === r.updated_at ? cached.hook : undefined;
    if (!hook) {
      hook = compileHook(r);
      compiledCache.set(r.id, { version: r.updated_at, hook });
    }
    compiled.push(hook);
  }
  for (const r of registeredHooks) {
    if (r.event === event && (r.collection === "" || r.collection === collectionName)) compiled.push(r.hook);
  }
  return compiled;
}

export async function runBeforeHook(
  collection: Collection,
  event: "beforeCreate" | "beforeUpdate" | "beforeDelete",
  ctx: HookContext,
  request?: Request
): Promise<void> {
  const list = await lookupEnabledHooks(collection.name, event);
  // Resolve effective request: explicit arg wins; otherwise inherit ALS scope.
  const effectiveReq = request ?? hookRequestStorage.getStore();
  for (const h of list) {
    const helperCtx: HookHelperContext = {
      collection: collection.name, event, auth: ctx.auth, name: h.name,
    };
    if (effectiveReq) helperCtx.request = effectiveReq;
    const helpers = makeHookHelpers(helperCtx);
    try {
      await h.fn({ ...ctx, helpers });
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ValidationError({ _hook: msg });
    }
  }
}

export function runAfterHook(
  collection: Collection,
  event: "afterCreate" | "afterUpdate" | "afterDelete",
  ctx: HookContext,
  request?: Request
): void {
  // Fire-and-forget; errors are logged but don't fail the request
  const effectiveReq = request ?? hookRequestStorage.getStore();
  void (async () => {
    const list = await lookupEnabledHooks(collection.name, event);
    for (const h of list) {
      const helperCtx: HookHelperContext = {
        collection: collection.name, event, auth: ctx.auth, name: h.name,
      };
      if (effectiveReq) helperCtx.request = effectiveReq;
      const helpers = makeHookHelpers(helperCtx);
      try {
        await h.fn({ ...ctx, helpers });
      } catch (e) {
        console.error(`[hooks] after-hook ${h.id} threw:`, e);
      }
    }
  })();
}

// ── Helpers factory ─────────────────────────────────────────────────────────

export interface HookHelperContext {
  collection?: string;
  event?: HookEvent;
  auth?: AuthContext | null;
  name?: string;
  /**
   * Optional Request the hook is running under. When present (or when a Request
   * is available via `runWithHookRequest`), `helpers.recordRule(...)` attaches
   * eval entries to the request log. Otherwise `recordRule` is a silent no-op.
   */
  request?: Request;
}

function formatLogArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function makeHookHelpers(ctx: HookHelperContext = {}): HookHelpers {
  const extra = makeExtraHelpers();
  return {
    ...extra,
    slug(s: string): string {
      return String(s)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    },
    abort(message: string): never {
      throw new ValidationError({ _hook: message });
    },
    uuid(): string {
      return crypto.randomUUID();
    },
    id(): string {
      return crypto.randomUUID();
    },
    async find(collection: string, id: string) {
      const { getRecord } = await import("./records.ts");
      const r = await getRecord(collection, id);
      return r as Record<string, unknown> | null;
    },
    async query(collection: string, opts = {}) {
      const { listRecords } = await import("./records.ts");
      const r = await listRecords(collection, {
        filter: opts.filter,
        sort: opts.sort,
        perPage: opts.perPage ?? 100,
      } as Parameters<typeof listRecords>[1]);
      return { data: r.data as unknown as Record<string, unknown>[], totalItems: r.totalItems };
    },
    // Same egress check as helpers.http: `fetch` was raw globalThis.fetch,
    // which made the whole guard optional for hook code.
    fetch: guardedFetch as typeof globalThis.fetch,
    log(...args: unknown[]) {
      const message = args.map(formatLogArg).join(" ");
      console.log("[hook]", message);
      const input: Parameters<typeof appendHookLog>[0] = { message };
      if (ctx.collection !== undefined) input.collection = ctx.collection;
      if (ctx.event !== undefined) input.event = ctx.event;
      if (ctx.name) input.name = ctx.name;
      if (ctx.auth !== undefined) {
        input.auth = ctx.auth ? {
          id: ctx.auth.id,
          type: ctx.auth.type,
          ...(ctx.auth.email ? { email: ctx.auth.email } : {}),
        } : null;
      }
      appendHookLog(input);
    },
    async email(opts) {
      // Caller passes { to, subject, body }. Send as text by default; if body
      // contains an HTML tag, also use it as the html part for clients that
      // can render it.
      const looksHtml = /<\w+[^>]*>/.test(opts.body);
      const sendOpts: Parameters<typeof sendEmail>[0] = {
        to: opts.to,
        subject: opts.subject,
        text: opts.body,
      };
      if (looksHtml) sendOpts.html = opts.body;
      await sendEmail(sendOpts);
    },
    async enqueue(queue, payload, opts = {}) {
      // Lazy-import to break the queues → hooks → queues cycle.
      const { enqueue } = await import("./queues.ts");
      return enqueue(queue, payload, opts);
    },
    async notify(userId, payload, opts = {}) {
      // Lazy-import: notifications.ts imports queues.ts which imports hooks.ts.
      const { dispatchNotification } = await import("./notifications.ts");
      return dispatchNotification(userId, payload, opts);
    },
    recordRule(opts: HookRecordRuleOpts): void {
      // Prefer an explicitly-provided Request, then fall back to the
      // AsyncLocalStorage-tracked one set by `runWithHookRequest`. If neither
      // is present (cron jobs, post-cascade hooks, etc.), silently no-op so
      // hook code is portable across contexts.
      const req = ctx.request ?? hookRequestStorage.getStore();
      if (!req) return;
      const collection = opts.collection ?? ctx.collection ?? "";
      recordRuleEval(req, {
        rule: opts.rule,
        collection,
        expression: opts.expression ?? null,
        outcome: opts.outcome,
        reason: opts.reason,
      });
    },
  };
}
