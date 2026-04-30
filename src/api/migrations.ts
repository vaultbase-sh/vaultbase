import Elysia, { t } from "elysia";
import {
  listCollections,
  parseFields,
} from "../core/collections.ts";
import {
  applySnapshot,
  computeSnapshotDiff,
  describeCollectionChanges,
  SnapshotShapeError,
  type ApplyMode,
  type CollectionSnapshot,
  type Snapshot,
} from "../core/migrations.ts";
import { verifyAuthToken } from "../core/sec.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

/**
 * Re-exported for tests / older imports — the canonical home is now
 * `src/core/migrations.ts`.
 */
export const _describeCollectionChanges = describeCollectionChanges;
export { computeSnapshotDiff };

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
      "/api/admin/migrations/diff",
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
        const data = await computeSnapshotDiff(snap);
        return { data };
      },
      {
        body: t.Object({
          snapshot: t.Any(),
        }),
      }
    )

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

        const mode = (body.mode ?? "additive") as ApplyMode;
        if (mode !== "additive" && mode !== "sync") {
          set.status = 422;
          return { error: "mode must be 'additive' or 'sync'", code: 422 };
        }

        let result;
        try {
          result = await applySnapshot(body.snapshot, { mode });
        } catch (e) {
          if (e instanceof SnapshotShapeError) {
            set.status = 422;
            return { error: e.message, code: 422 };
          }
          throw e;
        }

        // Preserve the existing HTTP response shape: callers expect
        // `{ created, updated, skipped, errors }` where `skipped` is the union
        // of "skipped because additive" + "unchanged because already in sync".
        return {
          data: {
            created: result.created,
            updated: result.updated,
            skipped: [...result.skipped, ...result.unchanged],
            errors:  result.errors,
          },
        };
      },
      {
        body: t.Object({
          snapshot: t.Any(),
          mode: t.Optional(t.String()),
        }),
      }
    );
}
