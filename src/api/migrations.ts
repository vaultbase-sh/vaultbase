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
import { adminGuard } from "./_admin.ts";

/**
 * Re-exported for tests / older imports — the canonical home is now
 * `src/core/migrations.ts`.
 */
export const _describeCollectionChanges = describeCollectionChanges;
export { computeSnapshotDiff };

export function makeMigrationsPlugin(jwtSecret: string) {
  return new Elysia({ name: "migrations" })
    .use(adminGuard(jwtSecret))
    .get("/admin/migrations/snapshot", async ({ set }) => {
      const cols = await listCollections();
      const snapshot: Snapshot = {
        generated_at: new Date().toISOString(),
        version: 1,
        collections: cols.map((c): CollectionSnapshot => {
          const out: CollectionSnapshot = {
            name: c.name,
            type: (c.type ?? "base") as "base" | "auth" | "view" | "singleton",
            fields: parseFields(c.fields),
          };
          if (c.view_query !== null && c.view_query !== undefined) out.view_query = c.view_query;
          // All five, public (null) included: a rule left out means "keep as
          // is" when applied to an existing collection, and admin-only when
          // it creates one, so leaving null out would change it either way.
          out.list_rule   = c.list_rule ?? null;
          out.view_rule   = c.view_rule ?? null;
          out.create_rule = c.create_rule ?? null;
          out.update_rule = c.update_rule ?? null;
          out.delete_rule = c.delete_rule ?? null;
          return out;
        }),
      };
      set.headers["Content-Type"] = "application/json; charset=utf-8";
      set.headers["Content-Disposition"] = `attachment; filename="vaultbase-snapshot-${snapshot.generated_at.slice(0, 10)}.json"`;
      return snapshot;
    }, { requireAdmin: true })

    .post(
      "/admin/migrations/diff",
      async ({ body, set }) => {
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
        requireAdmin: true,
        body: t.Object({
          snapshot: t.Any(),
        }),
      }
    )

    .post(
      "/admin/migrations/apply",
      async ({ body, set }) => {
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
        requireAdmin: true,
        body: t.Object({
          snapshot: t.Any(),
          mode: t.Optional(t.String()),
        }),
      }
    );
}
