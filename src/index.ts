import { loadConfig } from "./config.ts";
import { initDb, getDb } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { admin } from "./db/schema.ts";
import { createServer } from "./server.ts";
import { applySnapshot, SnapshotShapeError, type ApplyMode } from "./core/migrations.ts";
import { drainLogBuffer, drainLogBufferSync } from "./core/file-logger.ts";

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
  const existing = await db.select({ id: admin.id, email: admin.email }).from(admin).limit(1);
  if (existing.length > 0 && !opts.force) {
    process.stderr.write(
      `vaultbase: an admin already exists (${existing[0]?.email}). ` +
      `Re-run with --force to add another, or use the admin UI to manage existing admins.\n`,
    );
    process.exit(1);
  }
  const hash = await Bun.password.hash(opts.password);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.insert(admin).values({ id, email: opts.email, password_hash: hash, password_reset_at: 0, created_at: now });
  process.stdout.write(`vaultbase: admin '${opts.email}' created.\n`);
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

async function main() {
  // `vaultbase cluster` — spawn N worker processes via the cluster
  // orchestrator. Lazy-import so the cluster module's top-level code (which
  // immediately spawns) only runs when actually requested.
  if (process.argv[2] === "cluster") {
    await import("./cluster.ts");
    return;
  }

  const config = await loadConfig();
  const flags = parseCliArgs(process.argv.slice(2));

  initDb(`file:${config.dbPath}`);
  await runMigrations();

  // CLI sub-command — bootstrap an admin from a script + exit. Skips
  // server boot entirely so headless deploys can configure without ever
  // exposing the web setup wizard.
  if (flags.setupAdmin) {
    await setupAdminFromCli(flags.setupAdmin);
    process.exit(0);
  }

  if (flags.applySnapshot) {
    await applySnapshotFromCli(flags.applySnapshot, flags.snapshotMode);
  }

  const db = getDb();
  const rows = await db.select().from(admin).limit(1);
  const adminExists = rows.length > 0;

  const server = createServer(config);
  // Cluster mode: when spawned by `src/cluster.ts`, every worker calls
  // `Bun.serve({ reusePort: true })` so the kernel load-balances incoming
  // connections (SO_REUSEPORT). Single-process mode behaves exactly as
  // before — no flag, no behavior change.
  const isWorker = !!process.env["VAULTBASE_WORKER_ID"];
  server.listen({ port: config.port, ...(isWorker ? { reusePort: true } : {}) });

  // Graceful shutdown: drain the buffered log writer so the last 50ms of
  // entries reach disk before exit. Two layers — async on signals (loop
  // still runs) + sync on `exit` (defensive, loop is dead).
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\nvaultbase: received ${signal}, draining logs...\n`);
    try { await drainLogBuffer(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT");  });
  process.on("exit", () => { drainLogBufferSync(); });

  const base = `http://localhost:${config.port}`;


  if (!adminExists) {
    console.log(
      `\n┌─────────────────────────────────────────────┐\n│  Vaultbase is running at ${base}   │\n│  Set up your admin account:                  │\n│  ${base}/_/setup                  │\n└─────────────────────────────────────────────┘\n`
    );
  } else {
    const tag = process.env["VAULTBASE_WORKER_ID"]
      ? ` [worker ${process.env["VAULTBASE_WORKER_ID"]} pid ${process.pid}]`
      : "";
    console.log(`Vaultbase running at ${base}${tag}`);
  }
}

main().catch(console.error);
