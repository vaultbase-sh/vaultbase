/**
 * Cluster mode — multi-process Vaultbase via SO_REUSEPORT.
 *
 * Single Bun process is single-threaded — saturates one core at ~7-13K rps.
 * Cluster mode spawns N worker processes that all bind the same port via
 * `Bun.serve({ reusePort: true })`. On Linux the kernel load-balances
 * accepted connections across workers, multiplying throughput by ~Nx
 * (real-world: ~0.85x per added core; some contention is unavoidable).
 * macOS and Windows accept the flag but don't distribute connections: one
 * worker takes them all, so there it only buys worker auto-restart.
 *
 * Usage:
 *
 *   bun src/cluster.ts                    # auto: one worker per CPU core
 *   VAULTBASE_WORKERS=4 bun src/cluster.ts
 *
 * SQLite strategy (Phase 6a — ship first):
 *   All workers open the same DB file. WAL mode allows concurrent readers
 *   while serializing writes. Read-heavy workloads scale near-linearly with
 *   workers; write-heavy workloads contend on the file lock and may need
 *   the dedicated-writer pattern (Phase 6b) — only build that if measured
 *   contention demands it.
 *
 * Process model:
 *   parent (this file)         ← orchestrator, no port bind, supervises
 *     ├─ worker 0  (bun src/index.ts)
 *     ├─ worker 1  (bun src/index.ts)
 *     ├─ …
 *     └─ worker N-1
 *
 *   Parent traps SIGTERM / SIGINT, broadcasts to children, waits up to 30s
 *   for graceful drain. Children flush their log buffers + close DB on
 *   shutdown (handled by `src/index.ts`).
 */

import { availableParallelism } from "node:os";
import type { Subprocess } from "bun";

interface WorkerHandle {
  id: number;
  proc: Subprocess;
  startedAt: number;
}

const N = parseInt(
  process.env["VAULTBASE_WORKERS"] ?? String(availableParallelism()),
  10,
);

if (!Number.isFinite(N) || N < 1) {
  process.stderr.write(`vaultbase-cluster: VAULTBASE_WORKERS must be a positive integer (got ${process.env["VAULTBASE_WORKERS"]})\n`);
  process.exit(1);
}

// Deprecated since 0.22.0: say so where it's started, not only in worker 0's log.
process.stderr.write(
  "vaultbase cluster: DEPRECATED. Cluster mode will be removed in a coming release. " +
  "One `vaultbase` process already serves record reads on worker threads (VAULTBASE_READ_WORKERS); " +
  "change the service to run `vaultbase` instead of `vaultbase cluster`.\n",
);

if (N === 1) {
  process.stderr.write(`vaultbase-cluster: only 1 worker requested; one worker is started and kept running\n`);
}

const workers: WorkerHandle[] = [];
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Pick the right command to spawn a worker. Two cases:
 *   - Compiled binary deploy (`vaultbase cluster` from /usr/local/bin): the
 *     parent IS the binary; spawn `process.execPath` directly so the worker
 *     also runs the binary (no Bun runtime needed at the spawn site).
 *   - Source-tree dev (`bun src/cluster.ts`): spawn `bun src/index.ts`.
 *
 * Detection: a compiled binary runs its embedded code from Bun's virtual
 * filesystem (`/$bunfs/root/…`, `B:/~BUN/root/…` on Windows), whatever the
 * file is called. Matching the name missed `vaultbase-linux-x64`, which then
 * spawned `bun src/index.ts`, died and respawned forever.
 */
function workerCmd(): string[] {
  // Bun sets `process.isBun` always; the compiled binary embeds Bun + the
  // user code, so `--bun` style flags aren't applicable. Use the binary
  // path directly for the compiled case.
  const entry = process.argv[1] ?? "";
  const isCompiled = !entry || entry.includes("$bunfs") || entry.includes("~BUN");
  if (isCompiled) return [process.execPath];
  return ["bun", "src/index.ts"];
}

function spawnWorker(id: number): WorkerHandle {
  const proc = Bun.spawn({
    cmd: workerCmd(),
    env: {
      ...process.env,
      VAULTBASE_WORKER_ID: String(id),
    },
    stdout: "inherit",
    stderr: "inherit",
    onExit(_p, exitCode, signalCode, error) {
      if (shuttingDown) return;
      const reason = error?.message ?? `exit=${exitCode} signal=${signalCode ?? ""}`;
      // A worker that dies soon after starting (bad config, a port in use)
      // waits longer each time, up to 30 s, instead of respawning every second.
      const quick = Date.now() - startedAt < 10_000;
      const n = quick ? (quickDeaths.get(id) ?? 0) + 1 : 0;
      quickDeaths.set(id, n);
      const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, n - 1));
      process.stderr.write(`vaultbase-cluster: worker ${id} died (${reason}) — respawning in ${Math.round(delay / 1000)}s\n`);
      setTimeout(() => {
        if (shuttingDown) return;
        const fresh = spawnWorker(id);
        const idx = workers.findIndex((w) => w.id === id);
        if (idx >= 0) workers[idx] = fresh;
        else workers.push(fresh);
      }, delay);
    },
  });
  const startedAt = Date.now();
  return { id, proc, startedAt };
}

/** Worker id → how many times in a row it died within 10 s of starting. */
const quickDeaths = new Map<number, number>();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\nvaultbase-cluster: received ${signal}, draining ${workers.length} worker(s)...\n`);

  // Forward the signal so children run their own graceful drain (file logger,
  // realtime disconnect, DB close). Bun.spawn's `kill()` sends SIGTERM by
  // default on POSIX; pass the explicit number on Windows since signal names
  // there are limited.
  for (const w of workers) {
    try { w.proc.kill(); } catch { /* already gone */ }
  }

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  for (const w of workers) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      try { w.proc.kill(9); } catch { /* already gone */ }
      continue;
    }
    try {
      await Promise.race([
        w.proc.exited,
        new Promise<void>((res) => setTimeout(res, remaining)),
      ]);
    } catch { /* swallow */ }
  }
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT");  });

process.stderr.write(`vaultbase-cluster: spawning ${N} worker(s)...\n`);
for (let i = 0; i < N; i++) {
  workers.push(spawnWorker(i));
}
process.stderr.write(`vaultbase-cluster: ${N} workers up. Health check: GET /_/health\n`);
