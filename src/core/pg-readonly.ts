/**
 * The Postgres login read-only SQL runs as (the admin SQL page, MCP run_sql
 * without allow_write).
 *
 * It must not run as the server's own role: that role may be a superuser, and
 * a role switch inside a session is never permanent. So it runs over a login
 * of its own that can read this install's tables and nothing else:
 *
 * - `VAULTBASE_PG_READONLY_URL` names one the operator made; or
 * - when the server's role may create roles, the server makes one per
 *   install (`vb_ro_<hash of database and schema>`): LOGIN and no other
 *   attribute; USAGE on the server's schema and SELECT on its tables, now and
 *   (through default privileges) later; role defaults for read-only
 *   transactions and time limits. Its password is derived from the server's
 *   secret, so it is stored nowhere, and Postgres receives a SCRAM verifier.
 *
 * Every run checks on the connection itself that the login can only read the
 * server's schema (its rights elsewhere are held back by the read-only
 * transaction), and refuses otherwise. It never falls back to the server's
 * role.
 */
import { onCloseDb } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { DeadlineExceeded, PostgresDriver } from "../db/postgres.ts";
import { pgToolConnection } from "./backups.ts";

/** Roles an operator's read-only login may belong to: Postgres's own read-only ones. */
const ALLOWED_MEMBERSHIPS = new Set([
  "pg_read_all_data", "pg_read_all_stats", "pg_read_all_settings", "pg_monitor", "pg_stat_scan_tables",
]);

const MAX_CONCURRENT = 4;
/** After a failure to set the login up or to log in, wait this long before trying again. */
const FAILURE_BACKOFF_MS = 60_000;
/** A run still going this long past its statement timeout loses its connection. */
const DEADLINE_GRACE_MS = 5_000;

/** Read-only SQL can't run on this server, and why (shown to the admin). */
export class ReadOnlyUnavailable extends Error {}
/** Too many read-only runs at once. */
export class ReadOnlyBusy extends Error {}

let derivationSecret: string | null = null;
let cachedUrl: string | null = null;
let cachedServer: { searchPath: string; user: string } | null = null;
let lastFailure: { at: number; error: ReadOnlyUnavailable } | null = null;
let running = 0;

/** The secret the login's password derives from (the JWT secret, shared by an install's servers). */
export function configureReadOnlyLogin(secret: string): void {
  derivationSecret = secret;
  cachedUrl = null;
  lastFailure = null;
}

/** Forget the login (a closed or reopened database; tests). */
export function _resetReadOnlyLogin(): void {
  cachedUrl = null;
  cachedServer = null;
  lastFailure = null;
}
onCloseDb(_resetReadOnlyLogin);

/**
 * A SCRAM-SHA-256 verifier for `password` in the form Postgres stores
 * (RFC 5802 / 7677). Postgres keeps a verifier given as a PASSWORD as is.
 */
export async function scramVerifier(password: string, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = 4096): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salted = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations }, keyMaterial, 256));
  const hmac = async (key: Uint8Array, msg: string) => {
    const k = await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  };
  const clientKey = await hmac(salted, "Client Key");
  const storedKey = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(clientKey)));
  const serverKey = await hmac(salted, "Server Key");
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

/** The login's password: an HMAC of its name under the server's secret. */
export async function derivedPassword(roleName: string): Promise<string> {
  // A process that made up its own would reset the password under every
  // other server of the install.
  if (!derivationSecret) throw new ReadOnlyUnavailable("the server's secret isn't configured for the read-only login");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(derivationSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, enc.encode(`vaultbase:pg-readonly-login:${roleName}`))).toString("base64url");
}

/** `url` with `user` and `password` as its credentials; everything else kept. */
export function withCredentials(url: string, user: string, password: string): string {
  const { dbname } = pgToolConnection(url); // without its password
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(dbname);
  if (!scheme) throw new ReadOnlyUnavailable("the database URL isn't a postgres:// URL");
  const from = scheme[0].length;
  const rest = dbname.slice(from);
  const authEnd = rest.search(/[/?#]/);
  const authority = authEnd < 0 ? rest : rest.slice(0, authEnd);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const creds = `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
  // A user= in the query would win over the one in the authority.
  const tail = rest.slice(authority.length).replace(/([?&])user=[^&#]*(&?)/, (_m, sep: string, amp: string) => (amp ? sep : ""));
  return dbname.slice(0, from) + creds + host + tail;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** The server's own role and search path, from its pool. */
async function serverSide(): Promise<{ searchPath: string; user: string }> {
  if (cachedServer) return cachedServer;
  const row = await db.get<{ s: string[]; u: string }>(`SELECT current_schemas(false) AS s, current_user AS u`);
  cachedServer = { searchPath: (row?.s ?? []).map(quoteIdent).join(", ") || "pg_catalog", user: row?.u ?? "" };
  return cachedServer;
}

/**
 * Make, or bring back in line, this install's read-only login, over the
 * server's connection: one transaction under an advisory lock, so servers
 * starting together don't race.
 */
async function ensureLogin(): Promise<{ user: string; password: string }> {
  return db.transaction(async () => {
    await db.get(`SELECT pg_advisory_xact_lock(hashtext('vaultbase:readonly-login'))`);
    const me = await db.get<{ can: boolean; name: string; comment: string; schema: string; dbname: string; oid: number }>(
      `SELECT (r.rolsuper OR r.rolcreaterole) AS can, r.oid::int AS oid,
              'vb_ro_' || left(md5(current_database() || '/' || current_schema()), 16) AS name,
              'Vaultbase read-only login for ' || current_database() || '/' || current_schema() AS comment,
              current_schema() AS schema, current_database() AS dbname
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    if (!me?.can) {
      throw new ReadOnlyUnavailable(
        "the server's database role can't create roles. Create a login that can only read the server's schema and set VAULTBASE_PG_READONLY_URL to it.",
      );
    }
    const role = quoteIdent(me.name);
    const verifier = await scramVerifier(await derivedPassword(me.name));
    const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 64 VALID UNTIL 'infinity' PASSWORD ${quoteLiteral(verifier)}`;
    const existing = await db.get<{ comment: string | null; others: number }>(
      `SELECT shobj_description(r.oid, 'pg_authid') AS comment,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid AND m.member <> ?) AS others
         FROM pg_roles r WHERE r.rolname = ?`,
      [me.oid, me.name],
    );
    if (!existing) {
      await db.exec(`CREATE ROLE ${role} ${attrs}`);
      await db.exec(`COMMENT ON ROLE ${role} IS ${quoteLiteral(me.comment)}`);
    } else if (existing.comment !== me.comment) {
      throw new ReadOnlyUnavailable(`a role named ${me.name} exists and isn't Vaultbase's; drop or rename it, or set VAULTBASE_PG_READONLY_URL.`);
    } else if (existing.others > 0) {
      // Only the server's role may hold the login; anyone else could use it.
      throw new ReadOnlyUnavailable(`other roles are granted the role ${me.name}; revoke those grants, or drop the role and it will be made again.`);
    } else {
      await db.exec(`ALTER ROLE ${role} WITH ${attrs}`);
    }
    for (const setting of [
      "default_transaction_read_only = on",
      "statement_timeout = '30s'",
      "idle_in_transaction_session_timeout = '60s'",
      "idle_session_timeout = '120s'",
    ]) {
      await db.exec(`ALTER ROLE ${role} SET ${setting}`);
    }
    const schema = quoteIdent(me.schema);
    const usage = await db.get<{ ok: boolean }>(`SELECT has_schema_privilege(?, current_schema(), 'USAGE') AS ok`, [me.name]);
    if (!usage?.ok) await db.exec(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await db.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${role}`);
    const connect = await db.get<{ ok: boolean }>(`SELECT has_database_privilege(?, current_database(), 'CONNECT') AS ok`, [me.name]);
    if (!connect?.ok) await db.exec(`GRANT CONNECT ON DATABASE ${quoteIdent(me.dbname)} TO ${role}`);
    return { user: me.name, password: await derivedPassword(me.name) };
  });
}

function fail(error: ReadOnlyUnavailable): never {
  lastFailure = { at: Date.now(), error };
  throw error;
}

/** The URL read-only SQL connects with, making the login when needed. */
async function readOnlyUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl;
  const driver = getDriver();
  if (!(driver instanceof PostgresDriver)) throw new ReadOnlyUnavailable(`not on ${driver.name}`);
  const configured = process.env["VAULTBASE_PG_READONLY_URL"];
  if (configured) return (cachedUrl = configured);
  let login: { user: string; password: string };
  try {
    login = await ensureLogin();
  } catch (e) {
    if (e instanceof ReadOnlyUnavailable) fail(e);
    fail(new ReadOnlyUnavailable(
      `couldn't set up the read-only login (${e instanceof Error ? e.message : String(e)}). Create a login that can only read the server's schema and set VAULTBASE_PG_READONLY_URL to it.`,
    ));
  }
  return (cachedUrl = withCredentials(driver.url, login.user, login.password));
}

/** Why the current connection's login may do more than read this install's schema, or null. */
async function loginProblem(serverUser: string): Promise<string | null> {
  const me = await db.get<{ u: string; su: string; attrs: boolean; roles: string[] | null; ownsDb: boolean; create: boolean; writes: boolean }>(
    `SELECT current_user AS u, session_user AS su,
            (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS attrs,
            ARRAY(SELECT g.rolname FROM pg_roles g WHERE g.oid <> r.oid AND pg_has_role(r.oid, g.oid, 'MEMBER')) AS roles,
            EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid) AS "ownsDb",
            EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = current_schema()
                     AND (pg_has_role(r.oid, n.nspowner, 'MEMBER')
                          OR EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a
                                      WHERE a.privilege_type = 'CREATE' AND a.grantee <> 0 AND pg_has_role(r.oid, a.grantee, 'MEMBER')))) AS "create",
            EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                       AND (c.relowner = r.oid OR has_table_privilege(r.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))) AS writes
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  if (!me) return "the login isn't in pg_roles";
  if (me.u !== me.su) return "the login changed role";
  if (me.su === serverUser) return "it is the server's own login";
  if (me.attrs) return `the login ${me.u} has more than read access (superuser, createrole, createdb, replication or bypassrls)`;
  const extra = (me.roles ?? []).filter((x) => !ALLOWED_MEMBERSHIPS.has(x));
  if (extra.length > 0) return `the login ${me.u} is also a member of ${extra.join(", ")}`;
  if (me.ownsDb) return `the login ${me.u} owns the database`;
  if (me.create) return `the login ${me.u} may create objects in the schema`;
  if (me.writes) return `the login ${me.u} owns or may write tables in the schema`;
  return null;
}

/**
 * Run `fn` over the read-only login: a connection of its own, closed after;
 * a read-only transaction with the time budget, always rolled back; the
 * server's search path. A run past its budget plus a grace period loses its
 * connection.
 */
export async function withReadOnlyLogin<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const driver = getDriver();
  if (!(driver instanceof PostgresDriver)) throw new ReadOnlyUnavailable(`not on ${driver.name}`);
  if (lastFailure && Date.now() - lastFailure.at < FAILURE_BACKOFF_MS) throw lastFailure.error;
  if (running >= MAX_CONCURRENT) throw new ReadOnlyBusy(`${MAX_CONCURRENT} SQL runs are already in progress; try again in a moment`);
  running++;
  try {
    const server = await serverSide();
    let connected = false;
    const attempt = (url: string) => driver.isolated(async () => {
      connected = true;
      await db.exec(`SET TRANSACTION READ ONLY`);
      await db.exec(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
      await db.exec(`SET LOCAL search_path = ${server.searchPath}`);
      const problem = await loginProblem(server.user);
      if (problem) throw new ReadOnlyUnavailable(`read-only SQL refused: ${problem}`);
      return fn();
    }, { tx: "rollback", url, deadlineMs: timeoutMs + DEADLINE_GRACE_MS });
    const loginFailed = (e: unknown) => ["28P01", "28000"].includes(String((e as { errno?: unknown }).errno));
    const unreachable = (e: unknown) => new ReadOnlyUnavailable(
      process.env["VAULTBASE_PG_READONLY_URL"]
        ? `couldn't connect with VAULTBASE_PG_READONLY_URL (${e instanceof Error ? e.message : String(e)})`
        : `couldn't connect as the read-only login (${e instanceof Error ? e.message : String(e)}). A connection pooler or pg_hba.conf may not know it; set VAULTBASE_PG_READONLY_URL.`,
    );
    // Passing conditions, not a broken setup: no backoff.
    const transient = (e: unknown) => e instanceof DeadlineExceeded || ["53300", "57P03"].includes(String((e as { errno?: unknown }).errno));
    let url = await readOnlyUrl();
    try {
      return await attempt(url);
    } catch (e) {
      if (!loginFailed(e) && connected) throw e;
      if (transient(e)) {
        if (e instanceof DeadlineExceeded) throw e;
        throw new ReadOnlyBusy(`the database is busy (${e instanceof Error ? e.message : String(e)}); try again in a moment`);
      }
      if (!loginFailed(e)) fail(unreachable(e));
      if (process.env["VAULTBASE_PG_READONLY_URL"]) {
        fail(new ReadOnlyUnavailable(`couldn't log in with VAULTBASE_PG_READONLY_URL: ${e instanceof Error ? e.message : String(e)}`));
      }
      // The login went missing or its password changed (a restore, a new
      // secret): set it up once more.
      cachedUrl = null;
      url = await readOnlyUrl();
      try {
        return await attempt(url);
      } catch (again) {
        if (!loginFailed(again)) throw again;
        fail(new ReadOnlyUnavailable(
          `couldn't log in as the read-only login (${again instanceof Error ? again.message : String(again)}). Check that pg_hba.conf lets it connect, or set VAULTBASE_PG_READONLY_URL.`,
        ));
      }
    }
  } finally {
    running--;
  }
}
