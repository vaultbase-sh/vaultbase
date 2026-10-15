import { loadConfig, loadServiceEnvFile } from "./config.ts";
import { requiredSetupKey, setupKeyFromEnv } from "./core/setup-key.ts";
import { initDb, getDb, closeDb, getRawClient, JOURNAL_SIZE_LIMIT } from "./db/client.ts";
import { db } from "./db/index.ts";
import { startCheckpointer, stopCheckpointer } from "./db/checkpointer.ts";
import { flushGroupCommit } from "./core/group-commit.ts";
import { shutdownGracefully } from "./core/shutdown.ts";
import { CLUSTER_LIMITS_WARNING, isClusterWorker, runsSingletonDuties } from "./core/cluster-role.ts";
import { stopScheduler } from "./core/jobs.ts";
import { stopQueueScheduler, waitForRunningJobs } from "./core/queues.ts";
import { stopWebhookDispatcher } from "./core/webhooks.ts";
import { stopBackupScheduler } from "./core/backups.ts";
import { stopUpdateCheckScheduler } from "./core/update-check.ts";
import { runMigrations } from "./db/migrate.ts";

/** How long an idle keep-alive connection stays open, seconds (see `listen`). */
export const IDLE_TIMEOUT_S = 120;
import { admin } from "./db/schema.ts";
import { createServer } from "./server.ts";
import { applySnapshot, SnapshotShapeError, type ApplyMode } from "./core/migrations.ts";
import { drainLogBuffer, drainLogBufferSync } from "./core/file-logger.ts";

// Top-level safety net — log + keep the process up rather than crash on a
// stray rejection from a `void asyncFn()` site. Default Node behaviour is
// to terminate the process; for a backend that has scheduler ticks, queue
// runners, and fire-and-forget log writes, that's the wrong default.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`[unhandled-rejection] ${msg}\n`);
});
// An uncaught exception leaves the process in an unknown state (a half-run
// write, a lock never released), so log it and shut down; the service
// manager restarts us. It used to be logged and ignored.
let onFatal: ((e: Error) => void) | null = null;
process.on("uncaughtException", (e) => {
  process.stderr.write(`[uncaught-exception] ${e.stack ?? e.message}\n`);
  if (onFatal) onFatal(e);
  else process.exit(1);
});

interface CliFlags {
  applySnapshot?: string;
  snapshotMode: ApplyMode;
  setupAdmin?: { email: string; password: string; force: boolean };
}

/**
 * Parse `process.argv` for the snapshot-related CLI flags. Accepts both
 * `--flag=value` and `--flag value` forms.
 */
export function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { snapshotMode: "additive" };
  // Sub-command form: `vaultbase setup-admin --email … --password …`.
  if (argv[0] === "setup-admin") {
    let email = "";
    let password = "";
    let force = false;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] ?? "";
      if (arg.startsWith("--email=")) email = arg.slice("--email=".length);
      else if (arg === "--email") { const v = argv[++i]; if (v) email = v; }
      else if (arg.startsWith("--password=")) password = arg.slice("--password=".length);
      else if (arg === "--password") { const v = argv[++i]; if (v) password = v; }
      else if (arg === "--force") force = true;
      else if (arg === "--help" || arg === "-h") {
        process.stdout.write(
          `Usage: vaultbase setup-admin --email <e> --password <p> [--force]\n` +
          `\n` +
          `Bootstraps an admin account from the CLI — never exposes the web wizard.\n` +
          `Refuses to run when an admin already exists, unless --force is passed.\n`,
        );
        process.exit(0);
      }
    }
    flags.setupAdmin = { email, password, force };
    return flags;
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;

    if (arg.startsWith("--apply-snapshot=")) {
      flags.applySnapshot = arg.slice("--apply-snapshot=".length);
    } else if (arg === "--apply-snapshot") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        flags.applySnapshot = next;
        i++;
      }
    } else if (arg.startsWith("--snapshot-mode=")) {
      const v = arg.slice("--snapshot-mode=".length);
      if (v === "additive" || v === "sync") flags.snapshotMode = v;
      else {
        process.stderr.write(`vaultbase: --snapshot-mode must be 'additive' or 'sync' (got '${v}')\n`);
        process.exit(1);
      }
    } else if (arg === "--snapshot-mode") {
      const next = argv[i + 1];
      if (next === "additive" || next === "sync") {
        flags.snapshotMode = next;
        i++;
      } else {
        process.stderr.write(`vaultbase: --snapshot-mode must be 'additive' or 'sync' (got '${String(next)}')\n`);
        process.exit(1);
      }
    }
  }
  return flags;
}

async function setupAdminFromCli(opts: { email: string; password: string; force: boolean }): Promise<void> {
  if (!opts.email || !opts.password) {
    process.stderr.write(`vaultbase: setup-admin requires both --email and --password\n`);
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.email)) {
    process.stderr.write(`vaultbase: --email is not a valid email address\n`);
    process.exit(1);
  }
  if (opts.password.length < 8) {
    process.stderr.write(`vaultbase: --password must be at least 8 characters\n`);
    process.exit(1);
  }
  const db = getDb();
  const { eq } = await import("drizzle-orm");

  // Check globally (any admin) for the no-force guard, AND check whether
  // this specific email exists so --force can UPSERT instead of failing
  // on the UNIQUE(email) constraint.
  const anyAdmin = await db.select({ id: admin.id, email: admin.email }).from(admin).limit(1);
  const sameEmail = await db.select({ id: admin.id }).from(admin).where(eq(admin.email, opts.email)).limit(1);

  if (anyAdmin.length > 0 && !opts.force) {
    process.stderr.write(
      `vaultbase: an admin already exists (${anyAdmin[0]?.email}). ` +
      `Re-run with --force to add another or reset the password of an existing admin.\n`,
    );
    process.exit(1);
  }

  const hash = await Bun.password.hash(opts.password);
  const now = Math.floor(Date.now() / 1000);

  if (sameEmail.length > 0) {
    // Email already taken → reset that admin's password. `password_reset_at`
    // bump invalidates any tokens minted before this update (forced logout).
    await db.update(admin)
      .set({ password_hash: hash, password_reset_at: now })
      .where(eq(admin.email, opts.email));
    // A reset is how an operator gets back in after a lockout: clear it.
    const { clearAttemptFailures } = await import("./core/security.ts");
    await clearAttemptFailures(`email:id:${sameEmail[0]!.id}`);
    process.stdout.write(`vaultbase: admin '${opts.email}' password reset.\n`);
  } else {
    const id = crypto.randomUUID();
    await db.insert(admin).values({
      id, email: opts.email, password_hash: hash, password_reset_at: 0, created_at: now,
    });
    process.stdout.write(`vaultbase: admin '${opts.email}' created.\n`);
  }
}

async function applySnapshotFromCli(path: string, mode: ApplyMode): Promise<void> {
  const f = Bun.file(path);
  if (!(await f.exists())) {
    process.stderr.write(`vaultbase: snapshot file not found: ${path}\n`);
    process.exit(1);
  }
  let raw: string;
  try {
    raw = await f.text();
  } catch (e) {
    process.stderr.write(`vaultbase: cannot read snapshot file ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`vaultbase: snapshot file is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  try {
    const result = await applySnapshot(parsed, { mode });
    const created   = result.created.length;
    const updated   = result.updated.length;
    const unchanged = result.unchanged.length + result.skipped.length;
    console.log(`applied snapshot: ${created} created, ${updated} updated, ${unchanged} unchanged`);
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        process.stderr.write(`vaultbase: snapshot error in collection '${err.collection}': ${err.error}\n`);
      }
      process.exit(1);
    }
  } catch (e) {
    if (e instanceof SnapshotShapeError) {
      process.stderr.write(`vaultbase: invalid snapshot: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

const TOP_LEVEL_HELP = `vaultbase — self-hosted backend in a single binary

Usage:
  vaultbase                       Start the HTTP server (default).
  vaultbase <subcommand> [flags]

Subcommands:
  setup-admin                     Create or reset an admin account
                                  --email <e> --password <p> [--force]

  cluster                         Spawn N worker processes (multi-core deployments)
                                  Set VAULTBASE_WORKERS=N (default: CPU count).

  mcp                             Run the MCP server over stdio.
                                  Connect Claude Desktop / Cursor / Continue / Cline.
                                  --token <vbat_…>           (or VAULTBASE_MCP_TOKEN env)
                                  --read-only                Strip write tools regardless of scope.

  token                           API-token management (mint / list / revoke).
                                  vaultbase token --help for subcommands.

  doctor                          Pre-flight DB checks for v0.11 auth migration.
                                  Read-only; exits non-zero on blockers.

  wipe                            Hard-reset the install (delete data dir).
                                  --yes (perform) [--force] (override prod refusal).

  backup                          Take a snapshot of the SQLite DB.
                                  --to <path>

  update                          Print update status against GitHub releases.

Server flags:
  --apply-snapshot <path>         Apply a snapshot JSON before booting.
                                  --snapshot-mode additive|replace (default additive)

  --help, -h                      Show this help.
  --version, -v                   Print version.

Environment:
  VAULTBASE_DATA_DIR              Data directory (default: ./vaultbase_data)
  VAULTBASE_PORT                  HTTP port (default: 8091)
  VAULTBASE_HOST                  Bind host (default: all interfaces, IPv4 and IPv6)
  VAULTBASE_SETUP_KEY             Key for first-admin setup (default: generated, printed at boot)
  VAULTBASE_ENV_FILE              Env file setup-admin reads (default: /etc/vaultbase/vaultbase.env)
  VAULTBASE_JWT_SECRET            JWT signing secret (default: read from <dataDir>/.secret)
  VAULTBASE_ENCRYPTION_KEY        At-rest key for secrets and encrypted fields (default: <dataDir>/.encryption-key, generated)
  VAULTBASE_WORKERS               Worker count for \`vaultbase cluster\`
  VAULTBASE_TRUSTED_PROXIES       Comma-separated peer IPs trusted for X-Forwarded-For
  NODE_ENV / VAULTBASE_ENV        Triggers production guardrails on \`wipe\`.

Docs: https://docs.vaultbase.dev
`;

async function main() {
  // Top-level help — fast path, no DB / config load.
  if (process.argv[2] === "--help" || process.argv[2] === "-h" || process.argv[2] === "help") {
    process.stdout.write(TOP_LEVEL_HELP);
    return;
  }
  if (process.argv[2] === "--version" || process.argv[2] === "-v" || process.argv[2] === "version") {
    const { VAULTBASE_VERSION } = await import("./core/version.ts");
    process.stdout.write(`vaultbase ${VAULTBASE_VERSION}\n`);
    return;
  }

  // `vaultbase cluster` — spawn N worker processes via the cluster
  // orchestrator. Lazy-import so the cluster module's top-level code (which
  // immediately spawns) only runs when actually requested.
  if (process.argv[2] === "cluster") {
    await import("./cluster.ts");
    return;
  }

  // `vaultbase mcp` — Model Context Protocol server over stdio.
  // Boots a registry of vaultbase tools, gated by the API token's scopes,
  // and serves JSON-RPC 2.0 to AI agents (Claude Desktop, Cursor, etc.)
  // until stdin closes.
  if (process.argv[2] === "mcp") {
    const config = await loadConfig();
    const { runMcpCli } = await import("./scripts/mcp.ts");
    try {
      await runMcpCli(process.argv.slice(3), config.dbPath, config.jwtSecret, config.logsDir, config.uploadDir);
      process.exit(0);
    } catch (e) {
      process.stderr.write(`vaultbase mcp: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
  }

  // `vaultbase doctor` — pre-flight checks for the v0.11 auth-collection
  // migration. Read-only DB inspection; reports blockers + warnings and
  // exits non-zero on blockers so CI / scripts can guard.
  if (process.argv[2] === "doctor") {
    const config = await loadConfig();
    const { runDoctorCli } = await import("./scripts/doctor.ts");
    const code = runDoctorCli(process.argv.slice(3), config.dbPath);
    process.exit(code);
  }

  // `vaultbase wipe` — hard-reset the install. Dry-run by default;
  // refuses on production signals unless `--force`. See scripts/wipe.ts.
  if (process.argv[2] === "wipe") {
    const config = await loadConfig();
    const { runWipeCli } = await import("./scripts/wipe.ts");
    const code = runWipeCli(process.argv.slice(3), config.dataDir);
    process.exit(code);
  }

  // `vaultbase token <subcmd>` — local API-token management. Reads + writes
  // the DB directly, bypassing HTTP. Skips server boot.
  if (process.argv[2] === "token") {
    const config = await loadConfig();
    const { runTokenCli } = await import("./scripts/token.ts");
    try {
      await runTokenCli(process.argv.slice(3), config.dbPath, config.jwtSecret);
      process.exit(0);
    } catch (e) {
      process.stderr.write(`vaultbase token: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
  }

  // `vaultbase update` — self-update. Pulls the latest signed release for
  // the running platform, verifies SHA-256 + cosign sig, atomically
  // replaces the binary. Skips server boot.
  if (process.argv[2] === "update") {
    const { runUpdate } = await import("./scripts/update.ts");
    try {
      await runUpdate(process.argv.slice(3));
      process.exit(0);
    } catch (e) {
      process.stderr.write(`vaultbase update: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
  }

  // `vaultbase backup --to <dest>` — atomic SQLite snapshot + push.
  // Skips server boot entirely so cron / one-shot ops can run alongside
  // a live `vaultbase` daemon (VACUUM INTO is concurrent-safe).
  if (process.argv[2] === "backup") {
    const config = await loadConfig();
    const { runBackup } = await import("./scripts/backup.ts");
    try {
      await runBackup(config.dbPath, process.argv.slice(3));
      process.exit(0);
    } catch (e) {
      process.stderr.write(`vaultbase backup: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
  }

  const flags = parseCliArgs(process.argv.slice(2));
  // `sudo vaultbase setup-admin` used to ignore the service's env file and
  // write the admin into a throwaway ./vaultbase_data in the current dir.
  if (flags.setupAdmin) {
    const envFile = loadServiceEnvFile();
    if (envFile) process.stderr.write(`vaultbase: using settings from ${envFile}\n`);
  }
  const config = await loadConfig();

  // The database: SQLite at the data directory unless VAULTBASE_DATABASE_URL
  // names another (postgres://…). The URL is environment, never a setting:
  // the database has to be open before any setting can be read.
  await initDb(process.env["VAULTBASE_DATABASE_URL"] || `file:${config.dbPath}`);
  await runMigrations();
  const { loadSettings } = await import("./api/settings.ts");
  await loadSettings();

  // CLI sub-command — bootstrap an admin from a script + exit. Skips
  // server boot entirely so headless deploys can configure without ever
  // exposing the web setup wizard.
  if (flags.setupAdmin) {
    await setupAdminFromCli(flags.setupAdmin);
    process.exit(0);
  }

  // Refuse to run with a key that can't read the stored secrets.
  {
    const { encryptionKeyMatchesData } = await import("./api/settings.ts");
    if (!(await encryptionKeyMatchesData())) {
      process.stderr.write(
        "vaultbase: the encryption key does not decrypt the stored secrets. If you set VAULTBASE_ENCRYPTION_KEY, " +
        `set it to the contents of ${config.dataDir}/.encryption-key (or unset it); a lost key can't be recovered.\n`,
      );
      process.exit(1);
    }
  }
  // Secret settings saved before an encryption key existed are still
  // plaintext in data.db (and its backups); encrypt them now.
  try {
    const { encryptPlaintextSecretSettings } = await import("./api/settings.ts");
    const n = await encryptPlaintextSecretSettings();
    if (n > 0) process.stderr.write(`vaultbase: encrypted ${n} secret setting(s) stored in plaintext\n`);
  } catch (e) {
    process.stderr.write(`vaultbase: could not encrypt plaintext secret settings: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  if (flags.applySnapshot) {
    await applySnapshotFromCli(flags.applySnapshot, flags.snapshotMode);
  }

  const db = getDb();
  const rows = await db.select().from(admin).limit(1);
  const adminExists = rows.length > 0;

  // Hooks, routes, jobs and workers as files (vb_hooks/), when set up.
  {
    const { resolveCodeFilesDir, startCodeFiles, codeFileErrors } = await import("./core/code-files.ts");
    const { runsSingletonDuties } = await import("./core/cluster-role.ts");
    const hooksDir = resolveCodeFilesDir(config.dataDir);
    try {
      await startCodeFiles(hooksDir, { isWriter: runsSingletonDuties() });
      if (hooksDir) {
        process.stderr.write(`vaultbase: hooks folder ${hooksDir}\n`);
        for (const e of codeFileErrors()) process.stderr.write(`vaultbase: ${e.path} didn't load: ${e.error}\n`);
      }
    } catch (e) {
      process.stderr.write(`vaultbase: could not start the hooks folder ${hooksDir}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // Move WAL checkpoints off the request thread (see src/db/checkpointer.ts).
  // Only the long-running server needs it; CLI paths above exit first.
  if (db.capabilities.checkpointer) await startCheckpointer(getRawClient(), config.dbPath, JOURNAL_SIZE_LIMIT);

  const server = createServer(config);
  // Read worker threads (src/core/read-pool.ts): record reads on cores minus
  // two threads by default (at least one on two cores or more, at most 8);
  // VAULTBASE_READ_WORKERS sets the count (0 keeps one thread). Never under `vaultbase cluster`, whose processes already
  // use every core, and never for an in-memory database.
  {
    const { readWorkerCount, startReadPool } = await import("./core/read-pool.ts");
    const { availableParallelism } = await import("node:os");
    const n = db.capabilities.readWorkerThreads ? readWorkerCount(process.env, availableParallelism(), config.dbPath) : 0;
    if (n > 0) {
      try {
        // The URL is made here, next to the entry file, so it resolves both in
        // development and inside the compiled binary (see core/read-pool.ts).
        await startReadPool(n, { ...process.env as Record<string, string> }, config, new URL("./read-worker.ts", import.meta.url));
        process.stderr.write(`vaultbase: ${n} read worker thread(s)\n`);
      } catch (e) {
        process.stderr.write(`vaultbase: read workers not started: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    } else if (process.env["VAULTBASE_WORKER_ID"] && process.env["VAULTBASE_READ_WORKERS"]) {
      process.stderr.write("vaultbase: VAULTBASE_READ_WORKERS is ignored under cluster mode\n");
    }
  }
  // Cluster mode: when spawned by `src/cluster.ts`, every worker calls
  // `Bun.serve({ reusePort: true })` so the kernel load-balances incoming
  // connections (SO_REUSEPORT; Linux only — see cluster.ts). Single-process mode behaves exactly as
  // before — no flag, no behavior change.
  const isWorker = !!process.env["VAULTBASE_WORKER_ID"];
  // VAULTBASE_HOST was documented but never read, so the server always
  // listened on every interface. Unset keeps Bun's default (all interfaces,
  // IPv4 and IPv6).
  const hostname = process.env["VAULTBASE_HOST"]?.trim();
  server.listen({
    port: config.port,
    ...(hostname ? { hostname } : {}),
    ...(isWorker ? { reusePort: true } : {}),
    // Keep-alive connections a reverse proxy holds open must outlive the
    // proxy's own idle limit (60 s in the nginx and Caddy configs under
    // deploy/), or the proxy reuses a connection this server already closed
    // and the request fails with "connection reset by peer". Elysia's
    // default is 30 s. Bun allows up to 255.
    idleTimeout: IDLE_TIMEOUT_S,
  });

  // Graceful shutdown: stop taking connections, let in-flight requests
  // finish (up to 10 s), stop background work, flush logs, close the
  // database. A second signal exits at once. The sync drain on `exit` is a
  // last line of defence when the loop is already dead.
  let shuttingDown = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (shuttingDown) process.exit(code);
    shuttingDown = true;
    process.stderr.write(`\nvaultbase: ${reason}, finishing in-flight requests...\n`);
    const outcome = await shutdownGracefully({
      stopServer: () => (server.server as { stop?: (force?: boolean) => unknown } | null)?.stop?.(false),
      cleanup: [
        stopScheduler, stopQueueScheduler, stopWebhookDispatcher, stopBackupScheduler, stopUpdateCheckScheduler,
        // Jobs already running finish (bounded) rather than being re-run after restart.
        () => waitForRunningJobs(10_000),
        () => drainLogBuffer(),
        () => flushGroupCommit(),
        () => stopCheckpointer(),
        async () => { const { stopReadPool } = await import("./core/read-pool.ts"); await stopReadPool(); },
        () => closeDb(),
      ],
      timeoutMs: 10_000,
    });
    if (outcome === "timeout") process.stderr.write("vaultbase: requests still running after 10s; exiting anyway\n");
    process.exit(code);
  };
  onFatal = () => { void shutdown("uncaught exception", 1); };
  process.on("SIGTERM", () => { void shutdown("received SIGTERM", 0); });
  process.on("SIGINT",  () => { void shutdown("received SIGINT", 0);  });
  process.on("exit", () => { drainLogBufferSync(); });

  const base = `http://localhost:${config.port}`;
  if (isClusterWorker() && runsSingletonDuties()) process.stderr.write(CLUSTER_LIMITS_WARNING);


  if (!adminExists) {
    // Setup needs a key; print where to use it. A key from
    // VAULTBASE_SETUP_KEY is the operator's own and isn't echoed.
    const key = requiredSetupKey({ quiet: true });
    const link = setupKeyFromEnv()
      ? `${base}/_/setup  (setup key: VAULTBASE_SETUP_KEY)`
      : `${base}/_/setup#key=${encodeURIComponent(key)}`;
    console.log(
      `\nVaultbase is running at ${base}\n` +
      `No admin exists yet. Create one at:\n  ${link}\n` +
      (setupKeyFromEnv() ? "" : `Setup key: ${key}\n`)
    );
  } else {
    const tag = process.env["VAULTBASE_WORKER_ID"]
      ? ` [worker ${process.env["VAULTBASE_WORKER_ID"]} pid ${process.pid}]`
      : "";
    console.log(`Vaultbase running at ${base}${tag}`);
  }
}

main().catch(console.error);
