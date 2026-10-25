/**
 * Read-only SQL on Postgres (admin SQL page, MCP run_sql with mcp:sql).
 *
 * It used to run in a committed transaction on a pooled connection, as the
 * server's own role: a session setting it made stayed on that pooled
 * connection (one set_config('search_path', ...) broke every app query that
 * landed there), and on a superuser connection it could reach programs and
 * files on the database host. A change of role inside the session can be
 * undone from the query, so it now runs over a login of its own, made by the
 * server (src/core/pg-readonly.ts), on a connection of its own, in a
 * read-only transaction that is rolled back.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { PostgresDriver } from "../db/postgres.ts";
import { _runReadOnlyOnDriverForTests, runSql } from "../core/sql-runner.ts";
import { _resetReadOnlyLogin, configureReadOnlyLogin, derivedPassword, withCredentials } from "../core/pg-readonly.ts";
import { DeadlineExceeded } from "../db/postgres.ts";
import { createRecord } from "../core/records.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const run = (sql: string, params: unknown[] = [], timeoutMs?: number) =>
  runSql({ sql, params: params as never, dbPath: "", mode: "readonly", ...(timeoutMs ? { timeoutMs } : {}) });

const one = async (sql: string) => {
  const r = await run(sql);
  if (!r.ok) throw new Error(`${r.errorCode}: ${r.error}`);
  return r.rows[0]![0];
};

/** This install's read-only login, as the server names it. */
const loginName = async () =>
  (await db.get<{ n: string }>(`SELECT 'vb_ro_' || left(md5(current_database() || '/' || current_schema()), 16) AS n`))!.n;

describe.skipIf(onSqlite)("read-only SQL on Postgres", () => {
  beforeEach(async () => {
    _resetReadOnlyLogin();
    configureReadOnlyLogin("test-secret-readonly-login");
    await initDb(":memory:");
    await runMigrations();
    await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("posts", { title: "one" }, null);
    await createRecord("posts", { title: "two" }, null);
  });
  afterEach(async () => {
    delete process.env["VAULTBASE_PG_READONLY_URL"];
    await closeDb();
  });

  describe("reads still work", () => {
    it("SELECT, WITH, VALUES, EXPLAIN, SHOW, parameters; unqualified names resolve in the server's schema", async () => {
      const sel = await run("SELECT title FROM vb_posts WHERE title = ? ORDER BY title", ["two"]);
      expect(sel.ok).toBe(true);
      expect(sel.rows).toEqual([["two"]]);
      expect((await run("WITH t AS (SELECT count(*) AS n FROM vb_posts) SELECT n FROM t")).rows).toEqual([[2]]);
      expect((await run("VALUES (1)")).ok).toBe(true);
      expect((await run("EXPLAIN SELECT * FROM vb_posts")).ok).toBe(true);
      expect((await run("SHOW search_path")).ok).toBe(true);
      expect((await run("(SELECT 1 AS x)")).ok).toBe(true);
    });

    it("names and strings that look like functions or dollar quotes are fine", async () => {
      expect((await run(`SELECT 1 AS ts_status, 2 AS dblink_url, '$2b$10$abc' AS bcrypt`)).ok).toBe(true);
    });

    it("a huge result is fetched through a cursor: capped, fast, marked truncated", async () => {
      const started = Date.now();
      const r = await run("SELECT g FROM generate_series(1, 5000000) AS g");
      expect(r.ok).toBe(true);
      expect(r.rows).toHaveLength(1000);
      expect(r.truncated).toBe(true);
      // Only 1,001 rows came from Postgres; past the cap the total isn't
      // known, so the count is "1,000 or more".
      expect(r.rowCount).toBe(1000);
      expect(r.rowCountExact).toBe(false);
      expect(Date.now() - started).toBeLessThan(3000);
      const small = await run("SELECT g FROM generate_series(1, 3) AS g");
      expect(small.rows).toEqual([[1], [2], [3]]);
      expect(small.truncated).toBe(false);
      expect(small.rowCountExact).toBeUndefined();
    });

    it("a runaway query still times out", async () => {
      const r = await run("SELECT pg_sleep(5)", [], 300);
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe("TIMEOUT");
    });
  });

  describe("one statement, enforced by Postgres", () => {
    it("a second statement is refused by the protocol, whatever the text check says", async () => {
      const r = await _runReadOnlyOnDriverForTests("SELECT 1; SELECT 2");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain("cannot insert multiple commands");
    });

    it("$1 without parameters is refused instead of reading the internal one", async () => {
      const r = await run("SELECT $1 AS x");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("no parameters");
      expect((await run("SELECT '$1' AS literal")).rows).toEqual([["$1"]]);
    });

    it("a trailing semicolon is fine, and so is a jsonb ? operator without parameters", async () => {
      expect((await run("SELECT 1 AS x;  ")).rows).toEqual([[1]]);
      expect((await run(`SELECT '{"a":1}'::jsonb ? 'a' AS has`)).rows).toEqual([[true]]);
      expect((await run("SELECT ?::int + 1 AS y", [41])).rows).toEqual([[42]]);
    });
  });

  it.each(["COPY (SELECT 1) TO STDOUT", "SET search_path = nowhere", "RESET ALL", "PREPARE p AS SELECT 1", "CALL x()", "LOCK TABLE vb_posts", "BEGIN"])(
    "the statement check refuses %s with a clear error",
    async (sql) => {
      const r = await run(sql);
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe("VAULTBASE_READONLY");
    },
  );

  describe("the login", () => {
    it("runs as this install's read-only login, which can read and nothing else", async () => {
      const name = await loginName();
      expect(await one("SELECT current_user")).toBe(name);
      expect(await one("SELECT session_user")).toBe(name);
      const role = await db.get<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
        `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ?`, [name],
      );
      expect(role).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true });
      const member = (await db.all<{ r: string }>(
        `SELECT g.rolname AS r FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = ?`, [name],
      )).map((x) => x.r);
      // No role memberships at all (not pg_read_all_data, which reaches
      // every schema and database): grants on this install's schema only.
      expect(member).toEqual([]);
    });

    it("the query can't take the server's role back", async () => {
      const server = (await db.get<{ u: string }>(`SELECT current_user AS u`))!.u;
      const r = await _runReadOnlyOnDriverForTests(`SELECT set_config('role', '${server}', true)`);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe("42501");
      // Files on the database host stay out of reach: Postgres refuses it
      // (there is no name check in front any more).
      const file = await run("SELECT pg_read_file('/etc/hostname')");
      expect(file.ok).toBe(false);
      expect(file.error).toContain("permission denied");
    });

    it("its password is derived, not stored, and Postgres holds only a SCRAM verifier", async () => {
      await one("SELECT 1");
      const name = await loginName();
      const stored = await db.all<{ key: string }>(`SELECT key FROM vaultbase_settings WHERE key LIKE '%readonly%'`);
      expect(stored).toEqual([]);
      const secret = await db.get<{ p: string | null }>(`SELECT rolpassword AS p FROM pg_authid WHERE rolname = ?`, [name]);
      expect(secret!.p).toMatch(/^SCRAM-SHA-256\$4096:/);
      expect(secret!.p).not.toContain(await derivedPassword(name));
    });

    it("its defaults pin read-only transactions and time limits", async () => {
      await one("SELECT 1");
      const cfg = (await db.get<{ c: string[] }>(`SELECT rolconfig AS c FROM pg_roles WHERE rolname = ?`, [await loginName()]))!.c;
      expect(cfg).toEqual(expect.arrayContaining(["default_transaction_read_only=on", "statement_timeout=30s"]));
    });

    it("reads this install's schema only, not other schemas of the database", async () => {
      await db.exec(`CREATE SCHEMA IF NOT EXISTS vb_ro_other_probe`);
      try {
        await db.exec(`CREATE TABLE vb_ro_other_probe.secrets (x int)`);
        const r = await run("SELECT * FROM vb_ro_other_probe.secrets");
        expect(r.ok).toBe(false);
        expect(r.error).toContain("permission denied");
        // A collection made after the login still reads (default privileges).
        await createPublicCollection({ name: "later", fields: JSON.stringify([{ name: "t", type: "text" }]) });
        expect((await run("SELECT count(*) FROM vb_later")).rows).toEqual([[0]]);
      } finally {
        await db.exec(`DROP SCHEMA vb_ro_other_probe CASCADE`);
      }
    });

    it("CREATE granted to everyone on the schema (Postgres 14 and older) doesn't refuse the login; its own grant does", async () => {
      await one("SELECT 1");
      const schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
      await db.exec(`GRANT CREATE ON SCHEMA "${schema}" TO PUBLIC`);
      expect((await run("SELECT 1")).ok).toBe(true);
      await db.exec(`REVOKE CREATE ON SCHEMA "${schema}" FROM PUBLIC`);
      await db.exec(`GRANT CREATE ON SCHEMA "${schema}" TO "${await loginName()}"`);
      const r = await run("SELECT 1");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("may create objects");
    });

    it("heals when its password no longer matches (a restore, a new secret)", async () => {
      await one("SELECT 1");
      const name = await loginName();
      await db.exec(`ALTER ROLE "${name}" PASSWORD 'something-else-entirely'`);
      expect(await one("SELECT current_user")).toBe(name);
    });

    it("refuses to set up a login that other roles were granted", async () => {
      await one("SELECT 1");
      const name = await loginName();
      const other = `vb_ro_grantee_${process.pid}`;
      await db.exec(`DROP ROLE IF EXISTS ${other}`);
      await db.exec(`CREATE ROLE ${other} NOLOGIN`);
      await db.exec(`GRANT "${name}" TO ${other}`);
      try {
        await db.exec(`ALTER ROLE "${name}" PASSWORD 'force-a-re-setup'`);
        const r = await run("SELECT 1");
        expect(r.ok).toBe(false);
        expect(r.errorCode).toBe("VAULTBASE_NO_READONLY");
        expect(r.error).toContain("other roles are granted");
      } finally {
        await db.exec(`DROP ROLE ${other}`);
      }
    });

    it("comes back after it was dropped, with the same name", async () => {
      await one("SELECT 1");
      const name = await loginName();
      await db.exec(`DROP OWNED BY "${name}"; DROP ROLE "${name}"`);
      expect(await one("SELECT current_user")).toBe(name);
    });

    it("a login given more rights than reading is refused", async () => {
      await one("SELECT 1");
      const name = await loginName();
      await db.exec(`ALTER ROLE "${name}" CREATEDB`);
      const r = await run("SELECT 1");
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe("VAULTBASE_NO_READONLY");
      expect(r.error).toContain("more than read access");
    });

    it("someone else's role with the login's name is never taken over", async () => {
      const name = await loginName();
      await db.exec(`CREATE ROLE "${name}" NOLOGIN`);
      try {
        const r = await run("SELECT 1");
        expect(r.ok).toBe(false);
        expect(r.errorCode).toBe("VAULTBASE_NO_READONLY");
        expect(r.error).toContain("isn't Vaultbase's");
        expect((await db.get<{ c: boolean }>(`SELECT rolcanlogin AS c FROM pg_roles WHERE rolname = ?`, [name]))!.c).toBe(false);
      } finally {
        await db.exec(`DROP ROLE "${name}"`);
      }
    });

    it("VAULTBASE_PG_READONLY_URL names the operator's own login, and is checked like the server's", async () => {
      const driver = getDriver() as PostgresDriver;
      const own = `vb_ro_operator_${process.pid}`;
      await db.exec(`DROP ROLE IF EXISTS ${own}`);
      await db.exec(`CREATE ROLE ${own} LOGIN PASSWORD 'operator-pw-1'`);
      await db.exec(`GRANT pg_read_all_data TO ${own}`);
      try {
        process.env["VAULTBASE_PG_READONLY_URL"] = withCredentials(driver.url, own, "operator-pw-1");
        expect(await one("SELECT current_user")).toBe(own);
        // The server's own superuser login named there is refused.
        _resetReadOnlyLogin();
        process.env["VAULTBASE_PG_READONLY_URL"] = driver.url;
        const r = await run("SELECT 1");
        expect(r.ok).toBe(false);
        expect(r.errorCode).toBe("VAULTBASE_NO_READONLY");
      } finally {
        delete process.env["VAULTBASE_PG_READONLY_URL"];
        _resetReadOnlyLogin();
        await db.exec(`DROP ROLE ${own}`);
      }
    });
  });

  it("the server's search path is pinned, even when the login's URL doesn't set one", async () => {
    const driver = getDriver() as PostgresDriver;
    const own = `vb_ro_nopath_${process.pid}`;
    await db.exec(`DROP ROLE IF EXISTS ${own}`);
    await db.exec(`CREATE ROLE ${own} LOGIN PASSWORD 'operator-pw-2'`);
    await db.exec(`GRANT pg_read_all_data TO ${own}`);
    try {
      // The test schema reaches the pool through options=-c search_path=...;
      // without it the login would land in "$user", public.
      process.env["VAULTBASE_PG_READONLY_URL"] = withCredentials(driver.url, own, "operator-pw-2").replace(/[?&]options=[^&]*/, "");
      expect(process.env["VAULTBASE_PG_READONLY_URL"]).not.toContain("search_path");
      expect((await run("SELECT count(*) FROM vb_posts")).rows).toEqual([[2]]);
    } finally {
      delete process.env["VAULTBASE_PG_READONLY_URL"];
      _resetReadOnlyLogin();
      await db.exec(`DROP ROLE ${own}`);
    }
  });

  it("too many connections is a busy answer, not a minute-long lockout", async () => {
    const driver = getDriver() as PostgresDriver;
    const own = `vb_ro_limit_${process.pid}`;
    await db.exec(`DROP ROLE IF EXISTS ${own}`);
    await db.exec(`CREATE ROLE ${own} LOGIN CONNECTION LIMIT 0 PASSWORD 'limit-pw-1'`);
    await db.exec(`GRANT USAGE ON SCHEMA "${(await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s}" TO ${own}`);
    await db.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA "${(await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s}" TO ${own}`);
    try {
      process.env["VAULTBASE_PG_READONLY_URL"] = withCredentials(driver.url, own, "limit-pw-1");
      const busy = await run("SELECT 1");
      expect(busy.ok).toBe(false);
      expect(busy.errorCode).toBe("VAULTBASE_BUSY");
      await db.exec(`ALTER ROLE ${own} CONNECTION LIMIT 5`);
      expect((await run("SELECT 1")).ok).toBe(true);
    } finally {
      delete process.env["VAULTBASE_PG_READONLY_URL"];
      _resetReadOnlyLogin();
      await db.get(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = ?`, [own]);
      await db.exec(`DROP OWNED BY ${own}; DROP ROLE ${own}`);
    }
  });

  describe("the connection of its own", () => {
    it("is gone after the run", async () => {
      const name = await loginName();
      expect(await one("SELECT current_user")).toBe(name);
      let left = 1;
      for (let i = 0; i < 50 && left > 0; i++) {
        left = Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE usename = ?`, [name]))!.n);
        if (left > 0) await Bun.sleep(20);
      }
      expect(left).toBe(0);
    });

    it("an advisory lock the query takes goes with it", async () => {
      expect((await _runReadOnlyOnDriverForTests(`SELECT pg_advisory_lock(123123)`)).ok).toBe(true);
      let held = 1;
      for (let i = 0; i < 50 && held > 0; i++) {
        held = Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 123123`))!.n);
        if (held > 0) await Bun.sleep(20);
      }
      expect(held).toBe(0);
    });

    it("at most 4 runs at once per server", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => run("SELECT pg_sleep(0.4)")));
      expect(results.filter((r) => r.ok)).toHaveLength(4);
      const busy = results.filter((r) => !r.ok);
      expect(busy).toHaveLength(2);
      expect(busy.every((r) => r.errorCode === "VAULTBASE_BUSY" && /in progress/.test(r.error ?? ""))).toBe(true);
      expect((await run("SELECT 1")).ok).toBe(true);
    });
  });

  it("an operator's login that owns the tables is refused, like the server's own", async () => {
    const driver = getDriver() as PostgresDriver;
    const owner = `vb_ro_owner_${process.pid}`;
    await db.exec(`DROP ROLE IF EXISTS ${owner}`);
    await db.exec(`CREATE ROLE ${owner} LOGIN PASSWORD 'owner-pw-1'`);
    await db.exec(`GRANT USAGE ON SCHEMA "${(await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s}" TO ${owner}`);
    await db.exec(`GRANT SELECT, INSERT ON vb_posts TO ${owner}`);
    try {
      process.env["VAULTBASE_PG_READONLY_URL"] = withCredentials(driver.url, owner, "owner-pw-1");
      const r = await run("SELECT 1");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("may write tables");
    } finally {
      delete process.env["VAULTBASE_PG_READONLY_URL"];
      _resetReadOnlyLogin();
      await db.exec(`DROP OWNED BY ${owner}; DROP ROLE ${owner}`);
    }
  });

  describe("isolated()", () => {
    it("a deadline ends a call over another login, which the server's role may not signal", async () => {
      const driver = getDriver() as PostgresDriver;
      const other = `vb_ro_deadline_${process.pid}`;
      await db.exec(`DROP ROLE IF EXISTS ${other}`);
      await db.exec(`CREATE ROLE ${other} LOGIN PASSWORD 'deadline-pw-1'`);
      try {
        const started = Date.now();
        await expect(driver.isolated(async () => { await db.get(`SELECT pg_sleep(4)`); }, {
          tx: "rollback", deadlineMs: 300, url: withCredentials(driver.url, other, "deadline-pw-1"),
        })).rejects.toBeInstanceOf(DeadlineExceeded);
        expect(Date.now() - started).toBeLessThan(1500);
        let left = 1;
        for (let i = 0; i < 100 && left > 0; i++) {
          left = Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE usename = ?`, [other]))!.n);
          if (left > 0) await Bun.sleep(20);
        }
        expect(left).toBe(0);
      } finally {
        await db.get(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = ?`, [other]);
        await db.exec(`DROP ROLE ${other}`);
      }
    });

    it("refuses a deadline with tx: commit (a commit could land after it fired)", async () => {
      const driver = getDriver() as PostgresDriver;
      await expect(driver.isolated(async () => 1, { tx: "commit", deadlineMs: 1000 })).rejects.toThrow(/deadline/);
    });

    it("a deadline closes the connection of a call that runs too long", async () => {
      const driver = getDriver() as PostgresDriver;
      const started = Date.now();
      await expect(driver.isolated(async () => { await db.get(`SELECT pg_sleep(3)`); }, { tx: "rollback", deadlineMs: 300 })).rejects.toBeInstanceOf(DeadlineExceeded);
      expect(Date.now() - started).toBeLessThan(2500);
    });


    it("rollback undoes, commit keeps, none runs what a transaction can't (VACUUM)", async () => {
      const driver = getDriver() as PostgresDriver;
      await driver.isolated(async () => { await db.run(`UPDATE vb_posts SET title = 'gone' WHERE title = 'one'`); }, { tx: "rollback" });
      expect((await db.get<{ n: number }>(`SELECT count(*) AS n FROM vb_posts WHERE title = 'one'`))!.n).toBe(1);
      await driver.isolated(async () => { await db.run(`UPDATE vb_posts SET title = 'kept' WHERE title = 'one'`); }, { tx: "commit" });
      expect((await db.get<{ n: number }>(`SELECT count(*) AS n FROM vb_posts WHERE title = 'kept'`))!.n).toBe(1);
      await driver.isolated(async () => { await db.run(`VACUUM vb_posts`); }, { tx: "none" });
    });

    it("a setting made inside doesn't reach the pool, in every mode", async () => {
      const driver = getDriver() as PostgresDriver;
      for (const tx of ["rollback", "commit", "none"] as const) {
        await driver.isolated(async () => { await db.get(`SELECT set_config('search_path', 'nowhere', false)`); }, { tx });
      }
      const paths = await Promise.all(Array.from({ length: 16 }, () => db.get<{ v: string }>(`SELECT current_setting('search_path') AS v, pg_sleep(0.02)`)));
      expect(paths.every((p) => p!.v !== "nowhere")).toBe(true);
    });

    it("refuses to run inside an open transaction", async () => {
      const driver = getDriver() as PostgresDriver;
      await expect(db.transaction(() => driver.isolated(async () => 1, { tx: "commit" }))).rejects.toThrow(/open transaction/);
    });
  });
});
