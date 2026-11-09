/**
 * Waiting helpers for tests that check work which finishes after the call
 * returns (fire-and-forget audit rows, after-hooks, emails, log flushes) or
 * that need another request to be at a known point (inside its hook).
 *
 * - `until(cond)` polls instead of sleeping a fixed time before a positive
 *   assert. A fixed sleep is only right before a negative assert ("nothing
 *   happened"), and then the line carries a `// settle:` comment (checked by
 *   scripts/check-test-sleeps.ts).
 * - `gate(name)` is a barrier hook code can reach through
 *   `globalThis.__gate(name)`: the hook calls `arrive()` (marks the gate
 *   reached and waits until the test opens it) or `signal()` (marks it
 *   reached and carries on). The test awaits `reached` and calls `open()`.
 */

export interface UntilOptions {
  timeout?: number;
  step?: number;
  /** Shown in the timeout error. */
  message?: string;
}

/**
 * Poll `cond` until it returns a truthy value, and return that value.
 * Throws after `timeout` ms with a message naming what it waited for.
 */
export async function until<T>(
  cond: () => T | Promise<T>,
  { timeout = 2000, step = 10, message }: UntilOptions = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      const v = await cond();
      if (v) return v as NonNullable<T>;
      lastError = undefined;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) {
      const what = message ?? cond.toString().slice(0, 200);
      const why = lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : "";
      throw new Error(`until: timed out after ${timeout} ms waiting for ${what}${why}`);
    }
    await Bun.sleep(step);
  }
}

export interface Gate {
  readonly name: string;
  /** Resolves once hook code has called `arrive()` or `signal()`. */
  readonly reached: Promise<void>;
  readonly isReached: boolean;
  readonly isOpen: boolean;
  /** Hook side: mark the gate reached, then wait until the test opens it. */
  arrive(): Promise<void>;
  /** Hook side: mark the gate reached without waiting. */
  signal(): void;
  /** Test side: let every `arrive()` caller continue. */
  open(): void;
  /** Test side: wait until reached, failing after `timeout` ms. */
  waitReached(timeout?: number): Promise<void>;
}

function makeGate(name: string): Gate {
  let markReached!: () => void;
  let markOpen!: () => void;
  const reached = new Promise<void>((r) => { markReached = r; });
  const opened = new Promise<void>((r) => { markOpen = r; });
  let isReached = false;
  let isOpen = false;
  const g: Gate = {
    name,
    reached,
    get isReached() { return isReached; },
    get isOpen() { return isOpen; },
    signal() { isReached = true; markReached(); },
    async arrive() { g.signal(); await opened; },
    open() { isOpen = true; markOpen(); },
    async waitReached(timeout = 5000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reached,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`gate "${name}" was not reached within ${timeout} ms`)), timeout);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
  return g;
}

const gates = new Map<string, Gate>();

/**
 * The gate called `name`, created on first use. Hook code reaches the same
 * object through `globalThis.__gate(name)`.
 */
export function gate(name: string): Gate {
  let g = gates.get(name);
  if (!g) { g = makeGate(name); gates.set(name, g); }
  return g;
}

/**
 * A new gate called `name`, replacing (and opening, so nothing stays stuck
 * on it) any earlier one. Use at the start of a test.
 */
export function freshGate(name: string): Gate {
  gates.get(name)?.open();
  const g = makeGate(name);
  gates.set(name, g);
  return g;
}

/** Open and forget the gate. Use in `finally`. */
export function dropGate(name: string): void {
  gates.get(name)?.open();
  gates.delete(name);
}

(globalThis as unknown as { __gate: typeof gate }).__gate = gate;
