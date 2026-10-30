/**
 * Group fields in the admin: a list of items (or one object) whose keys are
 * the subfields declared in `options.fields`. Pure helpers for the schema
 * editor, the record form and the records table.
 */
import type { FieldDef } from "../api.ts";

/** Subfield types a group may hold (the server's GROUP_SUBFIELD_TYPES). */
export const GROUP_SUBFIELD_TYPES: FieldDef["type"][] = [
  "text", "number", "bool", "select", "email", "url", "date", "color", "editor", "json",
];

/** Items in one list when `max` is not set, and the most `max` may be. */
export const DEFAULT_GROUP_MAX_ITEMS = 100;
export const GROUP_MAX_ITEMS = 1000;
export const GROUP_MAX_SUBFIELDS = 50;

export type GroupItem = Record<string, unknown>;

export function isGroupList(field: FieldDef): boolean {
  return field.options?.["multiple"] !== false;
}

export function subfieldsOf(field: FieldDef): FieldDef[] {
  const sub = field.options?.["fields"];
  return Array.isArray(sub) ? (sub as FieldDef[]) : [];
}

/** Item count bounds for a list group. `required` means at least one item. */
export function groupItemBounds(field: FieldDef): { min: number; max: number } {
  const min = Math.max(typeof field.options?.["min"] === "number" ? field.options["min"] as number : 0, field.required ? 1 : 0);
  const max = typeof field.options?.["max"] === "number" ? field.options["max"] as number : DEFAULT_GROUP_MAX_ITEMS;
  return { min, max };
}

/** The items of a list value; anything that isn't a list has none. */
export function itemsOf(value: unknown): GroupItem[] {
  return Array.isArray(value) ? value.filter((v): v is GroupItem => !!v && typeof v === "object" && !Array.isArray(v)) : [];
}

/** `list` with the entry at `from` moved to `to`. Out-of-range moves return the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Whether an object holds no values (an item's id doesn't count). */
export function isBlankItem(item: GroupItem): boolean {
  return Object.entries(item).every(([k, v]) => k === "id" || isEmpty(v));
}

/** A short text for one item: its first text-like values, for a collapsed card or a table cell. */
export function itemSummary(item: GroupItem, field: FieldDef, maxLen = 60): string {
  const bits: string[] = [];
  for (const sub of subfieldsOf(field)) {
    const v = item[sub.name];
    if (isEmpty(v)) continue;
    if (sub.type === "editor") {
      const text = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (text) bits.push(text);
    } else if (sub.type === "bool") {
      if (v === true) bits.push(sub.name);
    } else if (sub.type === "date" && typeof v === "number") {
      bits.push(new Date(v * 1000).toISOString().slice(0, 10));
    } else if (sub.type === "json") {
      continue;
    } else bits.push(Array.isArray(v) ? v.join(", ") : String(v));
    if (bits.join(" · ").length >= maxLen) break;
  }
  const s = bits.join(" · ");
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

/** A group value in a table cell: the item count for a list, the summary for one object. */
export function groupCellText(value: unknown, field: FieldDef): string {
  if (value === null || value === undefined) return "—";
  if (!isGroupList(field)) {
    if (typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
    return itemSummary(value as GroupItem, field) || "—";
  }
  if (!Array.isArray(value)) return JSON.stringify(value);
  const n = value.length;
  if (n === 0) return "no items";
  const first = itemSummary(itemsOf(value)[0] ?? {}, field, 40);
  return `${n} item${n === 1 ? "" : "s"}${first ? ` · ${first}${n > 1 ? ", …" : ""}` : ""}`;
}

/**
 * A single-object group's value after an edit: null when nothing is filled
 * in, so an untouched form doesn't send an object of empty values.
 */
export function singleGroupValue(item: GroupItem): GroupItem | null {
  return isBlankItem(item) ? null : item;
}

/** Fields loaded from the server, each subfield remembering its stored name so a rename is sent as one. */
export function withStoredSubfieldNames(field: FieldDef): FieldDef {
  if (field.type !== "group") return field;
  return { ...field, options: { ...field.options, fields: subfieldsOf(field).map((s) => ({ ...s, renamedFrom: s.name })) } };
}

/** Subfields as the API takes them: `renamedFrom` only where the name changed. */
export function subfieldsForSave(field: FieldDef): FieldDef {
  if (field.type !== "group") return field;
  return {
    ...field,
    options: {
      ...field.options,
      fields: subfieldsOf(field).map(({ renamedFrom, ...s }) => (renamedFrom && renamedFrom !== s.name ? { ...s, renamedFrom } : s)),
    },
  };
}

/**
 * What's wrong with a group's definition before saving, or null. The server
 * checks again. `field` is as edited (subfields keep `renamedFrom`);
 * `storedNames` are the subfields the saved field has.
 */
export function groupSchemaProblem(field: FieldDef, storedNames: readonly string[] = []): string | null {
  const stored = new Set(storedNames);
  const subs = subfieldsOf(field);
  if (subs.length === 0) return `Group field '${field.name}' needs at least one subfield`;
  if (subs.length > GROUP_MAX_SUBFIELDS) return `Group field '${field.name}' can have at most ${GROUP_MAX_SUBFIELDS} subfields`;
  const seen = new Set<string>();
  for (const s of subs) {
    if (!s.name) return `Every subfield of '${field.name}' needs a name`;
    if (!/^[A-Za-z_]/.test(s.name)) return `Subfield '${field.name}.${s.name}' must start with a letter or _`;
    // A saved subfield's name stays its own until a save removes or renames it:
    // reusing it in the same save would mix the old values into the new subfield.
    if (stored.has(s.name) && s.renamedFrom !== s.name) {
      return `'${field.name}.${s.name}' is still a saved subfield. Save removing or renaming it first, then reuse the name.`;
    }
    if (s.name === "id") return `'${field.name}.id' is reserved: every item already has an id`;
    const key = s.name.toLowerCase();
    if (seen.has(key)) return `'${field.name}' has two subfields named '${s.name}'`;
    seen.add(key);
    if (s.type === "select" && (!Array.isArray(s.options?.["values"]) || (s.options["values"] as string[]).length === 0)) {
      return `Select subfield '${field.name}.${s.name}' must have at least one allowed value`;
    }
  }
  if (isGroupList(field)) {
    const isCount = (v: unknown) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0);
    if (!isCount(field.options?.["min"]) || !isCount(field.options?.["max"])) return `'${field.name}': min and max items must be whole numbers`;
    const { min, max } = groupItemBounds(field);
    if (max < 1 || max > GROUP_MAX_ITEMS) return `'${field.name}': max items must be from 1 to ${GROUP_MAX_ITEMS}`;
    if (min > max) return `'${field.name}': min items (${min}) is more than max (${max})`;
  } else if (field.options?.["min"] !== undefined || field.options?.["max"] !== undefined) {
    return `'${field.name}': min and max count items, so they only apply to a list`;
  }
  return null;
}
