/**
 * Group fields: a field whose value is structured items declared in the
 * schema (`options.fields`). A list of items by default (line items, an
 * address book), or one object with `multiple: false` (an address).
 *
 * Stored as JSON in one column, like `json`. Each item of a list carries a
 * server-assigned `id`, kept when the client sends it back. Reads return the
 * declared subfields only, so a removed subfield disappears at once; its
 * stored key goes with the record's next write. Validation of the values
 * lives in validate.ts, next to the other types.
 */
import type { FieldDef } from "./collections.ts";

/** Subfield types a group may hold. */
export const GROUP_SUBFIELD_TYPES: ReadonlySet<string> = new Set([
  "text", "number", "bool", "select", "email", "url", "date", "color", "editor", "json",
]);

/** Items in one list when `max` is not set. */
export const DEFAULT_GROUP_MAX_ITEMS = 100;
/** The most `max` may be. */
export const GROUP_MAX_ITEMS = 1000;
/** The most subfields one group may declare. */
export const GROUP_MAX_SUBFIELDS = 50;

const SUBFIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** An item id: what the server generates, or a client's own of the same shape. */
export const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Subfield options that only make sense on a top-level field. */
const TOP_LEVEL_ONLY_OPTIONS = ["unique", "searchable", "encrypted"] as const;

export function isGroupList(field: FieldDef): boolean {
  return field.options?.multiple !== false;
}

export function subfieldsOf(field: FieldDef): FieldDef[] {
  const sub = field.options?.fields;
  return Array.isArray(sub) ? sub : [];
}

/** Item count bounds for a list group. `required` means at least one item. */
export function groupItemBounds(field: FieldDef): { min: number; max: number } {
  const min = Math.max(field.options?.min ?? 0, field.required ? 1 : 0);
  return { min, max: field.options?.max ?? DEFAULT_GROUP_MAX_ITEMS };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * What's wrong with a group field's definition, or null. `previous` is the
 * field as stored before this change (same name, after renames), if any.
 */
export function groupSchemaError(field: FieldDef, previous: FieldDef | undefined): string | null {
  const name = field.name;
  const opts = field.options ?? {};
  if (opts.unique) return `'${name}': a group can't be unique`;
  if (opts.multiple !== undefined && typeof opts.multiple !== "boolean") return `'${name}': multiple must be true or false`;
  const list = isGroupList(field);
  if (list) {
    if (opts.min !== undefined && (!isInt(opts.min) || opts.min < 0)) return `'${name}': min must be a whole number, 0 or more`;
    if (opts.max !== undefined && (!isInt(opts.max) || opts.max < 1 || opts.max > GROUP_MAX_ITEMS)) {
      return `'${name}': max must be a whole number from 1 to ${GROUP_MAX_ITEMS}`;
    }
    const { min, max } = groupItemBounds(field);
    if (min > max) return `'${name}': min (${min}) is more than max (${max})`;
  } else if (opts.min !== undefined || opts.max !== undefined) {
    return `'${name}': min and max count items, so they only apply when multiple is on`;
  }
  if (previous && isGroupList(previous) !== list) {
    return `'${name}': multiple can't be switched on an existing group. Drop the field and re-add it.`;
  }

  const raw = opts.fields;
  if (!Array.isArray(raw) || raw.length === 0) return `'${name}': a group needs at least one subfield`;
  if (raw.length > GROUP_MAX_SUBFIELDS) return `'${name}': at most ${GROUP_MAX_SUBFIELDS} subfields`;
  const prevByName = new Map(previous ? subfieldsOf(previous).map((s) => [s.name, s]) : []);
  const seen = new Set<string>();
  const renamedSources = new Set<string>();
  const newNames = new Set((raw as Array<{ name?: unknown }>).map((s) => s?.name));
  for (const sub of raw as unknown[]) {
    if (!sub || typeof sub !== "object" || Array.isArray(sub)) return `'${name}': each subfield must be an object`;
    const s = sub as FieldDef;
    if (typeof s.name !== "string" || !SUBFIELD_NAME_RE.test(s.name)) {
      return `'${name}': invalid subfield name '${String(s.name)}' (letters, digits and _, not starting with a digit)`;
    }
    const path = `${name}.${s.name}`;
    if (s.name === "id") return `'${path}': 'id' is reserved: every item already has one`;
    if (s.name === "__proto__") return `'${path}': '__proto__' can't be a subfield name`;
    const key = s.name.toLowerCase();
    if (seen.has(key)) return `'${name}': there are two subfields named '${s.name}'`;
    seen.add(key);
    if (s.type === "group") return `'${path}': groups can't contain groups`;
    if (!GROUP_SUBFIELD_TYPES.has(s.type)) {
      return `'${path}': a group can't hold ${String(s.type)} fields (allowed: ${[...GROUP_SUBFIELD_TYPES].join(", ")})`;
    }
    for (const o of TOP_LEVEL_ONLY_OPTIONS) {
      if (s.options?.[o]) return `'${path}': ${o} isn't available on a subfield`;
    }
    if (s.type === "select" && (!Array.isArray(s.options?.values) || s.options.values.length === 0)) {
      return `'${path}': a select needs at least one value`;
    }
    if (typeof s.renamedFrom === "string" && s.renamedFrom !== s.name && prevByName.has(s.renamedFrom) && prevByName.has(s.name)) {
      return `'${path}': can't rename '${s.renamedFrom}' to '${s.name}': '${s.name}' already exists`;
    }
    if (typeof s.renamedFrom === "string" && s.renamedFrom !== s.name && prevByName.has(s.renamedFrom) && !newNames.has(s.renamedFrom)) {
      if (renamedSources.has(s.renamedFrom)) return `'${path}': '${s.renamedFrom}' is renamed twice in this change`;
      renamedSources.add(s.renamedFrom);
    }
    const before = prevByName.get(s.renamedFrom && !prevByName.has(s.name) ? s.renamedFrom : s.name);
    if (before && before.type !== s.type) {
      return `'${path}': can't change a subfield's type from '${before.type}' to '${s.type}'. Remove it and add a new one.`;
    }
    if (before && s.type === "select" && !!before.options?.multiple !== !!s.options?.multiple) {
      return `'${path}': multiple can't be switched on an existing select. Remove it and add a new one.`;
    }
  }
  return null;
}

/**
 * Subfield renames in `field` against `previous`: old name → new name.
 * A rename names an old subfield that the new list no longer has.
 */
export function subfieldRenames(field: FieldDef, previous: FieldDef): Map<string, string> {
  const oldNames = new Set(subfieldsOf(previous).map((s) => s.name));
  const newNames = new Set(subfieldsOf(field).map((s) => s.name));
  const out = new Map<string, string>();
  for (const s of subfieldsOf(field)) {
    const from = s.renamedFrom;
    if (!from || from === s.name || !oldNames.has(from) || newNames.has(from) || oldNames.has(s.name)) continue;
    out.set(from, s.name);
  }
  return out;
}

/**
 * A group's stored value under a new schema: subfields renamed, and keys
 * that are no longer declared removed, so a removed subfield's data is gone
 * (as a dropped column's is) and can't come back under a re-added name.
 * Anything that isn't items is left alone.
 */
export function rewriteGroupValue(value: unknown, field: FieldDef, renames: ReadonlyMap<string, string>): unknown {
  const keep = new Set(subfieldsOf(field).map((s) => s.name));
  if (isGroupList(field)) keep.add("id");
  const sourceOf = new Map([...renames].map(([from, to]) => [to, from]));
  const rewriteItem = (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
      // A rename's target takes the source's value when the item has the
      // source. Without it the target is kept: running the same rewrite
      // twice leaves the renamed values in place.
      const from = sourceOf.get(k);
      if (from !== undefined && !renames.has(k) && Object.prototype.hasOwnProperty.call(item, from)) continue;
      const to = renames.get(k) ?? k;
      if (keep.has(to)) out[to] = v;
    }
    return out;
  };
  return Array.isArray(value) ? value.map(rewriteItem) : rewriteItem(value);
}

/** Whether moving from `previous` to `field` needs stored items rewritten: a subfield renamed or removed. */
export function groupNeedsRewrite(field: FieldDef, previous: FieldDef, renames: ReadonlyMap<string, string>): boolean {
  if (renames.size > 0) return true;
  const now = new Set(subfieldsOf(field).map((s) => s.name));
  return subfieldsOf(previous).some((s) => !now.has(s.name));
}

/** The schema without `renamedFrom`, on fields and their subfields: instructions, not schema. */
export function withoutRenames(fields: FieldDef[]): FieldDef[] {
  return fields.map(({ renamedFrom: _r, ...f }) => {
    if (f.type !== "group" || !Array.isArray(f.options?.fields)) return f;
    return { ...f, options: { ...f.options, fields: f.options.fields.map(({ renamedFrom: _s, ...s }) => s) } };
  });
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new item id: 15 characters of [a-z0-9]. */
export function newItemId(): string {
  let out = "";
  while (out.length < 15) {
    // 252 = 7 * 36: bytes above it are skipped so every character is equally likely.
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 252 && out.length < 15) out += ID_ALPHABET[b % 36];
    }
  }
  return out;
}

/**
 * A stored group value as the API returns it: each item reduced to its id
 * and the declared subfields. Values that aren't items (a hand-edited row)
 * come back as stored. Also used to fit an old history snapshot to the
 * current schema before it is restored.
 */
export function shapeGroupValue(value: unknown, field: FieldDef): unknown {
  const names = subfieldsOf(field).map((s) => s.name);
  const list = isGroupList(field);
  const shapeItem = (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const src = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (list && "id" in src) out["id"] = src["id"];
    for (const n of names) if (Object.prototype.hasOwnProperty.call(src, n)) out[n] = src[n];
    return out;
  };
  if (list) return Array.isArray(value) ? value.map(shapeItem) : value;
  return shapeItem(value);
}
