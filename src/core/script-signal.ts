/**
 * The signal of the user script running in this async context, aborted when
 * its time limit runs out (script-limits.ts). On its own, without imports, so
 * the database driver can read it. Only a script's own work reads it: the
 * server's work started from a script (a write's webhooks, another hook) runs
 * under its own scope or none.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const scriptRuns = new AsyncLocalStorage<AbortSignal>();

export function currentScriptSignal(): AbortSignal | undefined {
  return scriptRuns.getStore();
}

/** Thrown into a script that keeps going past its limit. */
export function stoppedReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("script stopped");
}

/** `p`, rejected as soon as `signal` aborts (the work behind `p` isn't stopped). */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(stoppedReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stoppedReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}
