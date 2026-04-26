import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { hooks, type Collection } from "../db/schema.ts";
import { ValidationError } from "./validate.ts";
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
  collection_name: string;
  event: string;
  code: string;
  enabled: number;
}

interface CompiledHook {
  id: string;
  fn: (ctx: HookContext) => Promise<unknown>;
}

const compiledCache = new Map<string, CompiledHook>(); // hook id → compiled

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (ctx: HookContext) => Promise<unknown>;

function compileHook(row: HookRow): CompiledHook | null {
  try {
    const fn = new AsyncFunction("ctx", row.code);
    return { id: row.id, fn };
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
    try {
      await h.fn(ctx);
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
      try {
        await h.fn(ctx);
      } catch (e) {
        console.error(`[hooks] after-hook ${h.id} threw:`, e);
      }
    }
  })();
}

// ── Helpers factory ─────────────────────────────────────────────────────────

export function makeHookHelpers(): HookHelpers {
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
      console.log("[hook]", ...args);
    },
    async email() {
      // Placeholder until SMTP is wired up
      throw new Error("email() not implemented yet — SMTP integration pending");
    },
  };
}
