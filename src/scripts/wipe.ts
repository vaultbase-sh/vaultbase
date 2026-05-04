/**
 * `vaultbase wipe` — delete the data directory.
 *
 * Designed for dev / testing — hard-resets a vaultbase install back to a
 * fresh-setup state. Wipes the SQLite DB (+ WAL/SHM siblings), uploads,
 * logs, sandboxes, JWT secret, and encryption key. Next boot triggers
 * the setup-admin wizard.
 *
 * Guardrails:
 *
 *   - Requires `--yes` to actually delete. Without it, the script does a
 *     dry-run that prints what *would* be deleted and exits 0.
 *   - Detects production signals (NODE_ENV / VAULTBASE_ENV / dataDir
 *     paths typical of system-managed installs). On a hit, the script
 *     refuses to run unless `--force` is passed alongside `--yes`.
 *   - Reports the row counts in `vaultbase_users` + `vaultbase_admin` +
 *     auth-collection tables in the dry-run so the operator can see
 *     what's about to disappear.
 *
 * Designed to be safe to type into the wrong terminal — without `--yes`
 * the script never mutates state.
 */

import { existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

interface WipeFlags {
  yes: boolean;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): WipeFlags {
  const out: WipeFlags = { yes: false, force: false, help: false };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const HELP = `Usage: vaultbase wipe [--yes] [--force]

Hard-reset a vaultbase install: delete the data directory entirely. Next
boot triggers the setup-admin wizard.

Wipes:
  <dataDir>/data.db          SQLite database (collections, records, users, admins)
  <dataDir>/data.db-wal      Write-ahead log
  <dataDir>/data.db-shm      Shared-memory file
  <dataDir>/uploads/         Uploaded files
  <dataDir>/logs/            Structured JSONL logs
  <dataDir>/sandboxes/       SQL-runner snapshots
  <dataDir>/.secret          JWT signing secret
  <dataDir>/.encryption-key  Encrypted-at-rest field key

Flags:
  --yes, -y      Actually perform the wipe. Without it the script is a dry-run.
  --force, -f    Bypass the production-environment refusal.
  --help, -h     Show this help.

Examples:
  vaultbase wipe                   # dry-run; reports what would be deleted
  vaultbase wipe --yes             # delete (refuses on detected production)
  vaultbase wipe --yes --force     # delete unconditionally
`;

interface PathInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
  kind: "file" | "directory" | "missing";
}

function inspect(p: string): PathInfo {
  if (!existsSync(p)) {
    return { path: p, exists: false, sizeBytes: 0, kind: "missing" };
  }
  const st = statSync(p);
  if (st.isDirectory()) {
    let total = 0;
    try {
      const walk = (d: string): void => {
        const fs = require("node:fs") as typeof import("node:fs");
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
        }
      };
      walk(p);
    } catch { /* ignore — best-effort sizing */ }
    return { path: p, exists: true, sizeBytes: total, kind: "directory" };
  }
  return { path: p, exists: true, sizeBytes: st.size, kind: "file" };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

interface DbSummary {
  collections: number;
  admins: number;
  users: number;        // sum across all auth collections
  records: number;      // sum across all base collections
}

function summarizeDb(dbPath: string): DbSummary | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, create: false });
    let collections = 0, admins = 0, users = 0, records = 0;
    try { collections = (db.prepare(`SELECT count(*) AS n FROM vaultbase_collections`).get() as { n: number }).n; } catch { /* table missing */ }
    try { admins = (db.prepare(`SELECT count(*) AS n FROM vaultbase_admin`).get() as { n: number }).n; } catch { /* missing */ }

    // Auth collections: per-table count.
    try {
      const cols = db.prepare(`SELECT name, type FROM vaultbase_collections`).all() as Array<{ name: string; type: string }>;
      for (const c of cols) {
        const tbl = `"vb_${c.name.replace(/"/g, '""')}"`;
        try {
          const cnt = (db.prepare(`SELECT count(*) AS n FROM ${tbl}`).get() as { n: number }).n;
          if (c.type === "auth") users += cnt;
          else records += cnt;
        } catch { /* per-table missing — skip */ }
      }
    } catch { /* collections table missing */ }
    return { collections, admins, users, records };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

function detectProductionSignals(dataDir: string): string[] {
  const reasons: string[] = [];
  const env = process.env["NODE_ENV"];
  const vbEnv = process.env["VAULTBASE_ENV"];
  if (env === "production") reasons.push(`NODE_ENV=${env}`);
  if (vbEnv === "production" || vbEnv === "prod") reasons.push(`VAULTBASE_ENV=${vbEnv}`);
  // Path heuristics: system-managed dirs typical of prod deploys.
  const abs = dataDir.replace(/\\/g, "/");
  if (/^\/var\/(lib|opt)\//.test(abs)) reasons.push(`dataDir under /var/(lib|opt)/`);
  if (/^\/opt\//.test(abs)) reasons.push(`dataDir under /opt/`);
  if (/^\/srv\//.test(abs)) reasons.push(`dataDir under /srv/`);
  if (/^\/etc\//.test(abs)) reasons.push(`dataDir under /etc/`);
  // Container-orchestrator hints.
  if (process.env["KUBERNETES_SERVICE_HOST"]) reasons.push(`Kubernetes pod (KUBERNETES_SERVICE_HOST set)`);
  if (process.env["FLY_APP_NAME"]) reasons.push(`Fly.io (FLY_APP_NAME=${process.env["FLY_APP_NAME"]})`);
  if (process.env["RENDER"]) reasons.push(`Render (RENDER=${process.env["RENDER"]})`);
  if (process.env["RAILWAY_ENVIRONMENT"]) reasons.push(`Railway (RAILWAY_ENVIRONMENT=${process.env["RAILWAY_ENVIRONMENT"]})`);
  return reasons;
}

const TARGET_NAMES = [
  "data.db",
  "data.db-wal",
  "data.db-shm",
  "uploads",
  "logs",
  "sandboxes",
  ".secret",
  ".encryption-key",
];

/** CLI entry. Returns the exit code. */
export function runWipeCli(argv: readonly string[], dataDir: string): number {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  process.stdout.write(`vaultbase wipe — target dataDir: ${dataDir}\n\n`);

  if (!existsSync(dataDir)) {
    process.stdout.write(`✓ dataDir doesn't exist — nothing to wipe.\n`);
    return 0;
  }

  // Inventory.
  const targets: PathInfo[] = TARGET_NAMES.map((n) => inspect(join(dataDir, n)));
  const present = targets.filter((t) => t.exists);

  // DB content summary so the operator sees what's about to be lost.
  const summary = summarizeDb(join(dataDir, "data.db"));

  // Production detection.
  const prodReasons = detectProductionSignals(dataDir);

  // ── Report ──────────────────────────────────────────────────────────
  process.stdout.write(`Will delete ${present.length} target(s):\n`);
  for (const t of targets) {
    if (!t.exists) continue;
    process.stdout.write(`  ${t.kind === "directory" ? "📁" : "📄"} ${t.path}  (${fmtBytes(t.sizeBytes)})\n`);
  }
  process.stdout.write("\n");

  if (summary) {
    process.stdout.write(`Database content (will be lost):\n`);
    process.stdout.write(`  ${summary.admins} admin(s)\n`);
    process.stdout.write(`  ${summary.collections} collection(s)\n`);
    process.stdout.write(`  ${summary.users} auth user(s)\n`);
    process.stdout.write(`  ${summary.records} record(s)\n\n`);
  }

  if (prodReasons.length > 0) {
    process.stdout.write(`⚠ PRODUCTION SIGNALS DETECTED:\n`);
    for (const r of prodReasons) process.stdout.write(`  - ${r}\n`);
    process.stdout.write(`\n`);
  }

  // ── Decision ───────────────────────────────────────────────────────
  if (!flags.yes) {
    process.stdout.write(`Dry run — no changes made. Re-run with \`--yes\` to actually delete.\n`);
    if (prodReasons.length > 0) {
      process.stdout.write(`If you do mean to wipe production, you'll also need \`--force\`.\n`);
    }
    return 0;
  }

  if (prodReasons.length > 0 && !flags.force) {
    process.stdout.write(`✖ Refusing to wipe — production signals present. Pass \`--force\` to override.\n`);
    return 2;
  }

  // ── Execute ────────────────────────────────────────────────────────
  let removed = 0;
  for (const t of targets) {
    if (!t.exists) continue;
    try {
      rmSync(t.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      removed++;
      process.stdout.write(`  ✓ removed ${t.path}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`  ✖ failed to remove ${t.path}: ${msg}\n`);
    }
  }
  process.stdout.write(`\n✓ Wipe complete — ${removed}/${present.length} target(s) removed. Restart vaultbase to enter the setup wizard.\n`);
  return 0;
}
