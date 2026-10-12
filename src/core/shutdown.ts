/**
 * Stop the server without cutting requests off mid-flight.
 *
 * SIGTERM used to drain the log buffer and exit at once, so a request being
 * handled — a record write with its hooks, an upload — was dropped halfway.
 * Now the listener stops taking connections, in-flight requests get up to
 * `timeoutMs` to finish, then background work and the database are closed.
 */
export interface ShutdownSteps {
  /** Stop accepting connections; resolves when in-flight requests are done. */
  stopServer: () => Promise<unknown> | unknown;
  /** Run after the server has stopped (or the wait timed out), in order. */
  cleanup: Array<() => Promise<unknown> | unknown>;
  timeoutMs: number;
}

export async function shutdownGracefully(steps: ShutdownSteps): Promise<"drained" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), steps.timeoutMs); });
  const stopped = Promise.resolve()
    .then(() => steps.stopServer())
    .then(() => "drained" as const, () => "drained" as const);
  const outcome = await Promise.race([stopped, timedOut]);
  clearTimeout(timer);
  for (const step of steps.cleanup) {
    try { await step(); } catch { /* keep going: the process is exiting */ }
  }
  return outcome;
}
