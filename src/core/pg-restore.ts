/**
 * Restore on Postgres, online, with the previous data kept for an undo.
 *
 * A backup is a pg_dump archive of the install's schema. It goes in in two
 * steps, and the live schema notices only the last:
 *
 *  1. Staging. pg_restore's SQL runs through psql in one transaction that
 *     renames the schema holding the archive's name aside for its own
 *     duration, creates that schema afresh, fills it, renames it to a
 *     staging name and puts the original back before it commits. Other
 *     connections never see the renames (catalog changes stay invisible
 *     until COMMIT), and a damaged archive, or anything else going wrong,
 *     rolls all of it back. Extensions living in the schema move along for
 *     the duration: the search function names `unaccent` by schema, and the
 *     archive's tables check their generated columns against it as they are
 *     created.
 *  2. The swap, one transaction on the server's own pool: every object of
 *     the live schema moves into a schema for the previous data, every
 *     object of the staging schema into the live one, and token revocations
 *     and password-reset stamps made since the backup are carried over, as
 *     are the grants on the tables. The schema itself stays, with its owner,
 *     grants, default privileges and extensions. Statements follow the
 *     tables: after a table is moved Postgres resolves names afresh, so
 *     prepared statements and writes that waited on the swap's locks reach
 *     the restored tables.
 *
 * The previous data stays for {@link KEEP_DAYS} days, so a restore can be
 * undone (the same swap the other way), and is then dropped. Schemas this
 * module made carry a comment saying so, and for which install schema.
 */
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { db, getDriver } from "../db/index.ts";
import { MigrationLockBusy, PostgresDriver } from "../db/postgres.ts";
import { pgDumpBinary, pgToolConnection } from "./backups.ts";
import { peersActive, sendToPeers } from "./peers.ts";
import { withExclusiveWrite } from "./write-gate.ts";

/** Days the data a restore replaced is kept. */
export const KEEP_DAYS = 7;
/** A staging schema left this long is from a restore that died: dropped. */
const STALE_STAGING_S = 60 * 60;
/** How long the swap waits for a lock before giving up (other servers' long queries). */
const SWAP_LOCK_TIMEOUT = "15s";
/**
 * Other servers hold their writes for a swap this long after each
 * `restore:begin`, which this server repeats every {@link PEER_RENEW_MS}
 * while it works: a hold never lapses during a long migration, and one
 * left by a server that died ends within a minute.
 */
const PEER_HOLD_MS = 60_000;
const PEER_RENEW_MS = 30_000;
const NOTE_PREFIX = "vaultbase:";

/** The archive or the database can't take this restore; nothing was changed. 422. */
export class RestoreRefused extends Error {}
/**
 * Another restore or undo is running (here, or on another server, which
 * holds the migration lock), a server is migrating, or the swap couldn't
 * get its locks in time. Nothing was changed. 409.
 */
export class RestoreBusy extends Error {}
/**
 * The swap committed, so the data is the restored one, but what follows it
 * (bringing the schema up to date) failed. The data it replaced is kept. 500.
 */
export class RestoreSwapped extends Error {}

type NoteKind = "before_restore" | "before_undo" | "staging";
interface SchemaNote { kind: NoteKind; schema: string; at: number; source?: string }

/** Data a restore or an undo replaced, kept for an undo. */
export interface PreviousData {
  schema: string;
  /** What replaced it: a restore, or an undo. */
  replaced_by: "restore" | "undo";
  /** The backup restored over it, or the schema an undo brought back. */
  source: string | null;
  at: number;
  expires_at: number;
  size_bytes: number;
}

export type RestorePhase = "checking" | "staging" | "swapping" | "migrating";

export interface SwapHooks {
  onPhase?: (phase: RestorePhase) => void;
  /**
   * Runs after the swap commits, still holding the write gate and the
   * migration lock: migrations, caches. Its failure is reported, but the
   * swap stays (an undo puts the previous data back).
   */
  afterSwap: () => Promise<void>;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

function driver(): PostgresDriver {
  const d = getDriver();
  if (!(d instanceof PostgresDriver)) throw new Error(`restore from a pg_dump archive needs Postgres, not ${d.name}`);
  return d;
}

function locate(envName: string, name: string, near: string | null): string | null {
  const named = process.env[envName];
  if (named) return existsSync(named) ? named : Bun.which(named);
  if (near) {
    for (const file of [name, `${name}.exe`]) {
      const p = join(dirname(near), file);
      if (existsSync(p)) return p;
    }
  }
  return Bun.which(name);
}

/**
 * pg_restore and psql: `VAULTBASE_PG_RESTORE` / `VAULTBASE_PSQL`, else
 * next to pg_dump (psql next to pg_restore: the one that reads its output),
 * else on the PATH. Null when either is missing.
 */
export function restoreTools(): { pgRestore: string; psql: string } | null {
  const pgRestore = locate("VAULTBASE_PG_RESTORE", "pg_restore", pgDumpBinary());
  if (!pgRestore) return null;
  const psql = locate("VAULTBASE_PSQL", "psql", pgRestore);
  return psql ? { pgRestore, psql } : null;
}

async function run(cmd: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
}

/** A client tool's error, without its program prefix, short. */
function toolError(err: string): string {
  const lines = err.split("\n").map((l) => l.replace(/^(?:pg_restore|psql)(?::[^:]*:\d+)?:\s*/, "").trim()).filter(Boolean);
  const main = lines.find((l) => /^(?:error|ERROR|FATAL)/.test(l)) ?? lines[0] ?? "no output";
  const detail = lines.find((l) => /^(?:DETAIL|HINT)/.test(l));
  return (detail ? `${main} (${detail})` : main).slice(0, 400);
}

function stampOf(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-10-27T15:30:12.123Z
  return `${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 19).replace(/:/g, "")}_${iso.slice(20, 23)}`;
}

function noteOf(comment: string | null): SchemaNote | null {
  if (!comment?.startsWith(NOTE_PREFIX)) return null;
  try {
    const n = JSON.parse(comment.slice(NOTE_PREFIX.length)) as SchemaNote;
    return typeof n.schema === "string" && typeof n.at === "number" && typeof n.kind === "string" ? n : null;
  } catch { return null; }
}

const noteText = (n: SchemaNote) => NOTE_PREFIX + JSON.stringify(n);

async function liveSchema(): Promise<string> {
  return (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
}

/** Schemas this module made, for install schema `live`. */
async function notedSchemas(live: string): Promise<Array<{ schema: string; note: SchemaNote; size: number }>> {
  const rows = await db.all<{ schema: string; comment: string | null; size: number }>(
    `SELECT n.nspname AS schema, obj_description(n.oid, 'pg_namespace') AS comment,
            COALESCE((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c
                       WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'm')), 0)::bigint AS size
       FROM pg_namespace n
      WHERE obj_description(n.oid, 'pg_namespace') LIKE ?`,
    [`${NOTE_PREFIX}%`],
  );
  const out: Array<{ schema: string; note: SchemaNote; size: number }> = [];
  for (const r of rows) {
    const note = noteOf(r.comment);
    if (note && note.schema === live) out.push({ schema: r.schema, note, size: Number(r.size) });
  }
  return out;
}

/** Previous data kept for this install, newest first. */
export async function listPreviousData(): Promise<PreviousData[]> {
  const live = await liveSchema();
  return (await notedSchemas(live))
    .filter((s) => s.note.kind !== "staging")
    .map((s) => ({
      schema: s.schema,
      replaced_by: s.note.kind === "before_undo" ? "undo" as const : "restore" as const,
      source: s.note.source ?? null,
      at: s.note.at,
      expires_at: s.note.at + KEEP_DAYS * 86_400,
      size_bytes: s.size,
    }))
    .sort((a, b) => b.at - a.at);
}

/**
 * Drop previous data past {@link KEEP_DAYS} days and staging schemas left
 * by a restore that died. Returns the schemas dropped. Errors are logged:
 * the next pass tries again.
 */
export async function dropExpiredRestoreSchemas(nowSec = Math.floor(Date.now() / 1000)): Promise<string[]> {
  // Never while a restore or undo runs anywhere: it may be about to swap
  // in a staging schema older than an hour (a big archive), or one it is
  // putting back.
  try {
    return await exclusively(() => dropExpired(nowSec));
  } catch (e) {
    if (e instanceof RestoreBusy) return [];
    throw e;
  }
}

async function dropExpired(nowSec: number): Promise<string[]> {
  const live = await liveSchema();
  const dropped: string[] = [];
  for (const s of await notedSchemas(live)) {
    const expired = s.note.kind === "staging" ? s.note.at < nowSec - STALE_STAGING_S : s.note.at < nowSec - KEEP_DAYS * 86_400;
    if (!expired) continue;
    try {
      await dropSchema(s.schema);
      dropped.push(s.schema);
    } catch (e) {
      console.warn(`[restore] couldn't drop ${s.schema}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return dropped;
}

/**
 * Drop kept previous data now (the backups page). False when it isn't this
 * install's; RestoreBusy while a restore or undo runs.
 */
export async function dropPreviousData(schema: string): Promise<boolean> {
  return exclusively(async () => {
    const live = await liveSchema();
    const s = (await notedSchemas(live)).find((x) => x.schema === schema && x.note.kind !== "staging");
    if (!s) return false;
    await dropSchema(schema);
    return true;
  });
}

async function dropSchema(schema: string): Promise<void> {
  await db.transaction(async () => {
    await db.exec(`SET LOCAL lock_timeout = '${SWAP_LOCK_TIMEOUT}'`);
    await db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
  });
}

/** The archive's schema and table of contents, or why it can't be restored. */
async function inspectArchive(path: string, pgRestore: string): Promise<{ schema: string; toc: string[] }> {
  const { code, out, err } = await run([pgRestore, "--list", path]);
  if (code !== 0) throw new RestoreRefused(`pg_restore can't read it: ${toolError(err)}`);
  const toc = out.split("\n");
  const schemas = toc.map((l) => /^\d+; \d+ \d+ SCHEMA - (.+) \S+$/.exec(l)?.[1]).filter((s): s is string => !!s);
  if (schemas.length !== 1) {
    throw new RestoreRefused(`it holds ${schemas.length} schemas; a Vaultbase backup holds exactly one`);
  }
  const schema = schemas[0]!;
  const table = `TABLE ${schema} vaultbase_collections `;
  if (!toc.some((l) => /^\d+; \d+ \d+ /.test(l) && l.replace(/^\d+; \d+ \d+ /, "").startsWith(table))) {
    throw new RestoreRefused("it isn't a Vaultbase backup (no vaultbase_collections table)");
  }
  return { schema, toc };
}

/**
 * Restore the archive into a new schema `staging`, committed only if every
 * statement succeeded. See the module comment, step 1.
 */
async function stage(archive: string, workDir: string, inspected: { schema: string; toc: string[] }, staging: string, note: SchemaNote): Promise<void> {
  const tools = restoreTools()!;
  const x = inspected.schema;
  const current = await db.get<{ mine: boolean }>(
    `SELECT pg_has_role(nspowner, 'MEMBER') AS mine FROM pg_namespace WHERE nspname = ?`, [x],
  );
  if (current && !current.mine) {
    throw new RestoreRefused(`the restore renames the schema "${x}" for its duration, and the server's database role doesn't own it`);
  }
  // Relocatable extensions this role may move; anything else stays put, and
  // a restore that needs it fails (rolled back).
  const extensions = current
    ? (await db.all<{ name: string }>(
      `SELECT e.extname AS name FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE n.nspname = ? AND e.extrelocatable AND pg_has_role(e.extowner, 'MEMBER') ORDER BY e.extname`,
      [x],
    )).map((r) => r.name)
    : [];
  const hold = `vb_restore_hold_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const prefix = [
    "BEGIN;",
    "SET client_min_messages = warning;",
    ...(current ? [`ALTER SCHEMA ${q(x)} RENAME TO ${q(hold)};`] : []),
    `CREATE SCHEMA ${q(x)};`,
    ...extensions.map((e) => `ALTER EXTENSION ${q(e)} SET SCHEMA ${q(x)};`),
    "",
  ].join("\n");
  const suffix = [
    "",
    `ALTER SCHEMA ${q(x)} RENAME TO ${q(staging)};`,
    `COMMENT ON SCHEMA ${q(staging)} IS ${lit(noteText(note))};`,
    ...(current ? [`ALTER SCHEMA ${q(hold)} RENAME TO ${q(x)};`] : []),
    ...extensions.map((e) => `ALTER EXTENSION ${q(e)} SET SCHEMA ${q(x)};`),
    "COMMIT;",
    "",
  ].join("\n");

  // Everything but the schema's own CREATE, which the prefix ran.
  const list = join(workDir, `.restore-${Date.now()}-${process.pid}.list`);
  writeFileSync(list, inspected.toc.filter((l) => !/^\d+; \d+ \d+ SCHEMA - /.test(l)).join("\n"));
  const conn = pgToolConnection(driver().url);
  const env = { ...process.env, ...conn.env };
  try {
    const restore = Bun.spawn([tools.pgRestore, "--no-owner", "--no-privileges", "--use-list", list, "--file=-", archive], {
      stdout: "pipe", stderr: "pipe", env,
    });
    const psql = Bun.spawn([tools.psql, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1", `--dbname=${conn.dbname}`, "--file=-"], {
      stdin: "pipe", stdout: "ignore", stderr: "pipe", env,
    });
    const restoreErr = new Response(restore.stderr).text();
    const psqlErr = new Response(psql.stderr).text();
    // The archive's SQL goes through as pg_restore writes it, checked line
    // by line. The suffix, and with it the COMMIT, is written only once
    // pg_restore has exited cleanly: psql reads a cut-off stream as a
    // shorter script, and would otherwise commit whatever arrived.
    const settings = new Set((await db.all<{ name: string }>(`SELECT name FROM pg_settings`)).map((r) => r.name));
    const check = new ScriptCheck(settings);
    let refused: string | null = null;
    let piped = true;
    try {
      psql.stdin.write(prefix);
      const reader = restore.stdout.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        const fed = check.feed(done ? dec.decode() : dec.decode(value, { stream: true }), done);
        refused = fed.refused;
        if (refused) break;
        if (fed.out) {
          psql.stdin.write(fed.out);
          await psql.stdin.flush();
        }
        if (done) break;
      }
    } catch {
      piped = false; // psql stopped reading: it failed, and says why
    }
    if (refused || !piped) {
      // Killed at once: pg_restore, no longer read, would block on a full
      // pipe and never exit. psql, dropped mid-transaction, is rolled back.
      restore.kill(9);
      psql.kill(9);
      await Promise.all([restore.exited, psql.exited]);
      if (refused) throw new RestoreRefused(refused);
      throw new RestoreRefused(`the archive's SQL failed: ${toolError(await psqlErr)}`);
    }
    const restoreCode = await restore.exited;
    if (restoreCode !== 0) {
      psql.kill(9);
      await psql.exited;
      throw new RestoreRefused(`pg_restore failed: ${toolError(await restoreErr)}`);
    }
    try {
      psql.stdin.write(suffix);
      await psql.stdin.end();
    } catch { /* psql already exited; its code says why */ }
    const psqlCode = await psql.exited;
    if (psqlCode !== 0) throw new RestoreRefused(`the archive's SQL failed: ${toolError(await psqlErr)}`);
  } finally {
    rmSync(list, { force: true });
    // An archive whose SQL ended the transaction early (it is checked, but
    // it is SQL) would leave the schema renamed aside: put it back.
    if (current) await putBack(hold, x);
  }
  const ok = await db.get<{ ok: boolean }>(`SELECT to_regclass(?) IS NOT NULL AS ok`, [`${q(staging)}.vaultbase_collections`]);
  if (!ok?.ok) throw new RestoreRefused("the restored schema has no vaultbase_collections table");
}

interface Movable { kind: string; name: string; mine: boolean }

/**
 * Everything in `schema` that moves with ALTER … SET SCHEMA, in the order it
 * has to: functions (their signatures name types, so before the types),
 * then tables, views and sequences not owned by a column, then standalone
 * types. Indexes, constraints, owned sequences and row types go with their
 * table, and array types with theirs; a range type's multirange and
 * constructors don't, and are listed. Extension members stay. Names come fully qualified (the search path is emptied for the
 * listing), so a signature still reads right after a type it names moved.
 */
async function movable(schema: string): Promise<Movable[]> {
  const saved = (await db.get<{ p: string }>(`SELECT current_setting('search_path') AS p`))!.p;
  await db.get(`SELECT set_config('search_path', 'pg_catalog', true)`);
  try {
    return await db.all<Movable>(
      `SELECT kind, name, mine FROM (
         SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END AS kind,
                format('%I.%I(%s)', n.nspname, p.proname,
                       CASE WHEN p.prokind = 'a' AND pg_get_function_identity_arguments(p.oid) = '' THEN '*'
                            ELSE pg_get_function_identity_arguments(p.oid) END) AS name,
                pg_has_role(p.proowner, 'MEMBER') AS mine, 0 AS ord
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = ?
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
         UNION ALL
         SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
                               WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
                format('%I.%I', n.nspname, c.relname), pg_has_role(c.relowner, 'MEMBER'), 1
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ? AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                             AND (d.deptype = 'e' OR (c.relkind = 'S' AND d.deptype IN ('a', 'i'))))
         UNION ALL
         SELECT CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, format('%I.%I', n.nspname, t.typname),
                pg_has_role(t.typowner, 'MEMBER'), 2
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = ?
            AND (t.typtype IN ('d', 'e', 'r', 'm') OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class r WHERE r.oid = t.typrelid AND r.relkind = 'c')))
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
       ) o ORDER BY ord, name`,
      [schema, schema, schema],
    );
  } finally {
    await db.get(`SELECT set_config('search_path', ?, true)`, [saved]);
  }
}

/**
 * Objects in `schema` the swap doesn't move (extended statistics,
 * collations, text search objects, operators, conversions, base types),
 * extension members aside: refused up front, since they would stay behind
 * in the live schema, or keep the staging schema from being dropped.
 */
async function unmovable(schema: string): Promise<string[]> {
  const rows = await db.all<{ what: string }>(
    `WITH n AS (SELECT oid FROM pg_namespace WHERE nspname = ?),
          ext AS (SELECT classid, objid FROM pg_depend WHERE deptype = 'e')
     SELECT 'statistics ' || stxname AS what FROM pg_statistic_ext WHERE stxnamespace = (SELECT oid FROM n)
       AND (('pg_statistic_ext'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'collation ' || collname FROM pg_collation WHERE collnamespace = (SELECT oid FROM n)
       AND (('pg_collation'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'text search configuration ' || cfgname FROM pg_ts_config WHERE cfgnamespace = (SELECT oid FROM n)
       AND (('pg_ts_config'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'text search dictionary ' || dictname FROM pg_ts_dict WHERE dictnamespace = (SELECT oid FROM n)
       AND (('pg_ts_dict'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'text search parser ' || prsname FROM pg_ts_parser WHERE prsnamespace = (SELECT oid FROM n)
       AND (('pg_ts_parser'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'text search template ' || tmplname FROM pg_ts_template WHERE tmplnamespace = (SELECT oid FROM n)
       AND (('pg_ts_template'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'operator ' || oprname FROM pg_operator WHERE oprnamespace = (SELECT oid FROM n)
       AND (('pg_operator'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'operator class ' || opcname FROM pg_opclass WHERE opcnamespace = (SELECT oid FROM n)
       AND (('pg_opclass'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'operator family ' || opfname FROM pg_opfamily WHERE opfnamespace = (SELECT oid FROM n)
       AND (('pg_opfamily'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'conversion ' || conname FROM pg_conversion WHERE connamespace = (SELECT oid FROM n)
       AND (('pg_conversion'::regclass, oid) NOT IN (SELECT * FROM ext))
     UNION ALL SELECT 'type ' || typname FROM pg_type WHERE typnamespace = (SELECT oid FROM n) AND typtype IN ('b', 'p')
       AND typelem = 0 AND (('pg_type'::regclass, oid) NOT IN (SELECT * FROM ext))
     ORDER BY 1`,
    [schema],
  );
  return rows.map((r) => r.what);
}

async function refuseUnmovable(schema: string): Promise<void> {
  const left = await unmovable(schema);
  if (left.length === 0) return;
  const shown = left.slice(0, 5).join(", ") + (left.length > 5 ? `, and ${left.length - 5} more` : "");
  throw new RestoreRefused(`the schema "${schema}" holds objects a restore can't move: ${shown}. Move or drop them first`);
}

/** Why the swap can't move these objects, or null. */
function notOwned(objects: Movable[], schema: string): string | null {
  const theirs = objects.filter((o) => !o.mine).map((o) => o.name);
  if (theirs.length === 0) return null;
  const shown = theirs.slice(0, 5).join(", ") + (theirs.length > 5 ? `, and ${theirs.length - 5} more` : "");
  return `the restore moves everything in the schema "${schema}", and the server's database role doesn't own ${shown}`;
}

/**
 * Inside the swap: what changed since the backup that a restore must not
 * undo. Revoked tokens stay revoked; a raised password_reset_at ("sign out
 * everywhere", a password reset) isn't lowered again, which would revive
 * every token it ended (API tokens follow their admin). The generation
 * other servers poll never goes back, and grants on the tables carry over.
 */
async function carryOver(previous: string, live: string): Promise<void> {
  const rel = (schema: string, name: string) => `${q(schema)}.${q(name)}`;
  const exists = async (schema: string, name: string) =>
    (await db.get<{ ok: boolean }>(`SELECT to_regclass(?) IS NOT NULL AS ok`, [rel(schema, name)]))?.ok === true;
  const hasColumn = async (schema: string, table: string, column: string) =>
    !!(await db.get(`SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`, [schema, table, column]));

  const rev = "vaultbase_token_revocations";
  if (await exists(previous, rev) && await exists(live, rev)) {
    await db.run(
      `INSERT INTO ${rel(live, rev)} (jti, expires_at, revoked_at)
       SELECT jti, expires_at, revoked_at FROM ${rel(previous, rev)} WHERE expires_at > ?
       ON CONFLICT (jti) DO NOTHING`,
      [Math.floor(Date.now() / 1000)],
    );
  }

  const { userTableName } = await import("./collections.ts");
  const auth = await exists(live, "vaultbase_collections")
    ? await db.all<{ name: string }>(`SELECT name FROM ${rel(live, "vaultbase_collections")} WHERE type = 'auth'`)
    : [];
  for (const table of ["vaultbase_admin", ...auth.map((c) => userTableName(c.name))]) {
    if (!(await hasColumn(previous, table, "password_reset_at")) || !(await hasColumn(live, table, "password_reset_at"))) continue;
    await db.run(
      `UPDATE ${rel(live, table)} AS n SET password_reset_at = o.password_reset_at
         FROM ${rel(previous, table)} AS o
        WHERE o.id = n.id AND o.password_reset_at > COALESCE(n.password_reset_at, 0)`,
    );
  }

  const gen = "vaultbase_peer_generation";
  if (await exists(previous, gen) && await exists(live, gen)) {
    await db.get(
      `SELECT setval(?::regclass, GREATEST((SELECT last_value FROM ${rel(previous, gen)}), (SELECT last_value FROM ${rel(live, gen)})))`,
      [rel(live, gen)],
    );
  }

  // Grants made on the tables (the read-only login, roles an operator set
  // up), from each table to its namesake. The archive was restored without
  // privileges: its roles may not exist here.
  const grants = await db.all<{ sql: string }>(
    `SELECT format('GRANT %s ON %s %I.%I TO %s%s', a.privilege_type,
                   CASE o.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, ln.nspname, c.relname,
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END,
                   CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END) AS sql
       FROM pg_class o
       JOIN pg_namespace pn ON pn.oid = o.relnamespace AND pn.nspname = ?
       JOIN pg_namespace ln ON ln.nspname = ?
       JOIN pg_class c ON c.relnamespace = ln.oid AND c.relname = o.relname AND c.relkind = o.relkind
       CROSS JOIN LATERAL aclexplode(o.relacl) a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE o.relacl IS NOT NULL AND a.grantee <> o.relowner AND (a.grantee = 0 OR r.oid IS NOT NULL)`,
    [previous, live],
  );
  for (const g of grants) await db.exec(g.sql);
}

/**
 * Move `incoming`'s objects into the live schema and the live ones into a
 * new schema for the previous data, in one transaction. See the module
 * comment, step 2.
 */
async function swap(incoming: string, live: string, previous: string, note: SchemaNote): Promise<void> {
  const problem = notOwned(await movable(live), live) ?? notOwned(await movable(incoming), incoming);
  if (problem) throw new RestoreRefused(problem);
  await refuseUnmovable(live);
  await refuseUnmovable(incoming);
  try {
    await db.transaction(async () => {
      await db.exec(`SET LOCAL lock_timeout = '${SWAP_LOCK_TIMEOUT}'`);
      await db.exec(`CREATE SCHEMA ${q(previous)}`);
      await db.exec(`COMMENT ON SCHEMA ${q(previous)} IS ${lit(noteText(note))}`);
      // Listed again inside the transaction: an object made meanwhile (a
      // collection created on another server) moves too.
      for (const o of await movable(live)) await db.exec(`ALTER ${o.kind} ${o.name} SET SCHEMA ${q(previous)}`);
      for (const o of await movable(incoming)) await db.exec(`ALTER ${o.kind} ${o.name} SET SCHEMA ${q(live)}`);
      // Empty now, unless something that doesn't move appeared meanwhile:
      // then this fails, naming it, and nothing is swapped.
      await db.exec(`DROP SCHEMA ${q(incoming)}`);
      await carryOver(previous, live);
    });
  } catch (e) {
    // Another connection's locks (a long query, or a deadlock the swap lost).
    const code = (e as { errno?: unknown }).errno;
    if (code === "55P03" || code === "40P01") {
      throw new RestoreBusy("The database was too busy to swap the data in (another connection held its tables). Nothing changed; try again.");
    }
    throw e;
  }
}

/** The schema the staging transaction renamed aside, back under its name, if it was left so. */
async function putBack(hold: string, name: string): Promise<void> {
  try {
    const held = await db.get(`SELECT 1 FROM pg_namespace WHERE nspname = ?`, [hold]);
    if (!held) return;
    const taken = await db.get(`SELECT 1 FROM pg_namespace WHERE nspname = ?`, [name]);
    if (taken) {
      console.error(`[restore] the schema "${name}" was renamed to "${hold}" by an archive's SQL, and "${name}" exists again: rename it back by hand`);
      return;
    }
    await db.exec(`ALTER SCHEMA ${q(hold)} RENAME TO ${q(name)}`);
    console.error(`[restore] the archive's SQL ended the staging transaction early; the schema "${name}" was put back`);
  } catch (e) {
    console.error(`[restore] couldn't check for the renamed schema "${hold}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Checks pg_restore's output line by line on its way to psql. psql runs
 * backslash commands found in its input; pg_restore from August 2025 on
 * (17.6, 16.10, 15.14, 14.19, 18 and later) starts its output with
 * `\restrict`, which turns them off until the matching `\unrestrict`.
 * Output without it is refused, as is any other backslash command outside
 * COPY data, and a statement controlling the transaction, which would end
 * the staging transaction early. The archive is still SQL run as the
 * server's role: restore archives you trust, such as this install's backups.
 */
class ScriptCheck {
  /** Settings the server has: a newer pg_restore's own SETs it lacks are left out. */
  constructor(private readonly settings: ReadonlySet<string>) {}
  private pending = "";
  private restricted = false;
  private inCopy = false;
  private dollar: string | null = null;
  /** The last statement ended: the next line starts one (not `END AS …` in a view's CASE). */
  private atStart = true;

  /**
   * Feed the next chunk: the whole lines to pass on, or the reason to stop.
   * A client newer than the server writes SETs for settings the server
   * doesn't have (pg_restore 17's `SET transaction_timeout = 0` on a 16
   * server): those are left out, the rest goes through as it came.
   */
  feed(text: string, end: boolean): { out: string; refused: string | null } {
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = end ? "" : lines.pop()!;
    const out: string[] = [];
    for (const line of lines) {
      const why = this.line(line);
      if (why === SKIP) { out.push(`-- left out, unknown to this server: ${line.slice(0, 80)}`); continue; }
      if (why) return { out: "", refused: why };
      out.push(line);
    }
    if (end && !this.restricted) return { out: "", refused: OLD_PG_RESTORE };
    return { out: out.length ? `${out.join("\n")}\n` : "", refused: null };
  }

  private line(line: string): string | typeof SKIP | null {
    if (this.inCopy) {
      if (line === "\\.") this.inCopy = false;
      return null;
    }
    if (this.dollar === null) {
      if (line.startsWith("\\")) {
        if (/^\\restrict \S+$/.test(line)) { this.restricted = true; return null; }
        if (/^\\unrestrict \S+$/.test(line) && this.restricted) return null;
        return `the archive's SQL holds a psql command (${line.slice(0, 40)}), which a restore doesn't run`;
      }
      if (!this.restricted && line.trim() !== "" && !line.startsWith("--")) return OLD_PG_RESTORE;
      if (this.atStart && /^\s*(BEGIN|COMMIT|END|ROLLBACK|ABORT|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET\s+(SESSION\s+AUTHORIZATION|ROLE)|RESET\s+(SESSION|ROLE|ALL))\b/i.test(line)) {
        return `the archive's SQL controls the transaction (${line.trim().slice(0, 40)}), which a restore doesn't run`;
      }
      if (/^COPY .* FROM stdin;$/.test(line)) { this.inCopy = true; return null; }
      const set = this.atStart ? /^SET ([a-z_][a-z0-9_]*) = [^;]*;$/.exec(line) : null;
      if (set && !this.settings.has(set[1]!)) return SKIP;
      const t = line.trim();
      if (t !== "" && !t.startsWith("--")) this.atStart = t.endsWith(";");
    }
    // Function bodies are dollar-quoted, and may hold lines like END.
    const quoted = this.dollar !== null;
    for (const m of line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)?\$/g)) {
      if (this.dollar === null) this.dollar = m[0];
      else if (m[0] === this.dollar) this.dollar = null;
    }
    // A body closing on this line (`$$;`) may end its statement too.
    if (quoted && this.dollar === null) this.atStart = line.trim().endsWith(";");
    return null;
  }
}

const SKIP = Symbol("skip");

const OLD_PG_RESTORE =
  "pg_restore is too old: restore needs a PostgreSQL client from August 2025 or later (17.6, 16.10, 15.14, 14.19, 18 or later), whose output stops psql from running commands found in an archive";

let busy = false;

async function afterSwap(hooks: SwapHooks): Promise<void> {
  try {
    await hooks.afterSwap();
  } catch (e) {
    throw new RestoreSwapped(
      `The backup's data is in place, but bringing it up to date failed: ${e instanceof Error ? e.message : String(e)}. The data it replaced is kept under Previous data, to put back if needed.`,
    );
  }
}

/**
 * Hold this server's writes, and ask the other servers to hold theirs,
 * around `fn`; tell them when it's done, whatever happened, so they drop
 * their caches and carry on.
 */
async function withWritesHeld<T>(fn: () => Promise<T>): Promise<T> {
  let renew: ReturnType<typeof setInterval> | null = null;
  if (peersActive()) {
    sendToPeers({ k: "restore:begin", ms: PEER_HOLD_MS });
    renew = setInterval(() => sendToPeers({ k: "restore:begin", ms: PEER_HOLD_MS }), PEER_RENEW_MS);
    // The message is batched, then queued behind the others; let it land.
    await Bun.sleep(250);
  }
  try {
    return await withExclusiveWrite(async (tx) => {
      const out = await fn();
      tx.commit();
      return out;
    });
  } finally {
    if (renew) clearInterval(renew);
    sendToPeers({ k: "cache:restored" });
  }
}

async function exclusively<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new RestoreBusy("A restore or undo is already running.");
  busy = true;
  try {
    // A server starting meanwhile waits on the lock instead of migrating a
    // schema that is being swapped. A restore asked of another server
    // meanwhile answers 409 rather than waiting without a word.
    return await driver().withMigrationLock(fn, { wait: false });
  } catch (e) {
    if (e instanceof MigrationLockBusy) throw new RestoreBusy("Another server is restoring or migrating this database; try again when it's done.");
    throw e;
  } finally {
    busy = false;
  }
}

/**
 * Restore a pg_dump archive over the live schema. `source` names it for the
 * previous-data list. Throws RestoreRefused (nothing changed) or RestoreBusy;
 * any other error after the swap committed comes from `afterSwap`.
 */
export async function restoreArchive(archive: string, source: string, workDir: string, hooks: SwapHooks): Promise<void> {
  const tools = restoreTools();
  if (!tools) throw new RestoreRefused("restore needs pg_restore and psql (the PostgreSQL client tools) on the server");
  await exclusively(async () => {
    hooks.onPhase?.("checking");
    const inspected = await inspectArchive(archive, tools.pgRestore);
    const live = await liveSchema();
    const now = Date.now();
    const at = Math.floor(now / 1000);
    const staging = db.dialect.fitIdent(`${live}_restore_staging_${stampOf(now)}`);
    const previous = db.dialect.fitIdent(`${live}_before_restore_${stampOf(now)}`);
    // Checked before the long part, and again by the swap itself.
    const problem = notOwned(await movable(live), live);
    if (problem) throw new RestoreRefused(problem);
    await refuseUnmovable(live);
    hooks.onPhase?.("staging");
    await stage(archive, workDir, inspected, staging, { kind: "staging", schema: live, at });
    try {
      hooks.onPhase?.("swapping");
      await withWritesHeld(async () => {
        await swap(staging, live, previous, { kind: "before_restore", schema: live, at, source });
        hooks.onPhase?.("migrating");
        await afterSwap(hooks);
      });
    } catch (e) {
      // Not swapped: the staging schema goes. Swapped: it's gone already.
      await dropSchema(staging).catch(() => { /* dropped as stale later */ });
      throw e;
    }
  });
}

/**
 * Put kept previous data back. The data it replaces is kept in turn, so an
 * undo can be undone. False when `schema` isn't this install's previous data.
 */
export async function undoRestore(schema: string, hooks: SwapHooks): Promise<boolean> {
  return exclusively(async () => {
    const live = await liveSchema();
    const kept = (await notedSchemas(live)).find((s) => s.schema === schema && s.note.kind !== "staging");
    if (!kept) return false;
    const now = Date.now();
    const previous = db.dialect.fitIdent(`${live}_before_undo_${stampOf(now)}`);
    hooks.onPhase?.("swapping");
    await withWritesHeld(async () => {
      await swap(schema, live, previous, { kind: "before_undo", schema: live, at: Math.floor(now / 1000), source: schema });
      hooks.onPhase?.("migrating");
      await afterSwap(hooks);
    });
    return true;
  });
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Drop expired previous data now and every hour (Postgres boot). */
export function startRestoreCleanup(): void {
  if (cleanupTimer) return;
  const pass = () => { void dropExpiredRestoreSchemas().catch((e) => console.warn(`[restore] cleanup: ${e instanceof Error ? e.message : String(e)}`)); };
  pass();
  cleanupTimer = setInterval(pass, 60 * 60 * 1000);
  cleanupTimer.unref?.();
}

export function stopRestoreCleanup(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}

/**
 * Files a restore leaves in the data directory while it runs (an upload,
 * the archive's list), left behind by a process that was killed: removed
 * at boot once an hour old.
 */
export function sweepRestoreFiles(dir: string, nowMs = Date.now()): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^\.restore-(upload-)?\d+-\d+\.(dump|list)$/.test(name)) continue;
    const p = join(dir, name);
    try { if (statSync(p).mtimeMs < nowMs - 3_600_000) rmSync(p, { force: true }); } catch { /* gone */ }
  }
}
