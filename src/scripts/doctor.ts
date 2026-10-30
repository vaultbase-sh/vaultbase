/**
 * `vaultbase doctor` — on SQLite, pre-flight checks for the v0.11
 * auth-collection migration; on Postgres, {@link runPostgresDoctor}.
 *
 * SQLite: checks for the v0.11 auth-collection
 * migration. Reports on anything that would block or silently lose data,
 * exits non-zero if a blocker is present so CI / scripts can guard.
 *
 * Checks:
 *   - Custom field name collisions with auth columns (email, password_hash,
 *     ...) per auth collection. Blocker: rename the field first.
 *   - Stranded rows in `vb_<auth-col>` lacking email/password — typically
 *     hand-INSERTed via run_sql or CSV import. Blocker: drop or migrate
 *     manually before the auth-table swap.
 *   - Duplicate emails within an auth collection (would break the new
 *     UNIQUE index). Blocker: reconcile.
 *   - JSON `data` keys on `vaultbase_users` that don't map to any custom
 *     field. Warning: data lost on migration unless field added.
 *
 * Read-only — never mutates state. Just inspects.
 */

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { db, getDriver } from "../db/index.ts";
import { missingFixedSchema } from "../db/ddl.ts";
import { pgDumpBinary } from "../core/backups.ts";
import { restoreSchemas, restoreTools } from "../core/pg-restore.ts";
import { databaseCodeError } from "../core/code-loader.ts";

export const DOCTOR_HELP = `Usage: vaultbase doctor

Read-only checks of the install's database. Exits 1 when something blocks
the server, 0 otherwise (warnings included), 2 when the database can't be read.

SQLite: what would block the v0.11 auth-collection migration.
Postgres (VAULTBASE_DATABASE_URL set): the server version, the schema and
search path, whether the schema is up to date, pg_dump / pg_restore / psql
for backups and restore, the rights restore needs, and enabled hooks,
routes, jobs and workers that use helpers.db.
`;

interface DoctorIssue {
  level: "blocker" | "warning";
  collection: string;
  message: string;
}

const AUTH_RESERVED_NAMES = new Set([
  "email", "password_hash", "email_verified", "totp_secret",
  "totp_enabled", "is_anonymous", "password_reset_at",
]);

export interface DoctorReport {
  blockers: DoctorIssue[];
  warnings: DoctorIssue[];
  ok: boolean;
}

export function runDoctor(dbPath: string): DoctorReport {
  const db = new Database(dbPath, { readonly: true, create: false });
  const blockers: DoctorIssue[] = [];
  const warnings: DoctorIssue[] = [];

  try {
    // No legacy auth state? Doctor is always green for fresh installs.
    const usersExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vaultbase_users'`,
    ).get() as { name: string } | undefined;
    const collectionsExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vaultbase_collections'`,
    ).get() as { name: string } | undefined;
    if (!collectionsExists) return { blockers, warnings, ok: true };

    const authCols = db.prepare(
      `SELECT id, name, fields FROM vaultbase_collections WHERE type='auth'`,
    ).all() as Array<{ id: string; name: string; fields: string }>;

    for (const col of authCols) {
      let fields: Array<{ name?: unknown; implicit?: unknown; system?: unknown; type?: unknown }> = [];
      try { fields = JSON.parse(col.fields || "[]") as typeof fields; } catch { /* skip */ }
      const customNames = new Set(
        fields
          .filter((f) => typeof f.name === "string" && !f.implicit && !f.system && f.type !== "autodate")
          .map((f) => f.name as string),
      );

      // 1. Reserved name collision.
      for (const name of customNames) {
        if (AUTH_RESERVED_NAMES.has(name)) {
          blockers.push({
            level: "blocker",
            collection: col.name,
            message: `custom field '${name}' collides with the reserved auth column. Rename via the schema editor before migrating.`,
          });
        }
      }

      // 2. Stranded rows in vb_<col>.
      const tbl = `vb_${col.name}`;
      const tblExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      ).get(tbl) as { name: string } | undefined;
      if (tblExists) {
        const cnt = (db.prepare(`SELECT count(*) AS n FROM "${tbl.replace(/"/g, '""')}"`).get() as { n: number })?.n ?? 0;
        if (cnt > 0) {
          // Determine if these rows are pre-migration shape (no email column
          // yet) or stranded data (email column present but NULL).
          const cols = db.prepare(`PRAGMA table_info("${tbl.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
          const colNames = new Set(cols.map((c) => c.name));
          if (!colNames.has("email")) {
            blockers.push({
              level: "blocker",
              collection: col.name,
              message: `${tbl} contains ${cnt} row(s) but lacks the auth columns. Pre-v0.11 stranded data. Inspect via the SQL runner; either drop the rows or re-create them via the auth signup flow before migrating.`,
            });
          } else {
            const orphans = (db.prepare(`SELECT count(*) AS n FROM "${tbl.replace(/"/g, '""')}" WHERE email IS NULL OR password_hash IS NULL`).get() as { n: number })?.n ?? 0;
            if (orphans > 0) {
              blockers.push({
                level: "blocker",
                collection: col.name,
                message: `${tbl} has ${orphans} row(s) with NULL email or password_hash. Migration won't fabricate credentials; drop those rows or fix them first.`,
              });
            }
          }
        }
      }

      // 2b. Own fields that are NOT NULL in the table (made required with
      // the collection, before 0.31.1): users made without them (guest and
      // OAuth sign-up, invitations) fail. SQLite can't drop the constraint
      // in place, so the field has to be moved to a new column.
      if (tblExists) {
        // Not autodate: sign-up sets one made on create.
        const own = new Set(fields.filter((f) => typeof f.name === "string" && !f.implicit && !f.system && f.type !== "autodate").map((f) => f.name as string));
        const strict = (db.prepare(`PRAGMA table_info("${tbl.replace(/"/g, '""')}")`).all() as Array<{ name: string; notnull: number }>)
          .filter((c) => c.notnull === 1 && own.has(c.name))
          .map((c) => c.name);
        if (strict.length > 0) {
          warnings.push({
            level: "warning",
            collection: col.name,
            message: `${strict.map((n) => `'${n}'`).join(", ")} can't be empty in ${tbl}, so guest sign-up, OAuth sign-up and invitations fail with an error. Move each to a new field (see "Required fields made before 0.31.1" in the authentication docs).`,
          });
        }
      }

      // 3. Duplicate emails in vaultbase_users for this collection.
      if (usersExists) {
        const dups = (db.prepare(
          `SELECT email, count(*) AS n FROM vaultbase_users
           WHERE collection_id = ? GROUP BY email HAVING n > 1 LIMIT 10`,
        ).all(col.id) as Array<{ email: string; n: number }>);
        for (const d of dups) {
          blockers.push({
            level: "blocker",
            collection: col.name,
            message: `duplicate email '${d.email}' x${d.n} in vaultbase_users — UNIQUE index on the per-collection table will reject this.`,
          });
        }

        // 4. JSON `data` keys not mapped to any custom field.
        try {
          const rows = db.prepare(
            `SELECT data FROM vaultbase_users WHERE collection_id = ? LIMIT 200`,
          ).all(col.id) as Array<{ data: string }>;
          const seen = new Set<string>();
          for (const r of rows) {
            try {
              const parsed = JSON.parse(r.data || "{}") as Record<string, unknown>;
              for (const k of Object.keys(parsed)) seen.add(k);
            } catch { /* skip */ }
          }
          for (const k of seen) {
            if (!customNames.has(k)) {
              warnings.push({
                level: "warning",
                collection: col.name,
                message: `JSON key '${k}' present in vaultbase_users.data but no matching custom field on the collection. Will be dropped on migration unless you add a field.`,
              });
            }
          }
        } catch { /* shrug */ }
      }
    }
  } finally {
    db.close();
  }

  return { blockers, warnings, ok: blockers.length === 0 };
}

/** CLI entry point. Returns the exit code (0 ok, 1 blockers found). */
export function runDoctorCli(_argv: readonly string[], dbPath: string): number {
  if (!existsSync(dbPath)) {
    process.stderr.write(`vaultbase doctor: no database at ${dbPath} (set VAULTBASE_DATA_DIR to the install's data directory)\n`);
    return 2;
  }
  let report: DoctorReport;
  try {
    report = runDoctor(dbPath);
  } catch (e) {
    process.stderr.write(`vaultbase doctor: couldn't read ${dbPath}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (report.ok && report.warnings.length === 0) {
    process.stdout.write("✓ vaultbase doctor — clean. v0.11 migration is safe.\n");
    return 0;
  }
  if (report.blockers.length > 0) {
    process.stdout.write(`\n✖ ${report.blockers.length} blocker(s):\n`);
    for (const i of report.blockers) {
      process.stdout.write(`  [${i.collection}] ${i.message}\n`);
    }
  }
  if (report.warnings.length > 0) {
    process.stdout.write(`\n⚠ ${report.warnings.length} warning(s):\n`);
    for (const i of report.warnings) {
      process.stdout.write(`  [${i.collection}] ${i.message}\n`);
    }
  }
  if (!report.ok) {
    process.stdout.write("\nFix the blockers, then re-run `vaultbase doctor`.\n");
    return 1;
  }
  process.stdout.write("\nWarnings are advisory — migration will proceed. Address them if the dropped data matters.\n");
  return 0;
}

// ── Postgres ────────────────────────────────────────────────────────────────

export interface PostgresDoctorReport {
  /** Server version and where the database is. */
  about: string;
  blockers: string[];
  warnings: string[];
  ok: boolean;
}

/**
 * Whether a connection URL points at this machine: localhost, a loopback
 * address, or a Unix socket (`host=/path`), where an unencrypted connection
 * never crosses a network.
 */
export function isLocalUrl(url: string): boolean {
  // A socket URL has no host before the path (`user:pass@/db?host=/run`),
  // which URL refuses; its host= parameter says where it connects.
  const param = /[?&]host=([^&#]*)/i.exec(url)?.[1];
  let host = param ? decodeURIComponent(param) : "";
  if (!host) {
    try {
      host = decodeURIComponent(new URL(url).hostname);
    } catch {
      return false;
    }
  }
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "" || host.startsWith("/") || host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** Oldest Postgres the server runs on. */
const MIN_SERVER_MAJOR = 16;

/** The release of each major that made pg_dump write `\restrict` (August 2025); restore requires it. */
const RESTRICT_SINCE: Record<number, number> = { 13: 22, 14: 19, 15: 14, 16: 10, 17: 6 };

interface ToolVersion { major: number; minor: number; text: string }

async function toolVersion(bin: string): Promise<ToolVersion | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(out);
    return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0), text: `${m[1]}${m[2] !== undefined ? `.${m[2]}` : ""}` } : null;
  } catch {
    return null;
  }
}

function writesRestrict(v: ToolVersion): boolean {
  const since = RESTRICT_SINCE[v.major];
  return v.major >= 18 || (since !== undefined && v.minor >= since);
}

/**
 * Checks for a Postgres install, on the open database: the server version,
 * the schema the server works in and what else its search path names, the
 * fixed schema, the client tools backups and restore need, the rights
 * restore needs, and stored code that uses helpers.db. Reads only.
 */
export async function runPostgresDoctor(): Promise<PostgresDoctorReport> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const info = await db.get<{ v: number; ver: string; d: string; s: string | null; path: string[]; can_create: boolean }>(
    `SELECT current_setting('server_version_num')::int AS v, current_setting('server_version') AS ver,
            current_database() AS d, current_schema() AS s, current_schemas(false) AS path,
            has_database_privilege(current_database(), 'CREATE') AS can_create`,
  );
  if (!info) throw new Error("the server didn't answer");
  const serverMajor = Math.floor(info.v / 10_000);
  const about = `Postgres ${info.ver.split(" ")[0]}, database ${info.d}, schema ${info.s ?? "(none)"}`;
  if (serverMajor < MIN_SERVER_MAJOR) {
    blockers.push(`Postgres ${serverMajor} is too old: Vaultbase needs ${MIN_SERVER_MAJOR} or later.`);
  }
  if (!info.s) {
    blockers.push("the search path names no schema that exists: create the schema, or fix search_path in VAULTBASE_DATABASE_URL (options=-c search_path=...).");
    return { about, blockers, warnings, ok: false };
  }
  const tls = await db.get<{ ssl: boolean | null }>(`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`);
  if (tls && tls.ssl === false && !isLocalUrl((getDriver() as unknown as { url: string }).url)) {
    warnings.push(
      "the connection to the database isn't encrypted. Add ?sslmode=require to VAULTBASE_DATABASE_URL "
      + "(or sslmode=verify-full to also check the certificate); without sslmode, Bun's driver doesn't use TLS even when the server offers it.",
    );
  }
  const others = (info.path ?? []).filter((n) => n !== info.s);
  if (others.length > 0) {
    warnings.push(
      `the search path also names ${others.join(", ")}: a table missing from ${info.s} is read from there. `
      + `Set the search path to the one schema (options=-c search_path=${info.s} in VAULTBASE_DATABASE_URL).`,
    );
  }

  const installed = (await db.all(db.dialect.listColumnsSql("vaultbase_collections"))).length > 0;
  if (!installed) {
    warnings.push(`schema ${info.s} has no Vaultbase tables yet: the first start creates them.`);
  } else {
    const missing = await missingFixedSchema();
    if (missing.length > 0) {
      const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? `, and ${missing.length - 5} more` : "");
      warnings.push(`the schema is behind this version (${shown}): the next start adds what's missing.`);
    }
    for (const table of ["vaultbase_hooks", "vaultbase_routes", "vaultbase_jobs", "vaultbase_workers"]) {
      // Not there yet, or without a column read here: the next start adds it.
      if (missing.includes(table) || ["name", "code", "origin", "enabled"].some((c) => missing.includes(`${table}.${c}`))) continue;
      const rows = await db.all<{ name: string; code: string; origin: string }>(
        `SELECT name, code, origin FROM ${table} WHERE enabled = 1`,
      );
      for (const r of rows) {
        if (databaseCodeError(r.code, r.origin === "file")) {
          warnings.push(`${table.slice("vaultbase_".length, -1)} '${r.name}' uses helpers.db, which fails on Postgres when it runs: change it to helpers.sql.`);
        }
      }
    }
    const kept = await restoreSchemas();
    if (kept.length > 0) {
      warnings.push(`${kept.length} schema(s) kept by restores (${kept.join(", ")}): previous data, dropped after 7 days or from the backups page.`);
    }
  }

  const dumpBin = pgDumpBinary();
  const dump = dumpBin ? await toolVersion(dumpBin) : null;
  if (!dumpBin) {
    warnings.push("pg_dump not found: backups are unavailable. Install a PostgreSQL client, or set VAULTBASE_PG_DUMP.");
  } else if (dump && dump.major < serverMajor) {
    warnings.push(`pg_dump ${dump.text} can't dump a Postgres ${serverMajor} server: backups fail. Install a client of version ${serverMajor} or newer.`);
  }
  const tools = restoreTools();
  if (!tools) {
    warnings.push("pg_restore or psql not found: restore is unavailable. Install a PostgreSQL client, or set VAULTBASE_PG_RESTORE and VAULTBASE_PSQL.");
  } else {
    const restore = await toolVersion(tools.pgRestore);
    if (restore && !writesRestrict(restore)) {
      warnings.push(`pg_restore ${restore.text} is too old for restore, which needs a client from August 2025 or later (17.6, 16.10, 15.14, 14.19, 18 or later).`);
    } else if (restore && dump && restore.major < dump.major) {
      warnings.push(`pg_restore ${restore.text} can't read archives from pg_dump ${dump.text}: use one client version for both.`);
    }
    if (!info.can_create) {
      warnings.push(`the server's role can't create schemas in database ${info.d}: restore stages the archive in a new schema. GRANT CREATE ON DATABASE to it.`);
    }
  }
  return { about, blockers, warnings, ok: blockers.length === 0 };
}

/** CLI output for {@link runPostgresDoctor}. Returns the exit code (0 ok, 1 blockers found). */
export async function runPostgresDoctorCli(): Promise<number> {
  const report = await runPostgresDoctor();
  process.stdout.write(`vaultbase doctor — ${report.about}\n`);
  if (report.ok && report.warnings.length === 0) {
    process.stdout.write("✓ clean.\n");
    return 0;
  }
  if (report.blockers.length > 0) {
    process.stdout.write(`\n✖ ${report.blockers.length} blocker(s):\n`);
    for (const b of report.blockers) process.stdout.write(`  ${b}\n`);
  }
  if (report.warnings.length > 0) {
    process.stdout.write(`\n⚠ ${report.warnings.length} warning(s):\n`);
    for (const w of report.warnings) process.stdout.write(`  ${w}\n`);
  }
  return report.ok ? 0 : 1;
}
