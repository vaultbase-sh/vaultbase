/**
 * Admin SQL runner — REST surface for `/_/sql`.
 *
 *   POST   /admin/sql/run                 — execute a SQL string
 *   POST   /admin/sql/sandbox/reset       — rebuild the admin's sandbox
 *   DELETE /admin/sql/sandbox             — drop the sandbox
 *   GET    /admin/sql/sandbox             — describe current sandbox state
 *
 *   GET    /admin/sql/queries             — list saved queries (per-admin)
 *   POST   /admin/sql/queries             — save
 *   GET    /admin/sql/queries/:id         — get one
 *   PATCH  /admin/sql/queries/:id         — update
 *   DELETE /admin/sql/queries/:id         — delete
 *   POST   /admin/sql/queries/:id/run     — run + bookkeep last_run_*
 *
 * Admin-only (audience: "admin"). API tokens — even with `admin` scope —
 * cannot drive these endpoints; we explicitly require an interactive
 * admin session because raw SQL bypasses every safety net (rules,
 * validation, hooks, audit trigger semantics) the rest of the system
 * depends on. Saved-query rows are owner-scoped.
 */

import Elysia, { t } from "elysia";
import { Database } from "bun:sqlite";
import { runSql, MAX_SQL_RESULT_ROWS } from "../core/sql-runner.ts";
import {
  describeSandbox,
  dropSandbox,
  resetSandbox,
  sandboxExists,
} from "../core/sql-sandbox.ts";
import {
  createSavedQuery,
  deleteSavedQuery,
  getSavedQuery,
  listSavedQueries,
  recordSavedQueryRun,
  updateSavedQuery,
} from "../core/sql-queries.ts";
import { adminGuard } from "./_admin.ts";
import { db } from "../db/index.ts";

/** 501 for the sandbox on a database without one. */
function noSandbox(set: { status?: number | string }) {
  if (db.capabilities.sandbox) return null;
  set.status = 501;
  return { error: `The SQL sandbox is not available on ${db.name}; run queries read-only.`, code: 501 };
}

export function makeSqlPlugin(jwtSecret: string, dbPath: string) {
  return new Elysia({ name: "sql-runner" })
    .use(adminGuard(jwtSecret))
    // ── Run ────────────────────────────────────────────────────────────
    .post("/admin/sql/run", async ({ admin: me, body, set }) => {
      if (body.mode === "sandbox") { const r = noSandbox(set); if (r) return r; }
      if (body.mode === "sandbox" && !sandboxExists(me.id)) {
        // Auto-create on first sandbox run for a friendlier UX. Caller can
        // also explicitly POST /sandbox/reset to rebuild on demand.
        resetSandbox(me.id, dbPath);
      }

      const result = await runSql({
        sql: body.sql,
        dbPath,
        adminId: me.id,
        mode: body.mode,
        ...(body.params ? { params: body.params } : {}),
        ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
      });
      return { data: result };
    }, {
      requireAdmin: { cookie: true, session: true },
      body: t.Object({
        sql: t.String({ maxLength: 100_000 }),
        mode: t.Union([t.Literal("readonly"), t.Literal("sandbox")]),
        params: t.Optional(t.Array(t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]))),
        timeoutMs: t.Optional(t.Number({ minimum: 100, maximum: 30_000 })),
      }),
    })

    // ── Sandbox lifecycle ──────────────────────────────────────────────
    .get("/admin/sql/sandbox", async ({ admin: me, set }) => {
      const r = noSandbox(set); if (r) return r;
      return { data: describeSandbox(me.id) };
    }, { requireAdmin: { cookie: true, session: true } })
    .post("/admin/sql/sandbox/reset", async ({ admin: me, set }) => {
      const r = noSandbox(set); if (r) return r;
      try {
        const info = resetSandbox(me.id, dbPath);
        return { data: info };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set.status = 500;
        return { error: `Sandbox reset failed: ${msg}`, code: 500 };
      }
    }, { requireAdmin: { cookie: true, session: true } })
    .delete("/admin/sql/sandbox", async ({ admin: me, set }) => {
      const r = noSandbox(set); if (r) return r;
      const removed = dropSandbox(me.id);
      return { data: { removed } };
    }, { requireAdmin: { cookie: true, session: true } })

    // ── Saved queries ──────────────────────────────────────────────────
    .get("/admin/sql/queries", async ({ admin: me }) => {
      return { data: await listSavedQueries(me.id) };
    }, { requireAdmin: { cookie: true, session: true } })
    .post("/admin/sql/queries", async ({ admin: me, set, body }) => {
      try {
        const q = await createSavedQuery({
          name: body.name,
          sql: body.sql,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ownerAdminId: me.id,
          ownerAdminEmail: me.email,
        });
        return { data: q };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set.status = 400;
        return { error: msg, code: 400 };
      }
    }, {
      requireAdmin: { cookie: true, session: true },
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        sql: t.String({ minLength: 1, maxLength: 100_000 }),
        description: t.Optional(t.String({ maxLength: 500 })),
      }),
    })
    .get("/admin/sql/queries/:id", async ({ admin: me, set, params }) => {
      const q = await getSavedQuery(params.id, me.id);
      if (!q) { set.status = 404; return { error: "Not found", code: 404 }; }
      return { data: q };
    }, { requireAdmin: { cookie: true, session: true } })
    .patch("/admin/sql/queries/:id", async ({ admin: me, set, params, body }) => {
      try {
        const patch: { name?: string; sql?: string; description?: string | null } = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.sql !== undefined) patch.sql = body.sql;
        if (body.description !== undefined) patch.description = body.description;
        const q = await updateSavedQuery(params.id, me.id, patch);
        if (!q) { set.status = 404; return { error: "Not found", code: 404 }; }
        return { data: q };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set.status = 400;
        return { error: msg, code: 400 };
      }
    }, {
      requireAdmin: { cookie: true, session: true },
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        sql: t.Optional(t.String({ minLength: 1, maxLength: 100_000 })),
        description: t.Optional(t.Union([t.String({ maxLength: 500 }), t.Null()])),
      }),
    })
    .delete("/admin/sql/queries/:id", async ({ admin: me, set, params }) => {
      const ok = await deleteSavedQuery(params.id, me.id);
      if (!ok) { set.status = 404; return { error: "Not found", code: 404 }; }
      return { data: { deleted: true } };
    }, { requireAdmin: { cookie: true, session: true } })
    .post("/admin/sql/queries/:id/run", async ({ admin: me, set, params, body }) => {
      const q = await getSavedQuery(params.id, me.id);
      if (!q) { set.status = 404; return { error: "Not found", code: 404 }; }

      if (body.mode === "sandbox") { const r = noSandbox(set); if (r) return r; }
      if (body.mode === "sandbox" && !sandboxExists(me.id)) resetSandbox(me.id, dbPath);

      const result = await runSql({
        sql: q.sql,
        dbPath,
        adminId: me.id,
        mode: body.mode,
      });
      await recordSavedQueryRun(params.id, me.id, {
        ok: result.ok,
        durationMs: result.durationMs,
        rowCount: result.rowCount,
        error: result.error ?? null,
      });
      return { data: result };
    }, {
      requireAdmin: { cookie: true, session: true },
      body: t.Object({
        mode: t.Union([t.Literal("readonly"), t.Literal("sandbox")]),
      }),
    })

    // ── Constants the UI may want to know ──────────────────────────────
    .get("/admin/sql/meta", async () => {
      return { data: { maxRows: MAX_SQL_RESULT_ROWS } };
    }, { requireAdmin: { cookie: true, session: true } })

    // ── Rich schema for IDE intellisense ───────────────────────────────
    // Pulls PRAGMA table_info + index_list + foreign_key_list for every
    // table + view in the live DB. Powers the editor's autocomplete +
    // hover providers. Read-only — no schema mutation here.
    .get("/admin/sql/schema", async ({ set }) => {
      try {
        return { data: db.name === "sqlite" ? introspectSchema(dbPath) : await introspectPostgresSchema() };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set.status = 500;
        return { error: `Schema introspection failed: ${msg}`, code: 500 };
      }
    }, { requireAdmin: { cookie: true, session: true } });
}

// ── Schema introspection ─────────────────────────────────────────────────

interface SchemaColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt: string | null;
  /** True when at least one index covers this column. */
  indexed: boolean;
}
interface SchemaIndex {
  name: string;
  cols: string[];
  unique: boolean;
  partial: boolean;
}
interface SchemaForeignKey {
  col: string;
  refTable: string;
  refCol: string;
}
interface SchemaTable {
  name: string;
  type: "table" | "view";
  /** Convention-flag: vb_ tables back vaultbase collections; vaultbase_ tables are system; sqlite_ tables are SQLite internal. */
  kind: "collection" | "system" | "user" | "sqlite";
  collectionName?: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
  /** Approximate row count (PRAGMA stat / count) — only for small tables. */
  rowCount?: number;
}
interface SchemaResponse {
  tables: SchemaTable[];
  /** Total table + view count (independent of whether returned in `tables`). */
  totals: { tables: number; views: number };
}

const ROW_COUNT_CAP = 100_000;

function tableKind(name: string): SchemaTable["kind"] {
  if (name.startsWith("sqlite_")) return "sqlite";
  if (name.startsWith("vb_")) return "collection";
  if (name.startsWith("vaultbase_")) return "system";
  return "user";
}

/**
 * The same schema description on Postgres, from the catalog, for the
 * server's own schema (current_schema()): four queries for the whole
 * schema rather than four per table.
 */
async function introspectPostgresSchema(): Promise<SchemaResponse> {
  const objs = await db.all<{ name: string; kind: string }>(
    `SELECT c.relname AS name, c.relkind AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition
      ORDER BY c.relname`,
  );
  const cols = await db.all<{ tbl: string; name: string; type: string; notnull: boolean; dflt: string | null }>(
    `SELECT c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS dflt
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
  );
  // Each key of an index as Postgres prints it: the column name, or the
  // expression for an expression index.
  const idx = await db.all<{ tbl: string; name: string; uniq: boolean; pk: boolean; partial: boolean; cols: string[] }>(
    `SELECT t.relname AS tbl, i.relname AS name, x.indisunique AS uniq, x.indisprimary AS pk,
            x.indpred IS NOT NULL AS partial,
            ARRAY(SELECT pg_get_indexdef(x.indexrelid, k, true) FROM generate_series(1, x.indnkeyatts) AS k) AS cols
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
      ORDER BY t.relname, i.relname`,
  );
  const fks = await db.all<{ tbl: string; col: string; ref_table: string; ref_col: string }>(
    `SELECT t.relname AS tbl, a.attname AS col, rt.relname AS ref_table, ra.attname AS ref_col
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class rt ON rt.oid = con.confrelid
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(col, ref)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col
       JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.ref
      WHERE n.nspname = current_schema() AND con.contype = 'f'
      ORDER BY t.relname, con.conname`,
  );

  const tables: SchemaTable[] = [];
  let tCount = 0, vCount = 0;
  for (const o of objs) {
    const type: SchemaTable["type"] = o.kind === "v" || o.kind === "m" ? "view" : "table";
    if (type === "table") tCount++; else vCount++;
    const indexes = idx.filter((i) => i.tbl === o.name);
    const indexedCols = new Set(indexes.flatMap((i) => i.cols));
    const pkCols = new Set(indexes.filter((i) => i.pk).flatMap((i) => i.cols));
    // A capped count, as on SQLite: past the cap the table isn't scanned.
    let rowCount: number | undefined;
    if (type === "table") {
      try {
        const r = await db.get<{ n: number }>(
          `SELECT count(*) AS n FROM (SELECT 1 FROM ${db.dialect.quoteIdent(o.name)} LIMIT ${ROW_COUNT_CAP + 1}) AS capped`,
        );
        if (typeof r?.n === "number") rowCount = Math.min(r.n, ROW_COUNT_CAP);
      } catch { /* not readable: no count */ }
    }
    const kind = tableKind(o.name);
    tables.push({
      name: o.name,
      type,
      kind,
      ...(kind === "collection" ? { collectionName: o.name.slice(3) } : {}),
      columns: cols.filter((c) => c.tbl === o.name).map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        pk: pkCols.has(c.name),
        dflt: c.dflt,
        indexed: indexedCols.has(c.name),
      })),
      indexes: indexes.map((i) => ({ name: i.name, cols: i.cols, unique: i.uniq, partial: i.partial })),
      foreignKeys: fks.filter((f) => f.tbl === o.name).map((f) => ({ col: f.col, refTable: f.ref_table, refCol: f.ref_col })),
      ...(rowCount !== undefined ? { rowCount } : {}),
    });
  }
  return { tables, totals: { tables: tCount, views: vCount } };
}

function introspectSchema(dbPath: string): SchemaResponse {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec("PRAGMA query_only = ON");
  } catch { /* noop */ }

  try {
    const objs = db.prepare(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_stat%'
       ORDER BY name`,
    ).all() as Array<{ name: string; type: "table" | "view" }>;

    const tables: SchemaTable[] = [];
    let tCount = 0, vCount = 0;
    for (const o of objs) {
      if (o.type === "table") tCount++; else vCount++;

      // Column metadata.
      const cols = db.prepare(`PRAGMA table_info("${o.name.replace(/"/g, '""')}")`).all() as Array<{
        cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
      }>;

      // Index metadata.
      const idxList = db.prepare(`PRAGMA index_list("${o.name.replace(/"/g, '""')}")`).all() as Array<{
        seq: number; name: string; unique: number; origin: string; partial: number;
      }>;
      const indexes: SchemaIndex[] = [];
      const indexedCols = new Set<string>();
      for (const i of idxList) {
        const cols = (db.prepare(`PRAGMA index_info("${i.name.replace(/"/g, '""')}")`).all() as Array<{
          seqno: number; cid: number; name: string;
        }>).map((c) => c.name);
        indexes.push({ name: i.name, cols, unique: i.unique === 1, partial: i.partial === 1 });
        for (const c of cols) indexedCols.add(c);
      }

      // Foreign keys.
      const fkRows = db.prepare(`PRAGMA foreign_key_list("${o.name.replace(/"/g, '""')}")`).all() as Array<{
        id: number; seq: number; table: string; from: string; to: string;
      }>;
      const foreignKeys: SchemaForeignKey[] = fkRows.map((f) => ({
        col: f.from, refTable: f.table, refCol: f.to,
      }));

      // PK columns are also "indexed" (auto-index).
      for (const c of cols) {
        if (c.pk) indexedCols.add(c.name);
      }

      // Best-effort row count — cheap on SQLite for tables with rowid + small cardinality.
      let rowCount: number | undefined;
      if (o.type === "table") {
        try {
          const r = db.prepare(`SELECT count(*) AS n FROM "${o.name.replace(/"/g, '""')}"`).get() as { n: number };
          if (typeof r?.n === "number" && r.n <= ROW_COUNT_CAP) rowCount = r.n;
          else if (typeof r?.n === "number") rowCount = ROW_COUNT_CAP; // saturate at cap
        } catch { /* maybe a strict table that fails count; skip */ }
      }

      const kind = tableKind(o.name);
      const collectionName = kind === "collection" ? o.name.slice(3) : undefined;

      const table: SchemaTable = {
        name: o.name,
        type: o.type,
        kind,
        ...(collectionName ? { collectionName } : {}),
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type || "BLOB",
          notnull: c.notnull === 1,
          pk: c.pk > 0,
          dflt: c.dflt_value,
          indexed: indexedCols.has(c.name),
        })),
        indexes,
        foreignKeys,
        ...(rowCount !== undefined ? { rowCount } : {}),
      };
      tables.push(table);
    }

    return { tables, totals: { tables: tCount, views: vCount } };
  } finally {
    db.close();
  }
}
