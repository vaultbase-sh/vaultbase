/**
 * Time limits for user scripts: hooks, custom routes, cron jobs and queue
 * workers. They run in the server's own thread, so a run can't be stopped
 * from outside while it computes; what a limit does is stop waiting for it.
 * When it runs out, the caller gets ScriptTimeoutError at once, the run's
 * outgoing requests are aborted, and its later helper calls are refused, so
 * a run left behind can't write after the request it belonged to ended.
 * A loop that never awaits still holds the thread: nothing in-process can
 * interrupt it. A helper call already under way when the limit runs out
 * finishes (an email being sent); code that doesn't go through helpers
 * isn't stopped.
 *
 * Applies to scripts written in the admin or kept as files. Code registered
 * from an app embedding Vaultbase, and the server's own workers, isn't limited.
 */
import { getSetting } from "../api/settings.ts";
import { scriptRuns, stoppedReason, untilAborted } from "./script-signal.ts";

export { currentScriptSignal } from "./script-signal.ts";

export type ScriptKind = "hook" | "afterHook" | "route" | "job" | "queue";

/** Setting per kind, in milliseconds; 0 = no limit. */
export const SCRIPT_TIMEOUT_KEYS: Readonly<Record<ScriptKind, string>> = {
  hook: "hooks.timeout_ms",
  afterHook: "hooks.after_timeout_ms",
  route: "routes.timeout_ms",
  job: "jobs.timeout_ms",
  queue: "queues.timeout_ms",
};

/** Limits when the setting is unset. A before-hook holds its request (and its write). */
export const DEFAULT_SCRIPT_TIMEOUT_MS: Readonly<Record<ScriptKind, number>> = {
  hook: 10_000,
  afterHook: 30_000,
  route: 30_000,
  job: 300_000,
  queue: 300_000,
};

/** The most a limit may be: a day. */
export const MAX_SCRIPT_TIMEOUT_MS = 86_400_000;

const LABELS: Readonly<Record<ScriptKind, string>> = {
  hook: "hook", afterHook: "hook", route: "route", job: "cron job", queue: "queue worker",
};

/** What's wrong with a limit setting's value, or null. */
export function validateScriptTimeout(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SCRIPT_TIMEOUT_MS || (n > 0 && n < 100)) {
    return `must be 0 (no limit) or a whole number of milliseconds from 100 to ${MAX_SCRIPT_TIMEOUT_MS}`;
  }
  return null;
}

export function scriptTimeoutMs(kind: ScriptKind): number {
  const raw = getSetting(SCRIPT_TIMEOUT_KEYS[kind], "").trim();
  return raw !== "" && validateScriptTimeout(raw) === null ? Number(raw) : DEFAULT_SCRIPT_TIMEOUT_MS[kind];
}

export class ScriptTimeoutError extends Error {
  constructor(readonly kind: ScriptKind, readonly script: string, readonly ms: number) {
    super(`${LABELS[kind]} '${script}' timed out after ${ms} ms`);
    this.name = "ScriptTimeoutError";
  }
}

/**
 * Run `fn` under the limit for `kind`. `fn` gets the run's signal: hand it
 * to guardHelpers. Rejects with ScriptTimeoutError when the limit runs out;
 * the run itself goes on until it next awaits a helper or a request.
 * `onRun` gets the run's own promise, which settles when the run really
 * ends: a caller holding a slot for it (queue concurrency, the cron overlap
 * guard) keeps the slot until then, so runs left behind can't pile up.
 */
export async function withTimeLimit<T>(
  kind: ScriptKind,
  script: string,
  fn: (signal: AbortSignal) => Promise<T>,
  onRun?: (run: Promise<unknown>) => void,
): Promise<T> {
  const ms = scriptTimeoutMs(kind);
  const ac = new AbortController();
  const run = scriptRuns.run(ac.signal, () => fn(ac.signal));
  onRun?.(run);
  if (ms === 0) return run;
  // Settled after the limit, the run's result has no one waiting for it.
  run.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ScriptTimeoutError(kind, script, ms);
      ac.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([run, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `helpers` refusing every use once `signal` is aborted: a run past its
 * limit can't start a query, a write, a mail or a job any more. A helper
 * call that returns a promise rejects when the limit runs out, so the
 * script stops waiting on it. Nested namespaces (`helpers.db`,
 * `helpers.http`, …) are guarded the same way.
 */
export function guardHelpers<T extends object>(helpers: T, signal: AbortSignal): T {
  const cache = new WeakMap<object, object>();
  const wrap = <O extends object>(target: O): O => {
    const hit = cache.get(target);
    if (hit) return hit as O;
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        if (signal.aborted) throw stoppedReason(signal);
        const v = Reflect.get(t, prop, receiver);
        if (typeof v === "function") {
          return (...args: unknown[]) => {
            if (signal.aborted) throw stoppedReason(signal);
            const out = Reflect.apply(v, t, args);
            return out instanceof Promise ? untilAborted(out, signal) : out;
          };
        }
        return v !== null && typeof v === "object" ? wrap(v as object) : v;
      },
    });
    cache.set(target, proxy);
    return proxy;
  };
  return wrap(helpers);
}
