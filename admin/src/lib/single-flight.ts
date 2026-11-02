/**
 * Wrap an async task so only one run is in flight at a time.
 *
 * - A call while a run is going joins it (same promise).
 * - A call with `rerun` while a run is going queues exactly one more run
 *   after it, so a forced reload issued mid-load isn't dropped: the data it
 *   asked for may have changed after the first request left.
 * - A failed run never blocks later ones.
 */
export function singleFlight(task: () => Promise<void>): (rerun?: boolean) => Promise<void> {
  let current: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const start = (): Promise<void> => {
    let run: Promise<void> | null = null;
    run = (async () => {
      try { await task(); } finally { if (current === run) current = null; }
    })();
    current = run;
    return run;
  };
  return (rerun = false) => {
    if (!current) return start();
    if (!rerun) return current;
    if (!queued) {
      queued = current.catch(() => {}).then(() => {
        queued = null;
        return current ?? start();
      });
    }
    return queued;
  };
}
