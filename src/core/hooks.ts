import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { hooks, type Collection } from "../db/schema.ts";
import { ValidationError } from "./validate.ts";
import { appendHookLog } from "./file-logger.ts";
import { sendEmail } from "./email.ts";
import type { AuthContext } from "./rules.ts";

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

export interface HookHelpers {
  slug(s: string): string;
  abort(message: string): never;
  find(collection: string, id: string): Promise<Record<string, unknown> | null>;
  query(
    collection: string,
    opts?: { filter?: string; sort?: string; perPage?: number }
  ): Promise<{ data: Record<string, unknown>[]; totalItems: number }>;
  fetch: typeof globalThis.fetch;
  log(...args: unknown[]): void;
  email(opts: { to: string; subject: string; body: string }): Promise<void>;
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

const compiledCache = new Map<string, CompiledHook>(); // hook id → compiled

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (ctx: HookContext) => Promise<unknown>;

function compileHook(row: HookRow): CompiledHook | null {
  try {
    const fn = new AsyncFunction("ctx", row.code);
    return { id: row.id, name: row.name ?? "", fn };
  } catch (e) {
    console.error(`[hooks] Failed to compile hook ${row.id}:`, e);
    return null;
  }
}

export function invalidateHookCache(): void {
  compiledCache.clear();
}

async function lookupEnabledHooks(
  collectionName: string,
  event: HookEvent
): Promise<CompiledHook[]> {
  const db = getDb();
  // Match either the specific collection or global ('') hooks
  const rows = await db
    .select()
    .from(hooks)
    .where(and(eq(hooks.event, event), eq(hooks.enabled, 1)));

  const matching = rows.filter(
    (r) => r.collection_name === "" || r.collection_name === collectionName
  );

  const compiled: CompiledHook[] = [];
  for (const r of matching) {
    let entry = compiledCache.get(r.id);
    if (!entry) {
      const c = compileHook(r);
      if (c) { compiledCache.set(r.id, c); entry = c; }
    }
    if (entry) compiled.push(entry);
  }
  return compiled;
}

export async function runBeforeHook(
  collection: Collection,
  event: "beforeCreate" | "beforeUpdate" | "beforeDelete",
  ctx: HookContext
): Promise<void> {
  const list = await lookupEnabledHooks(collection.name, event);
  for (const h of list) {
    const helpers = makeHookHelpers({ collection: collection.name, event, auth: ctx.auth, name: h.name });
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
  ctx: HookContext
): void {
  // Fire-and-forget; errors are logged but don't fail the request
  void (async () => {
    const list = await lookupEnabledHooks(collection.name, event);
    for (const h of list) {
      const helpers = makeHookHelpers({ collection: collection.name, event, auth: ctx.auth, name: h.name });
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
}

function formatLogArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function makeHookHelpers(ctx: HookHelperContext = {}): HookHelpers {
  return {
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
    fetch: globalThis.fetch.bind(globalThis),
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
  };
}
