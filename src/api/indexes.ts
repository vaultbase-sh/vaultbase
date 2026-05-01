import type { Database } from "bun:sqlite";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { getCollection, parseFields, userTableName } from "../core/collections.ts";
import { verifyAuthToken } from "../core/sec.ts";

interface IndexInfo {
  name: string;
  field: string;
  unique: boolean;
}

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

function listIndexes(tableName: string): IndexInfo[] {
  const client = rawClient();
  // PRAGMA index_list returns: { seq, name, unique, origin, partial }
  const rows = client.prepare(`PRAGMA index_list(${JSON.stringify(tableName)})`).all() as Array<{
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;
  // Skip auto-generated indexes (e.g. for PRIMARY KEY) — origin == 'pk' or 'u' from schema
  // Keep only indexes we created (origin === 'c' = created by user) AND named with our prefix
  const result: IndexInfo[] = [];
  for (const r of rows) {
    if (r.origin !== "c") continue;
    if (!r.name.startsWith("idx_") && !r.name.startsWith("uniq_")) continue;
    // Get the column(s) the index covers
    const cols = client.prepare(`PRAGMA index_info(${JSON.stringify(r.name)})`).all() as Array<{
      seqno: number;
      cid: number;
      name: string;
    }>;
    if (cols.length === 0) continue;
    result.push({
      name: r.name,
      field: cols.map((c) => c.name).join(","),
      unique: r.unique === 1,
    });
  }
  return result;
}

function indexName(collectionName: string, field: string, unique: boolean): string {
  const prefix = unique ? "uniq" : "idx";
  return `${prefix}_${collectionName}_${field}`;
}

export function makeIndexesPlugin(jwtSecret: string) {
  return new Elysia({ name: "indexes" })
    // List indexes for a collection
    .get("/admin/collections/:name/indexes", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const col = await getCollection(params.name);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      try {
        const indexes = listIndexes(userTableName(col.name));
        return { data: indexes };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e), code: 500 };
      }
    })

    // Create index
    .post(
      "/admin/collections/:name/indexes",
      async ({ request, params, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const col = await getCollection(params.name);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }

        const fields = parseFields(col.fields);
        const fieldName = body.field;
        if (!/^[a-z0-9_]+$/.test(fieldName)) {
          set.status = 422;
          return { error: "Field name must match [a-z0-9_]+", code: 422 };
        }
        const builtIn = ["id", "created_at", "updated_at"];
        const existsInSchema =
          builtIn.includes(fieldName) ||
          fields.some((f) => f.name === fieldName && !f.system && f.type !== "autodate");
        if (!existsInSchema) {
          set.status = 422;
          return { error: `Field '${fieldName}' not found on '${col.name}'`, code: 422 };
        }

        const isUnique = !!body.unique;
        const name = indexName(col.name, fieldName, isUnique);
        const tableRef = `"${userTableName(col.name)}"`;
        const sql = `CREATE ${isUnique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${name}" ON ${tableRef} ("${fieldName}")`;
        try {
          rawClient().exec(sql);
          return { data: { name, field: fieldName, unique: isUnique } };
        } catch (e) {
          set.status = 422;
          return { error: e instanceof Error ? e.message : String(e), code: 422 };
        }
      },
      { body: t.Object({ field: t.String(), unique: t.Optional(t.Boolean()) }) }
    )

    // Drop index
    .delete("/admin/collections/:name/indexes/:indexName", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const idxName = params.indexName;
      // Sanity check: only allow our prefixes
      if (!idxName.startsWith("idx_") && !idxName.startsWith("uniq_")) {
        set.status = 422;
        return { error: "Refusing to drop index outside vaultbase prefix", code: 422 };
      }
      try {
        rawClient().exec(`DROP INDEX IF EXISTS "${idxName}"`);
        return { data: null };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e), code: 500 };
      }
    });
}
