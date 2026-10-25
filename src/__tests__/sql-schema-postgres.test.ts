/**
 * /admin/sql/schema on Postgres. It opened <dataDir>/data.db with bun:sqlite
 * whatever the database: a 500 when there was no such file, or the schema of
 * a stale SQLite file when one was left behind. On Postgres it now reads the
 * catalog of the server's schema.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Elysia from "elysia";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeSqlPlugin } from "../api/sql.ts";
import { createRecord } from "../core/records.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const SECRET = "test-secret-sql-schema-pg";

type Body = { data: { tables: Array<{
  name: string; type: string; kind: string; collectionName?: string; rowCount?: number;
  columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean; dflt: string | null; indexed: boolean }>;
  indexes: Array<{ name: string; cols: string[]; unique: boolean; partial: boolean }>;
  foreignKeys: Array<{ col: string; refTable: string; refCol: string }>;
}>; totals: { tables: number; views: number } } };

describe.skipIf(onSqlite)("/admin/sql/schema on Postgres", () => {
  let token: string;

  beforeEach(async () => {
    await initDb(":memory:");
    await runMigrations();
    await getDb().insert(admin).values({ id: "a1", email: "a1@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    token = (await signAuthToken({ payload: { id: "a1", email: "a1@test.local" }, audience: "admin", expiresInSeconds: 3600, jwtSecret: SECRET })).token;
    await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("posts", { title: "one" }, null);
    await db.exec(`CREATE TABLE widgets (id text PRIMARY KEY, name text NOT NULL DEFAULT 'w', owner text REFERENCES vaultbase_admin(id))`);
    await db.exec(`CREATE UNIQUE INDEX widgets_lower_name ON widgets (lower(name)) WHERE owner IS NOT NULL`);
    await db.exec(`CREATE VIEW widget_names AS SELECT name FROM widgets`);
  });
  afterEach(() => closeDb());

  // A data directory with no data.db: what used to answer 500.
  const schema = async () => {
    const app = new Elysia().group("/api/v1", (a) => a.use(makeSqlPlugin(SECRET, "/nonexistent/data.db"))) as unknown as Elysia;
    const res = await app.handle(new Request("http://localhost/api/v1/admin/sql/schema", { headers: { Authorization: `Bearer ${token}` } }));
    return { status: res.status, body: (await res.json()) as Body };
  };

  it("needs an admin", async () => {
    const app = new Elysia().group("/api/v1", (a) => a.use(makeSqlPlugin(SECRET, "/nonexistent/data.db"))) as unknown as Elysia;
    expect((await app.handle(new Request("http://localhost/api/v1/admin/sql/schema"))).status).toBe(401);
  });

  it("describes tables, views, columns, indexes and foreign keys from the catalog", async () => {
    const { status, body } = await schema();
    expect(status).toBe(200);
    const byName = new Map(body.data.tables.map((t) => [t.name, t]));

    const posts = byName.get("vb_posts")!;
    expect(posts.kind).toBe("collection");
    expect(posts.collectionName).toBe("posts");
    expect(posts.rowCount).toBe(1);
    const id = posts.columns.find((c) => c.name === "id")!;
    expect(id.pk).toBe(true);
    expect(id.indexed).toBe(true);
    expect(posts.columns.map((c) => c.name)).toContain("title");

    expect(byName.get("vaultbase_collections")!.kind).toBe("system");

    const widgets = byName.get("widgets")!;
    expect(widgets.kind).toBe("user");
    expect(widgets.type).toBe("table");
    const name = widgets.columns.find((c) => c.name === "name")!;
    expect(name.notnull).toBe(true);
    expect(name.type).toBe("text");
    expect(name.dflt).toBe("'w'::text");
    expect(widgets.foreignKeys).toEqual([{ col: "owner", refTable: "vaultbase_admin", refCol: "id" }]);
    const expr = widgets.indexes.find((i) => i.name === "widgets_lower_name")!;
    expect(expr.unique).toBe(true);
    expect(expr.partial).toBe(true);
    expect(expr.cols).toEqual(["lower(name)"]);
    expect(widgets.indexes.find((i) => i.name === "widgets_pkey")!.cols).toEqual(["id"]);

    const view = byName.get("widget_names")!;
    expect(view.type).toBe("view");
    expect(view.rowCount).toBeUndefined();
    expect(view.columns.map((c) => c.name)).toEqual(["name"]);

    expect(body.data.totals.views).toBe(1);
    expect(body.data.totals.tables).toBe(body.data.tables.length - 1);
  });

  it("lists only the server's own schema", async () => {
    await db.exec(`CREATE SCHEMA IF NOT EXISTS vb_other_schema_probe`);
    try {
      await db.exec(`CREATE TABLE vb_other_schema_probe.elsewhere (x int)`);
      const { body } = await schema();
      expect(body.data.tables.map((t) => t.name)).not.toContain("elsewhere");
    } finally {
      await db.exec(`DROP SCHEMA vb_other_schema_probe CASCADE`);
    }
  });
});
