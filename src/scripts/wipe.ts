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
 *
 * On Postgres ({@link runPostgresWipeCli}) the database is the server's
 * schema, which may be shared (`public`): what is dropped is Vaultbase's
 * (tables, views and sequences named `vaultbase_*` / `vb_*`, its `vb_*`
 * functions), the schemas restores kept, and the install's read-only
 * login. Anything else in the schema stays and is listed; the schema stays.
 * Refused while a server runs on the schema, when the data directory
 * doesn't record the database (both overridden by --force), and, changing
 * nothing, when the database role doesn't own what would be dropped,
 * something else depends on it (in any schema), or something that isn't
 * Vaultbase's would go with it (a partition, a sequence owned by a column).
 */

import { existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { db, getDriver } from "../db/index.ts";
import { MigrationLockBusy, PostgresDriver } from "../db/postgres.ts";
import { peerChannel } from "../core/peers.ts";
import { restoreSchemas } from "../core/pg-restore.ts";

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
  <dataDir>/database.json    Which database the install runs on

On Postgres (VAULTBASE_DATABASE_URL set), instead of the database files:
  Vaultbase's tables, views, sequences and functions in the server's schema,
  the schemas restores kept, and the install's read-only login. Anything
  else in the schema stays, and so does the schema. Refused while a server
  runs on the schema (stop it first, or pass --force).

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
  "database.json",
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

// ── Postgres ────────────────────────────────────────────────────────────────

/** The data directory's files on Postgres: no database file to delete (a data.db there isn't this install's). */
const PG_TARGET_NAMES = TARGET_NAMES.filter((n) => !n.startsWith("data.db"));

const DROP_LOCK_TIMEOUT = "15s";

interface PgObject {
  /** DROP <kind> */
  kind: string;
  /** Schema-qualified and quoted, with its argument types for a function. */
  name: string;
  /** The name alone, for messages. */
  short: string;
  schema: string;
  mine: boolean;
  ours: boolean;
  /** pg_class oid, for relations. */
  rel: number | null;
}

interface PgInventory {
  database: string;
  schema: string;
  objects: PgObject[];
  /** Objects in the schema that aren't Vaultbase's: left in place. */
  others: string[];
  /** Objects that aren't Vaultbase's but would go with one: a partition, a sequence owned by its column. */
  dragged: string[];
  kept: string[];
  role: string | null;
  servers: number;
  /** Other connections whose activity this role can't see. */
  hidden: number;
  summary: DbSummary | null;
}

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

const isOurs = (name: string) => name.startsWith("vaultbase_") || name.startsWith("vb_");

/**
 * The objects of `schema` a DROP names: relations, functions and standalone
 * types. Extension members stay out, and so do sequences owned by a column
 * and a range type's multirange and constructors, which go with their owner.
 * `allOurs`: a schema a restore kept, which is Vaultbase's throughout.
 */
async function schemaObjects(schema: string, allOurs: boolean): Promise<PgObject[]> {
  const rows = await db.all<{ kind: string; name: string; short: string; mine: boolean; rel: string | null }>(
    `WITH n AS (SELECT oid, nspname FROM pg_namespace WHERE nspname = ?)
     SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
                           WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
            format('%I.%I', (SELECT nspname FROM n), c.relname) AS name, c.relname AS short,
            pg_has_role(c.relowner, 'MEMBER') AS mine, c.oid::int8 AS rel
       FROM pg_class c
      WHERE c.relnamespace = (SELECT oid FROM n) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                         AND (d.deptype = 'e' OR (c.relkind = 'S' AND d.deptype IN ('a', 'i'))))
     UNION ALL
     SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
            format('%I.%I(%s)', (SELECT nspname FROM n), p.proname,
                   CASE WHEN p.prokind = 'a' AND pg_get_function_identity_arguments(p.oid) = '' THEN '*'
                        ELSE pg_get_function_identity_arguments(p.oid) END),
            p.proname, pg_has_role(p.proowner, 'MEMBER'), NULL
       FROM pg_proc p
      WHERE p.pronamespace = (SELECT oid FROM n)
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype IN ('e', 'i'))
     UNION ALL
     SELECT CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, format('%I.%I', (SELECT nspname FROM n), t.typname),
            t.typname, pg_has_role(t.typowner, 'MEMBER'), NULL
       FROM pg_type t
      WHERE t.typnamespace = (SELECT oid FROM n)
        AND (t.typtype IN ('d', 'e', 'r') OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class r WHERE r.oid = t.typrelid AND r.relkind = 'c')))
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype IN ('e', 'i'))
     ORDER BY 3`,
    [schema],
  );
  // Functions and types aren't Vaultbase's unless named vb_ (vb_search_text);
  // relations named vaultbase_* or vb_* are.
  return rows.map((r) => ({
    kind: r.kind, name: r.name, short: r.short, schema, mine: r.mine,
    ours: allOurs || (r.kind === "TYPE" || r.kind === "DOMAIN" ? false : r.kind.endsWith("FUNCTION") || r.kind === "PROCEDURE" || r.kind === "AGGREGATE" ? r.short.startsWith("vb_") : isOurs(r.short)),
    rel: r.rel === null ? null : Number(r.rel),
  }));
}

/**
 * What a DROP of `relations` takes with it although it isn't in the set:
 * partitions attached to them, and sequences owned by their columns. Neither
 * is a dependency RESTRICT refuses on. A sequence of Vaultbase's own (in
 * `schema`, named like it) or anything in a kept schema is expected.
 */
async function draggedObjects(relations: number[], schema: string, kept: string[]): Promise<string[]> {
  if (relations.length === 0) return [];
  const set = `ARRAY[${relations.map((n) => Math.trunc(n)).join(",")}]::oid[]`;
  const rows = await db.all<{ nsp: string; rel: string; oid: string }>(
    `SELECT n.nspname AS nsp, c.relname AS rel, c.oid::int8 AS oid
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.inhparent = ANY(${set})
     UNION
     SELECT n.nspname, s.relname, s.oid::int8
       FROM pg_depend d JOIN pg_class s ON s.oid = d.objid JOIN pg_namespace n ON n.oid = s.relnamespace
      WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND s.relkind = 'S'
        AND d.deptype IN ('a', 'i') AND d.refobjid = ANY(${set})`,
  );
  const inSet = new Set(relations);
  return rows
    .filter((r) => !inSet.has(Number(r.oid)) && !kept.includes(r.nsp) && !(r.nsp === schema && isOurs(r.rel)))
    .map((r) => `${qi(r.nsp)}.${qi(r.rel)}`);
}

async function pgInventory(): Promise<PgInventory> {
  const where = await db.get<{ d: string; s: string | null }>(`SELECT current_database() AS d, current_schema() AS s`);
  if (!where?.s) throw new Error("the search path names no schema that exists: nothing to wipe");
  const schema = where.s;
  const live = await schemaObjects(schema, false);
  const kept = await restoreSchemas();
  const objects = live.filter((o) => o.ours);
  for (const k of kept) objects.push(...await schemaObjects(k, true));
  const role = await db.get<{ name: string }>(
    `SELECT r.rolname AS name FROM pg_roles r
      WHERE r.rolname = 'vb_ro_' || left(md5(current_database() || '/' || current_schema()), 16)
        AND shobj_description(r.oid, 'pg_authid') = 'Vaultbase read-only login for ' || current_database() || '/' || current_schema()`,
  );
  // A server listens on its schema's channel (core/peers.ts) on a connection
  // of its own; another role's connections show no query text to a role
  // that isn't a superuser or pg_read_all_stats.
  const channel = peerChannel(schema);
  const activity = await db.get<{ servers: number; hidden: number }>(
    `SELECT count(*) FILTER (WHERE query IN (?, ?))::int AS servers,
            count(*) FILTER (WHERE query = '<insufficient privilege>')::int AS hidden
       FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    [`LISTEN ${qi(channel)}`, `LISTEN ${channel}`],
  );
  return {
    database: where.d,
    schema,
    objects,
    others: live.filter((o) => !o.ours).map((o) => `${o.kind.toLowerCase()} ${o.short}`),
    dragged: await draggedObjects(objects.flatMap((o) => (o.rel === null ? [] : [o.rel])), schema, kept),
    kept,
    role: role?.name ?? null,
    servers: activity?.servers ?? 0,
    hidden: activity?.hidden ?? 0,
    summary: await pgSummary(),
  };
}

async function pgSummary(): Promise<DbSummary | null> {
  const has = async (t: string) => (await db.all(db.dialect.listColumnsSql(t))).length > 0;
  if (!(await has("vaultbase_collections"))) return null;
  const count = async (t: string) => Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM ${qi(t)}`))?.n ?? 0);
  let admins = 0, users = 0, records = 0;
  if (await has("vaultbase_admin")) admins = await count("vaultbase_admin");
  const cols = await db.all<{ name: string; type: string }>(`SELECT name, type FROM vaultbase_collections`);
  for (const c of cols) {
    const t = `vb_${c.name}`;
    if (c.type === "view" || !(await has(t))) continue;
    if (c.type === "auth") users += await count(t);
    else records += await count(t);
  }
  return { collections: cols.length, admins, users, records };
}

/**
 * Drop `objects`, then the emptied `kept` schemas, in one transaction. Each
 * object is dropped on its own (RESTRICT), in passes: one that another still
 * needs waits for the next pass, so the order among Vaultbase's own doesn't
 * matter, and one that something else needs (a view or a foreign key of
 * yours, in any schema) is never dropped: the whole wipe is refused.
 */
async function dropAll(objects: PgObject[], kept: string[]): Promise<void> {
  await db.transaction(async () => {
    await db.exec(`SET LOCAL lock_timeout = '${DROP_LOCK_TIMEOUT}'`);
    let left = objects;
    while (left.length > 0) {
      const next: PgObject[] = [];
      const why: string[] = [];
      for (const o of left) {
        try {
          await db.savepoint(async () => { await db.exec(`DROP ${o.kind} IF EXISTS ${o.name} RESTRICT`); });
        } catch (e) {
          if ((e as { errno?: unknown }).errno !== "2BP01") throw e;
          next.push(o);
          const detail = (e as { detail?: string }).detail ?? (e instanceof Error ? e.message : String(e));
          why.push(...detail.split("\n"));
        }
      }
      if (next.length === left.length) throw new Error(`other objects depend on Vaultbase's: ${blockers(why, left)}. Drop or move them first`);
      left = next;
    }
    for (const schema of kept) await db.exec(`DROP SCHEMA IF EXISTS ${qi(schema)} RESTRICT`);
  });
}

/**
 * The lines of DETAIL ("view x depends on table y") that name a dependent
 * outside `stuck`, which are the ones to act on; the rest are Vaultbase's
 * objects waiting on each other.
 */
function blockers(lines: string[], stuck: PgObject[]): string {
  const names = new Set(stuck.map((o) => o.short));
  const unique = [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
  const outside = unique.filter((l) => {
    const dependent = /^\S+(?: \S+)? (\S+) depends on /.exec(l)?.[1];
    return !dependent || !names.has(dependent.replace(/^.*\./, "").replace(/"/g, ""));
  });
  const shown = (outside.length > 0 ? outside : unique).slice(0, 3);
  return shown.join("; ");
}

/** Drop the install's read-only login. Returns why it couldn't be, or null. */
async function dropReadOnlyLogin(role: string, schema: string, database: string): Promise<string | null> {
  const r = qi(role);
  // What the server granted it: SELECT on every table in the schema,
  // the user's own included, USAGE, CONNECT and default privileges.
  for (const sql of [
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${qi(schema)} FROM ${r}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${qi(schema)} FROM ${r}`,
    `REVOKE ALL ON SCHEMA ${qi(schema)} FROM ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${qi(schema)} REVOKE ALL ON TABLES FROM ${r}`,
    `REVOKE CONNECT ON DATABASE ${qi(database)} FROM ${r}`,
  ]) {
    try { await db.exec(sql); } catch { /* DROP ROLE says what's left */ }
  }
  try {
    await db.exec(`DROP ROLE ${r}`);
    return null;
  } catch (e) {
    const detail = (e as { detail?: string }).detail;
    return (e instanceof Error ? e.message : String(e)) + (detail ? `: ${detail.split("\n").slice(0, 3).join("; ")}` : "");
  }
}

/**
 * `vaultbase wipe` on Postgres, on the open database. Returns the exit code:
 * 0 done (or a dry run), 1 refused or failed with nothing dropped, 2 refused
 * on production signals, running servers, or a data directory that doesn't
 * record this database (each overridden by --force).
 */
export async function runPostgresWipeCli(argv: readonly string[], dataDir: string): Promise<number> {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const inv = await pgInventory();
  process.stdout.write(`vaultbase wipe — Postgres database ${inv.database}, schema ${inv.schema}; dataDir: ${dataDir}\n\n`);

  const targets = existsSync(dataDir) ? PG_TARGET_NAMES.map((n) => inspect(join(dataDir, n))) : [];
  const present = targets.filter((t) => t.exists);
  const live = inv.objects.filter((o) => o.schema === inv.schema);
  const kinds = new Map<string, number>();
  for (const o of live) kinds.set(o.kind.toLowerCase(), (kinds.get(o.kind.toLowerCase()) ?? 0) + 1);

  process.stdout.write(`Will drop from schema ${inv.schema}:\n`);
  if (live.length === 0) process.stdout.write(`  (no Vaultbase objects)\n`);
  for (const [kind, n] of kinds) process.stdout.write(`  ${n} ${kind}(s)\n`);
  for (const k of inv.kept) process.stdout.write(`  schema ${k} (kept by a restore)\n`);
  if (inv.role) process.stdout.write(`  role ${inv.role} (the read-only login)\n`);
  process.stdout.write(`\nWill delete ${present.length} target(s):\n`);
  for (const t of present) {
    process.stdout.write(`  ${t.kind === "directory" ? "📁" : "📄"} ${t.path}  (${fmtBytes(t.sizeBytes)})\n`);
  }
  process.stdout.write("\n");
  if (inv.summary) {
    process.stdout.write(`Database content (will be lost):\n`);
    process.stdout.write(`  ${inv.summary.admins} admin(s)\n`);
    process.stdout.write(`  ${inv.summary.collections} collection(s)\n`);
    process.stdout.write(`  ${inv.summary.users} auth user(s)\n`);
    process.stdout.write(`  ${inv.summary.records} record(s)\n\n`);
  }
  if (inv.others.length > 0) {
    const shown = inv.others.slice(0, 10).join(", ") + (inv.others.length > 10 ? `, and ${inv.others.length - 10} more` : "");
    process.stdout.write(`Left in place (not Vaultbase's): ${shown}\n\n`);
  }
  if (inv.dragged.length > 0) {
    const shown = inv.dragged.slice(0, 10).join(", ") + (inv.dragged.length > 10 ? `, and ${inv.dragged.length - 10} more` : "");
    process.stdout.write(`⚠ Not Vaultbase's, but would go with its tables (partitions, sequences owned by their columns): ${shown}. Detach or drop them first.\n\n`);
  }

  // The marker says the schema is this data directory's install; without
  // it, a URL naming someone else's database would pass every other check.
  const unrecorded = !existsSync(join(dataDir, "database.json")) && (inv.summary?.admins ?? 0) > 0;
  if (unrecorded) {
    process.stdout.write(`⚠ This data directory has no database.json: nothing records that schema ${inv.schema} is its install's. Check VAULTBASE_DATABASE_URL.\n\n`);
  }
  if (inv.hidden > 0) {
    process.stdout.write(`⚠ ${inv.hidden} other connection(s) belong to roles whose activity this one can't see: make sure no Vaultbase server is running on this schema.\n\n`);
  }
  const prodReasons = detectProductionSignals(dataDir);
  if (prodReasons.length > 0) {
    process.stdout.write(`⚠ PRODUCTION SIGNALS DETECTED:\n`);
    for (const r of prodReasons) process.stdout.write(`  - ${r}\n`);
    process.stdout.write(`\n`);
  }
  if (inv.servers > 0) {
    process.stdout.write(`⚠ ${inv.servers} Vaultbase server(s) are running on this schema. Stop them first.\n\n`);
  }

  if (!flags.yes) {
    process.stdout.write(`Dry run — no changes made. Re-run with \`--yes\` to actually delete.\n`);
    if (prodReasons.length > 0 || inv.servers > 0 || unrecorded) {
      process.stdout.write(`If you do mean to wipe it anyway, you'll also need \`--force\`.\n`);
    }
    return 0;
  }
  if ((prodReasons.length > 0 || inv.servers > 0 || unrecorded) && !flags.force) {
    const why = prodReasons.length > 0 ? "production signals present"
      : inv.servers > 0 ? "servers are running on it"
      : "the data directory doesn't record this database";
    process.stdout.write(`✖ Refusing to wipe — ${why}. Pass \`--force\` to override.\n`);
    return 2;
  }
  if (inv.dragged.length > 0) {
    process.stderr.write(`✖ Objects that aren't Vaultbase's would be dropped with its tables (listed above). Nothing changed.\n`);
    return 1;
  }
  const theirs = inv.objects.filter((o) => !o.mine).map((o) => o.name);
  if (theirs.length > 0) {
    const shown = theirs.slice(0, 5).join(", ") + (theirs.length > 5 ? `, and ${theirs.length - 5} more` : "");
    process.stderr.write(`✖ The database role doesn't own ${shown}; drop them as their owner, or run wipe as it. Nothing changed.\n`);
    return 1;
  }

  const driver = getDriver();
  try {
    if (!(driver instanceof PostgresDriver)) throw new Error("not on Postgres");
    await driver.withMigrationLock(() => dropAll(inv.objects, inv.kept), { wait: false });
  } catch (e) {
    const code = (e as { errno?: unknown }).errno;
    const why = e instanceof MigrationLockBusy
      ? "another server is migrating or restoring this schema"
      : code === "55P03" || code === "40P01"
        ? "another connection is using its tables (a running server?)"
        : e instanceof Error ? e.message : String(e);
    process.stderr.write(`✖ Couldn't drop the database objects: ${why}. Nothing changed.\n`);
    return 1;
  }
  process.stdout.write(`  ✓ dropped ${live.length} object(s)${inv.kept.length ? ` and ${inv.kept.length} kept schema(s)` : ""} from ${inv.database}\n`);
  if (inv.role) {
    const failed = await dropReadOnlyLogin(inv.role, inv.schema, inv.database);
    if (failed) process.stderr.write(`  ⚠ couldn't drop the role ${inv.role} (${failed}); drop it as a superuser: DROP OWNED BY ${qi(inv.role)}; DROP ROLE ${qi(inv.role)};\n`);
    else process.stdout.write(`  ✓ dropped role ${inv.role}\n`);
  }

  let removed = 0;
  for (const t of present) {
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
