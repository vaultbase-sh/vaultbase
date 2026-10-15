import Elysia, { t } from "elysia";
import { db } from "../db/index.ts";
import { getCollection, parseFields, userTableName } from "../core/collections.ts";
import type { Collection } from "../db/schema.ts";
import { adminGuard } from "./_admin.ts";

export interface IndexInfo {
  name: string;
  /** The indexed columns, comma-separated in index order. */
  field: string;
  fields: string[];
  unique: boolean;
}

/** Most columns one index may cover. */
export const MAX_INDEX_FIELDS = 4;

export class IndexError extends Error {
  constructor(message: string, public readonly status: 422 = 422) { super(message); }
}

/** The column list of an index from its definition: the text between the parentheses after ON. */
function indexColumnsFromSql(sql: string): string[] {
  const on = sql.search(/\bON\b/i);
  const open = on < 0 ? -1 : sql.indexOf("(", on);
  const close = open < 0 ? -1 : sql.indexOf(")", open);
  if (open < 0 || close < 0) return [];
  return sql.slice(open + 1, close).split(",").map((c) => c.trim().replace(/\s+(ASC|DESC)$/i, "").replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

async function listIndexes(tableName: string): Promise<IndexInfo[]> {
  // Only indexes we created, named with our prefix; the database's own
  // (primary keys, inline UNIQUEs) have no definition text or another name.
  const rows = await db.all<{ name: string; sql: string | null }>(db.dialect.listIndexesSql(), [tableName]);
  const result: IndexInfo[] = [];
  for (const r of rows) {
    if (!r.sql) continue;
    if (!r.name.startsWith("idx_") && !r.name.startsWith("uniq_")) continue;
    const names = indexColumnsFromSql(r.sql);
    if (names.length === 0) continue;
    result.push({
      name: r.name,
      field: names.join(","),
      fields: names,
      unique: /^\s*CREATE\s+UNIQUE/i.test(r.sql),
    });
  }
  return result;
}

function indexName(collectionName: string, fields: string[], unique: boolean): string {
  const prefix = unique ? "uniq" : "idx";
  return `${prefix}_${collectionName}_${fields.join("_")}`;
}

/**
 * Create an index over one or more of the collection's fields, in the given
 * order (a composite index serves an equality filter on its leading fields
 * plus a sort on the next one). Throws {@link IndexError} on bad input.
 */
export async function createCollectionIndex(col: Collection, fieldNames: string[], unique = false): Promise<IndexInfo> {
  if (fieldNames.length === 0) throw new IndexError("At least one field is required");
  if (fieldNames.length > MAX_INDEX_FIELDS) throw new IndexError(`An index covers at most ${MAX_INDEX_FIELDS} fields`);
  if (new Set(fieldNames).size !== fieldNames.length) throw new IndexError("A field may appear only once in an index");
  const fields = parseFields(col.fields);
  const builtIn = ["id", "created_at", "updated_at"];
  for (const fieldName of fieldNames) {
    if (!/^[a-z0-9_]+$/.test(fieldName)) throw new IndexError("Field name must match [a-z0-9_]+");
    const existsInSchema =
      builtIn.includes(fieldName) ||
      fields.some((f) => f.name === fieldName && !f.system && f.type !== "autodate");
    if (!existsInSchema) throw new IndexError(`Field '${fieldName}' not found on '${col.name}'`);
  }
  const name = indexName(col.name, fieldNames, unique);
  const tableRef = `"${userTableName(col.name)}"`;
  const cols = fieldNames.map((f) => `"${f}"`).join(", ");
  const sql = `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${name}" ON ${tableRef} (${cols})`;
  try {
    await db.exec(sql);
  } catch (e) {
    throw new IndexError(e instanceof Error ? e.message : String(e));
  }
  return { name, field: fieldNames.join(","), fields: fieldNames, unique };
}

export function makeIndexesPlugin(jwtSecret: string) {
  return new Elysia({ name: "indexes" })
    .use(adminGuard(jwtSecret))
    // List indexes for a collection
    .get("/admin/collections/:name/indexes", async ({ params, set }) => {
      const col = await getCollection(params.name);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      try {
        const indexes = await listIndexes(userTableName(col.name));
        return { data: indexes };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e), code: 500 };
      }
    }, { requireAdmin: true })

    // Create index
    .post(
      "/admin/collections/:name/indexes",
      async ({ params, body, set }) => {
        const col = await getCollection(params.name);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        // `fields` (in index order) or the older single `field`.
        const fieldNames = body.fields ?? (body.field ? [body.field] : []);
        try {
          return { data: await createCollectionIndex(col, fieldNames, !!body.unique) };
        } catch (e) {
          set.status = e instanceof IndexError ? e.status : 500;
          return { error: e instanceof Error ? e.message : String(e), code: set.status };
        }
      },
      {
        requireAdmin: true,
        body: t.Object({
          field: t.Optional(t.String()),
          fields: t.Optional(t.Array(t.String(), { maxItems: 16 })),
          unique: t.Optional(t.Boolean()),
        }),
      }
    )

    // Drop index
    .delete("/admin/collections/:name/indexes/:indexName", async ({ params, set }) => {
      const idxName = params.indexName;

      // Bind the drop to the named collection. The old handler checked only an
      // `idx_`/`uniq_` prefix and then interpolated the raw name into SQL — so
      // one collection's index UI could drop *any* prefixed index DB-wide
      // (e.g. uniq_vaultbase_admin_email, breaking admin-email uniqueness), and
      // a name containing a `"` could break out of the identifier and, via
      // Bun's multi-statement exec(), run stacked SQL.
      const col = await getCollection(params.name);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }

      // Only drop an index that actually belongs to this collection's table.
      // listIndexes already filters to user-created idx_/uniq_ indexes.
      const owned = (await listIndexes(userTableName(col.name))).some((i) => i.name === idxName);
      if (!owned) {
        set.status = 404;
        return { error: `Index '${idxName}' not found on collection '${col.name}'`, code: 404 };
      }

      try {
        // Escape the identifier even though it is now a verified real index
        // name — defence in depth against the quote-breakout path.
        const safe = idxName.replace(/"/g, '""');
        await db.exec(`DROP INDEX IF EXISTS "${safe}"`);
        return { data: null };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e), code: 500 };
      }
    }, { requireAdmin: true });
}
