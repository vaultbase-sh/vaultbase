import {
  CollectionValidationError,
  createCollection,
  getCollection,
  listCollections,
  parseFields,
  updateCollection,
  type FieldDef,
} from "./collections.ts";

/**
 * Stable JSON shape for a collection definition. Persisted across environments
 * and applied by `/migrations/apply` (HTTP) or `applySnapshot()` (programmatic
 * / CLI). We deliberately drop `id`, `created_at`, `updated_at` — `name` is
 * the cross-environment identifier.
 */
export interface CollectionSnapshot {
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

export interface Snapshot {
  /** Iso timestamp of the snapshot. */
  generated_at: string;
  /** Schema version of the snapshot format itself — bump if we change the shape. */
  version: 1;
  collections: CollectionSnapshot[];
}

export type ApplyMode = "additive" | "sync";

export interface ApplyResult {
  created: string[];
  updated: string[];
  /** Collections that were already in sync — no-op. */
  unchanged: string[];
  /** Collections that exist locally but were skipped because additive mode does not modify them. */
  skipped: string[];
  errors: Array<{ collection: string; error: string }>;
}

export interface ApplyOptions {
  mode: ApplyMode;
}

/** Thrown when the snapshot input is structurally invalid. */
export class SnapshotShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotShapeError";
  }
}

function fieldsEqual(a: FieldDef[], b: FieldDef[]): boolean {
  if (a.length !== b.length) return false;
  // Compare normalized JSON to ignore field-order shuffles inside `options`.
  return JSON.stringify(a) === JSON.stringify(b);
}

type ExistingCollection = NonNullable<Awaited<ReturnType<typeof getCollection>>>;

export function isCollectionInSync(
  existing: Awaited<ReturnType<typeof getCollection>>,
  snap: CollectionSnapshot
): boolean {
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

/**
 * Produce a human-readable list of differences between an existing collection
 * and a snapshot entry. Returns an empty array when they are in sync.
 */
export function describeCollectionChanges(existing: ExistingCollection, snap: CollectionSnapshot): string[] {
  const changes: string[] = [];

  if (existing.type !== snap.type) {
    changes.push(`type changed (${existing.type} → ${snap.type})`);
  }

  // Field-level diff: compare by name to count adds / removes / modifications.
  const existingFields = parseFields(existing.fields);
  if (!fieldsEqual(existingFields, snap.fields)) {
    const existingByName = new Map(existingFields.map((f) => [f.name, f]));
    const snapByName     = new Map(snap.fields.map((f) => [f.name, f]));
    let added = 0, removed = 0, modified = 0;
    for (const [name, sf] of snapByName) {
      const ef = existingByName.get(name);
      if (!ef) added++;
      else if (JSON.stringify(ef) !== JSON.stringify(sf)) modified++;
    }
    for (const name of existingByName.keys()) {
      if (!snapByName.has(name)) removed++;
    }
    const parts: string[] = [];
    if (added)    parts.push(`${added} added`);
    if (removed)  parts.push(`${removed} removed`);
    if (modified) parts.push(`${modified} modified`);
    changes.push(`fields: ${parts.length ? parts.join(", ") : "reordered"}`);
  }

  if ((existing.view_query ?? null) !== (snap.view_query ?? null)) changes.push("view_query changed");
  if ((existing.list_rule ?? null)   !== (snap.list_rule ?? null))   changes.push("list_rule changed");
  if ((existing.view_rule ?? null)   !== (snap.view_rule ?? null))   changes.push("view_rule changed");
  if ((existing.create_rule ?? null) !== (snap.create_rule ?? null)) changes.push("create_rule changed");
  if ((existing.update_rule ?? null) !== (snap.update_rule ?? null)) changes.push("update_rule changed");
  if ((existing.delete_rule ?? null) !== (snap.delete_rule ?? null)) changes.push("delete_rule changed");

  return changes;
}

export interface DiffResult {
  added:     Array<{ name: string; type: string }>;
  modified:  Array<{ name: string; type: string; changes: string[] }>;
  unchanged: Array<{ name: string }>;
  removed:   Array<{ name: string }>;
}

/**
 * Compute a preview of what `apply` would do for a given snapshot, without
 * touching the DB. Shared by the HTTP endpoint and the test suite.
 */
export async function computeSnapshotDiff(snap: Snapshot): Promise<DiffResult> {
  const result: DiffResult = { added: [], modified: [], unchanged: [], removed: [] };
  const localCols = await listCollections();
  const localByName = new Map(localCols.map((c) => [c.name, c]));
  const seen = new Set<string>();

  for (const c of snap.collections) {
    if (!c.name || typeof c.name !== "string") continue;
    seen.add(c.name);
    const existing = localByName.get(c.name);
    if (!existing) {
      result.added.push({ name: c.name, type: c.type });
      continue;
    }
    if (isCollectionInSync(existing, c)) {
      result.unchanged.push({ name: c.name });
      continue;
    }
    result.modified.push({
      name: c.name,
      type: c.type,
      changes: describeCollectionChanges(existing, c),
    });
  }

  for (const local of localCols) {
    if (!seen.has(local.name)) {
      result.removed.push({ name: local.name });
    }
  }

  return result;
}

/**
 * Validate the high-level shape of a snapshot. Throws SnapshotShapeError on
 * structural problems. Does not validate field-level correctness — that is
 * caught downstream by createCollection / updateCollection.
 */
export function validateSnapshotShape(snap: unknown): asserts snap is Snapshot {
  if (!snap || typeof snap !== "object") {
    throw new SnapshotShapeError("snapshot must be an object");
  }
  const s = snap as Partial<Snapshot>;
  if (s.version !== 1) {
    throw new SnapshotShapeError(`Unsupported snapshot version: ${String(s.version)}`);
  }
  if (!Array.isArray(s.collections)) {
    throw new SnapshotShapeError("snapshot.collections must be an array");
  }
  for (const c of s.collections) {
    if (!c || typeof c !== "object") {
      throw new SnapshotShapeError("snapshot.collections entries must be objects");
    }
    if (typeof c.name !== "string" || !c.name) {
      throw new SnapshotShapeError("snapshot.collections[].name must be a non-empty string");
    }
    if (c.type !== "base" && c.type !== "auth" && c.type !== "view") {
      throw new SnapshotShapeError(
        `snapshot.collections["${c.name}"].type must be 'base' | 'auth' | 'view'`
      );
    }
    if (!Array.isArray(c.fields)) {
      throw new SnapshotShapeError(
        `snapshot.collections["${c.name}"].fields must be an array`
      );
    }
  }
}

/**
 * Apply a snapshot to the local database.
 *
 * - `additive` (default): creates missing collections; existing ones are left
 *   untouched (counted as `skipped` if they drift, `unchanged` if they match).
 * - `sync`: also updates existing collections that drift from the snapshot.
 *
 * Idempotent — re-applying the same snapshot is a no-op (everything reports
 * `unchanged`).
 *
 * Throws SnapshotShapeError if the snapshot is structurally invalid.
 */
export async function applySnapshot(
  snapshot: unknown,
  opts: ApplyOptions = { mode: "additive" }
): Promise<ApplyResult> {
  validateSnapshotShape(snapshot);
  const { mode } = opts;
  if (mode !== "additive" && mode !== "sync") {
    throw new SnapshotShapeError("mode must be 'additive' or 'sync'");
  }

  const result: ApplyResult = { created: [], updated: [], unchanged: [], skipped: [], errors: [] };

  for (const c of snapshot.collections) {
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
    const inSync = isCollectionInSync(existing, c);

    if (mode === "additive") {
      if (inSync) result.unchanged.push(c.name);
      else result.skipped.push(c.name);
      continue;
    }

    // sync mode
    if (inSync) {
      result.unchanged.push(c.name);
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

  return result;
}
