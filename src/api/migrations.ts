import Elysia, { t } from "elysia";
import * as jose from "jose";
import {
  CollectionValidationError,
  createCollection,
  getCollection,
  listCollections,
  parseFields,
  updateCollection,
  type FieldDef,
} from "../core/collections.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  try {
    await jose.jwtVerify(token, new TextEncoder().encode(jwtSecret), { audience: "admin" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stable JSON shape for a collection definition. Persisted across environments
 * and applied by `/migrations/apply`. We deliberately drop `id`, `created_at`,
 * `updated_at` — `name` is the cross-environment identifier.
 */
interface CollectionSnapshot {
  name: string;
  type: "base" | "auth" | "view";
  fields: FieldDef[];
  view_query?: string | null;
  list_rule?: string | null;
  view_rule?: string | null;
  create_rule?: string | null;
  update_rule?: string | null;
  delete_rule?: string | null;
}

interface Snapshot {
  /** Iso timestamp of the snapshot. */
  generated_at: string;
  /** Schema version of the snapshot format itself — bump if we change the shape. */
  version: 1;
  collections: CollectionSnapshot[];
}

interface ApplyResult {
  created: string[];
  updated: string[];
  skipped: string[];
  errors: Array<{ collection: string; error: string }>;
}

function fieldsEqual(a: FieldDef[], b: FieldDef[]): boolean {
  if (a.length !== b.length) return false;
  // Compare normalized JSON to ignore field-order shuffles inside `options`.
  return JSON.stringify(a) === JSON.stringify(b);
}

function isCollectionInSync(existing: Awaited<ReturnType<typeof getCollection>>, snap: CollectionSnapshot): boolean {
  if (!existing) return false;
  if (existing.type !== snap.type) return false;
  if ((existing.view_query ?? null) !== (snap.view_query ?? null)) return false;
  if ((existing.list_rule ?? null)   !== (snap.list_rule ?? null))   return false;
  if ((existing.view_rule ?? null)   !== (snap.view_rule ?? null))   return false;
  if ((existing.create_rule ?? null) !== (snap.create_rule ?? null)) return false;
  if ((existing.update_rule ?? null) !== (snap.update_rule ?? null)) return false;
  if ((existing.delete_rule ?? null) !== (snap.delete_rule ?? null)) return false;
  return fieldsEqual(parseFields(existing.fields), snap.fields);
}

export function makeMigrationsPlugin(jwtSecret: string) {
  return new Elysia({ name: "migrations" })
    .get("/api/admin/migrations/snapshot", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      const cols = await listCollections();
      const snapshot: Snapshot = {
        generated_at: new Date().toISOString(),
        version: 1,
        collections: cols.map((c): CollectionSnapshot => {
          const out: CollectionSnapshot = {
            name: c.name,
            type: (c.type ?? "base") as "base" | "auth" | "view",
            fields: parseFields(c.fields),
          };
          if (c.view_query !== null && c.view_query !== undefined) out.view_query = c.view_query;
          if (c.list_rule !== null   && c.list_rule !== undefined)   out.list_rule   = c.list_rule;
          if (c.view_rule !== null   && c.view_rule !== undefined)   out.view_rule   = c.view_rule;
          if (c.create_rule !== null && c.create_rule !== undefined) out.create_rule = c.create_rule;
          if (c.update_rule !== null && c.update_rule !== undefined) out.update_rule = c.update_rule;
          if (c.delete_rule !== null && c.delete_rule !== undefined) out.delete_rule = c.delete_rule;
          return out;
        }),
      };
      set.headers["Content-Type"] = "application/json; charset=utf-8";
      set.headers["Content-Disposition"] = `attachment; filename="vaultbase-snapshot-${snapshot.generated_at.slice(0, 10)}.json"`;
      return snapshot;
    })

    .post(
      "/api/admin/migrations/apply",
      async ({ request, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        if (!body.snapshot || typeof body.snapshot !== "object") {
          set.status = 422;
          return { error: "snapshot object required", code: 422 };
        }
        const snap = body.snapshot as Snapshot;
        if (snap.version !== 1) {
          set.status = 422;
          return { error: `Unsupported snapshot version: ${snap.version}`, code: 422 };
        }
        if (!Array.isArray(snap.collections)) {
          set.status = 422;
          return { error: "snapshot.collections must be an array", code: 422 };
        }

        const mode = body.mode ?? "additive";
        if (mode !== "additive" && mode !== "sync") {
          set.status = 422;
          return { error: "mode must be 'additive' or 'sync'", code: 422 };
        }

        const result: ApplyResult = { created: [], updated: [], skipped: [], errors: [] };

        for (const c of snap.collections) {
          if (!c.name || typeof c.name !== "string") {
            result.errors.push({ collection: String(c?.name ?? "?"), error: "missing name" });
            continue;
          }
          const existing = await getCollection(c.name);

          if (!existing) {
            try {
              await createCollection({
                name: c.name,
                type: c.type,
                fields: JSON.stringify(c.fields ?? []),
                view_query: c.view_query ?? null,
                list_rule: c.list_rule ?? null,
                view_rule: c.view_rule ?? null,
                create_rule: c.create_rule ?? null,
                update_rule: c.update_rule ?? null,
                delete_rule: c.delete_rule ?? null,
              });
              result.created.push(c.name);
            } catch (e) {
              result.errors.push({
                collection: c.name,
                error: e instanceof CollectionValidationError ? e.message
                     : e instanceof Error ? e.message
                     : String(e),
              });
            }
            continue;
          }

          // Existing collection
          if (mode === "additive") {
            result.skipped.push(c.name);
            continue;
          }

          // sync mode
          if (isCollectionInSync(existing, c)) {
            result.skipped.push(c.name);
            continue;
          }
          if (existing.type !== c.type) {
            // Changing type would re-create storage; require manual intervention.
            result.errors.push({
              collection: c.name,
              error: `cannot change type ${existing.type} → ${c.type} via sync (drop the collection manually first)`,
            });
            continue;
          }
          try {
            await updateCollection(existing.id, {
              fields: JSON.stringify(c.fields ?? []),
              view_query: c.view_query ?? null,
              list_rule: c.list_rule ?? null,
              view_rule: c.view_rule ?? null,
              create_rule: c.create_rule ?? null,
              update_rule: c.update_rule ?? null,
              delete_rule: c.delete_rule ?? null,
            });
            result.updated.push(c.name);
          } catch (e) {
            result.errors.push({
              collection: c.name,
              error: e instanceof CollectionValidationError ? e.message
                   : e instanceof Error ? e.message
                   : String(e),
            });
          }
        }

        return { data: result };
      },
      {
        body: t.Object({
          snapshot: t.Any(),
          mode: t.Optional(t.String()),
        }),
      }
    );
}
