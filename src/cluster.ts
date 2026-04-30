/**
 * Cluster mode — multi-process Vaultbase via SO_REUSEPORT.
 *
 * Single Bun process is single-threaded — saturates one core at ~7-13K rps.
 * Cluster mode spawns N worker processes that all bind the same port via
 * `Bun.serve({ reusePort: true })`. The Linux / macOS kernel load-balances
 * accepted connections across workers, multiplying throughput by ~Nx
 * (real-world: ~0.85x per added core; some contention is unavoidable).
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

if (N === 1) {
  process.stderr.write(`vaultbase-cluster: only 1 worker requested — running directly without cluster overhead\n`);
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
 * Detection: when running compiled, `process.argv[1]` is empty and
 * `process.execPath` ends with the binary name; otherwise we're under Bun.
 */
function workerCmd(): string[] {
  // Bun sets `process.isBun` always; the compiled binary embeds Bun + the
  // user code, so `--bun` style flags aren't applicable. Use the binary
  // path directly for the compiled case.
  const isCompiled = !process.argv[1] || /vaultbase(\.exe)?$/.test(process.execPath);
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
      process.stderr.write(`vaultbase-cluster: worker ${id} died (${reason}) — respawning in 1s\n`);
      setTimeout(() => {
        if (shuttingDown) return;
        const fresh = spawnWorker(id);
        const idx = workers.findIndex((w) => w.id === id);
        if (idx >= 0) workers[idx] = fresh;
        else workers.push(fresh);
      }, 1000);
    },
  });
  return { id, proc, startedAt: Date.now() };
}

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
