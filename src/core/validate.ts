import { db } from "../db/index.ts";
import { customFieldType } from "./field-types.ts";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { files, type Collection } from "../db/schema.ts";
import type { FieldDef } from "./collections.ts";
import { getCollection, parseFields, userTableName } from "./collections.ts";
import { sanitizeHtml } from "./html-sanitize.ts";
import { isValidStorageFilename } from "./sec.ts";
import { groupItemBounds, isGroupList, ITEM_ID_RE, newItemId, subfieldsOf } from "./group-fields.ts";

export class ValidationError extends Error {
  details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("Validation failed");
    this.details = details;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A `color` field value in its stored form: lowercase `#rrggbb`, or
 * `#rrggbbaa` when `alpha` is allowed. Short forms (`#rgb`, `#rgba`) are
 * expanded. Returns null for anything that isn't an accepted hex color.
 */
export function normalizeColor(value: unknown, alpha: boolean): string | null {
  if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) return null;
  let hex = value.slice(1).toLowerCase();
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  if (hex.length === 8 && !alpha) return null;
  return `#${hex}`;
}

/**
 * Validate a record against its collection schema.
 * Throws ValidationError with per-field messages on failure.
 *
 * @param mode "create" requires all required fields; "update" only validates provided fields
 * @param existingId existing record id (skip unique check against self when updating)
 * @param canSee set when validating for a non-admin caller (see CanSeeRecord)
 * @param existing the stored record, on update
 */
/**
 * Whether the caller may see record `id` of `target` — set when validating
 * on behalf of a non-admin caller, so a relation can only point at records
 * that caller could read.
 */
export type CanSeeRecord = (target: Collection, id: string) => Promise<boolean>;

export async function validateRecord(
  collection: Collection,
  data: Record<string, unknown> | null | undefined,
  mode: "create" | "update",
  existingId?: string,
  canSee?: CanSeeRecord,
  existing?: Record<string, unknown> | null,
): Promise<void> {
  data = data ?? {};
  const schema = parseFields(collection.fields);
  const errors: Record<string, string> = {};

  for (const field of schema) {
    if (field.system || field.implicit || field.type === "autodate") continue;

    const has = Object.prototype.hasOwnProperty.call(data, field.name);
    const value = data[field.name];

    // Required check
    if (mode === "create" && field.required) {
      if (!has || value === null || value === undefined || value === "") {
        errors[field.name] = `${field.name} is required`;
        continue;
      }
    }

    // If not provided in update, skip
    if (!has) continue;
    // Empty/null in non-required is OK
    if (value === null || value === undefined || value === "") {
      if (field.required && mode === "update") {
        errors[field.name] = `${field.name} cannot be empty`;
      }
      continue;
    }

    if (field.type === "group") {
      const r = validateGroup(field, value);
      if ("error" in r) errors[field.name] = r.error;
      else data[field.name] = r.value;
      continue;
    }

    const err = validateValue(field, value);
    if (err) { errors[field.name] = err; continue; }

    // Server-side HTML sanitization for `editor` fields. Defends against the
    // Quill 2.0.3 XSS class (CVE-2025-15056) by stripping <script>, <iframe>,
    // on* handlers, and javascript:/data: URLs before the value reaches storage.
    if (field.type === "editor" && typeof value === "string" && value !== "") {
      data[field.name] = sanitizeHtml(value);
    }

    // One stored form per color, so equality filters and unique checks work.
    if (field.type === "color") {
      data[field.name] = normalizeColor(value, field.options?.alpha === true);
    }

    const custom = customFieldType(field.type);
    if (custom?.normalize) data[field.name] = custom.normalize(value, field);

    // Unique check (DB query)
    if (field.options?.unique) {
      // The stored form (normalised color, sanitised HTML), not the raw input.
      const isUnique = await checkUnique(collection, field.name, data[field.name], existingId);
      if (!isUnique) errors[field.name] = `${field.name} must be unique`;
    }

    // Relation target existence check (DB query)
    if (field.type === "relation" && typeof value === "string" && value !== "") {
      const targetErr = await checkRelationTarget(field, value, canSee);
      if (targetErr) errors[field.name] = targetErr;
    }

    // A non-admin attaches only files uploaded to this record's field.
    if (field.type === "file" && canSee) {
      const fileErr = await checkFileOwnership(collection, field, value, existingId, existing?.[field.name]);
      if (fileErr) errors[field.name] = fileErr;
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
}

const TEXT_LIKE = new Set(["text", "editor", "email", "url"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a group value and return its stored form: each item's subfields
 * validated as top-level fields are (errors name the item, `items[2].qty`),
 * unknown keys refused, values normalised, and every list item given an id.
 */
export function validateGroup(field: FieldDef, value: unknown): { error: string } | { value: unknown } {
  const subs = subfieldsOf(field);
  if (subs.length === 0) return { error: `${field.name}: group has no subfields configured` };
  const byName = new Map(subs.map((s) => [s.name, s]));

  const checkItem = (item: unknown, at: string, list: boolean): { error: string } | { value: Record<string, unknown> } => {
    if (!isPlainObject(item)) return { error: `${at} must be an object` };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(item)) {
      if (key === "id" && list) continue;
      if (!byName.has(key)) return { error: `${at}.${key} is not a field of ${field.name}` };
    }
    for (const sub of subs) {
      const path = `${at}.${sub.name}`;
      const v = Object.prototype.hasOwnProperty.call(item, sub.name) ? item[sub.name] : undefined;
      if (v === undefined || v === null || v === "") {
        if (sub.required) return { error: `${path} is required` };
        // An empty string is a value for text; for a number or a date it is no value.
        if (v === "" && TEXT_LIKE.has(sub.type)) out[sub.name] = v;
        continue;
      }
      const err = validateValue({ ...sub, name: path }, v);
      if (err) return { error: err };
      out[sub.name] = normalizeSubfield(sub, v);
    }
    return { value: out };
  };

  if (!isGroupList(field)) {
    const r = checkItem(value, field.name, false);
    return r;
  }

  if (!Array.isArray(value)) return { error: `${field.name} must be a list of items` };
  const { min, max } = groupItemBounds(field);
  if (value.length < min) return { error: `${field.name} needs at least ${min} item${min === 1 ? "" : "s"}` };
  if (value.length > max) return { error: `${field.name} can have at most ${max} items` };
  const ids = new Set<string>();
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < value.length; i++) {
    const at = `${field.name}[${i}]`;
    const r = checkItem(value[i], at, true);
    if ("error" in r) return r;
    const given = (value[i] as Record<string, unknown>)["id"];
    let id: string;
    if (given === undefined || given === null || given === "") id = newItemId();
    else if (typeof given !== "string" || !ITEM_ID_RE.test(given)) {
      return { error: `${at}.id must be 1 to 64 letters, digits, _ or -` };
    } else id = given;
    if (ids.has(id)) return { error: `${at}.id '${id}' is used by another item` };
    ids.add(id);
    items.push({ id, ...r.value });
  }
  return { value: items };
}

/** A valid subfield value in its stored form, as the top-level field would store it. */
function normalizeSubfield(sub: FieldDef, v: unknown): unknown {
  switch (sub.type) {
    case "editor": return typeof v === "string" ? sanitizeHtml(v) : v;
    case "color": return normalizeColor(v, sub.options?.alpha === true);
    case "date": return typeof v === "number" ? v : Math.floor(Date.parse(v as string) / 1000);
    // A top-level select is a text column; store the same strings here, so filters agree.
    case "select": return Array.isArray(v) ? v.map(String) : String(v);
    default: return v;
  }
}

/** The stored file names in a file field's value: one name, an array, or a multi field's JSON string. */
function fileNames(value: unknown): string[] {
  let v = value;
  if (typeof v === "string" && v.startsWith("[")) {
    try { v = JSON.parse(v); } catch { /* a single name */ }
  }
  const list = Array.isArray(v) ? v : [v];
  return list.filter((n): n is string => typeof n === "string" && n !== "");
}

/**
 * Every file name a non-admin newly puts in a file field must be a file
 * uploaded to this record's field. Otherwise anyone who learned a file name
 * could show someone else's upload on their own record, and it would vanish
 * from theirs when the owner replaced it (the sweep deletes a file its own
 * record no longer names). Names the field already holds stay valid, so
 * sending the whole record back unchanged works. A new record has no uploads
 * yet: files are uploaded to it once it exists.
 */
async function checkFileOwnership(
  collection: Collection,
  field: FieldDef,
  value: unknown,
  recordId: string | undefined,
  stored: unknown,
): Promise<string | null> {
  const kept = new Set(fileNames(stored));
  const added = [...new Set(fileNames(value))].filter((n) => !kept.has(n));
  if (added.length === 0) return null;
  if (!recordId) return `${field.name}: upload files to the record after creating it`;
  const rows = await getDb().select({ filename: files.filename }).from(files).where(and(
    eq(files.collection_id, collection.id),
    eq(files.record_id, recordId),
    eq(files.field_name, field.name),
    inArray(files.filename, added),
  ));
  const owned = new Set(rows.map((r) => r.filename));
  return added.every((n) => owned.has(n)) ? null : `${field.name} must name a file uploaded to this record's ${field.name}`;
}

function validateValue(field: FieldDef, value: unknown): string | null {
  switch (field.type) {
    case "text":
      if (typeof value !== "string") return `${field.name} must be a string`;
      if (field.options?.min !== undefined && value.length < field.options.min) {
        return `${field.name} must be at least ${field.options.min} characters`;
      }
      if (field.options?.max !== undefined && value.length > field.options.max) {
        return `${field.name} must be at most ${field.options.max} characters`;
      }
      if (field.options?.pattern) {
        try {
          const re = new RegExp(field.options.pattern);
          if (!re.test(value)) return `${field.name} doesn't match required pattern`;
        } catch {
          return `${field.name} has invalid pattern in schema`;
        }
      }
      return null;

    case "number":
      if (typeof value !== "number" || !isFinite(value)) return `${field.name} must be a number`;
      if (field.options?.min !== undefined && value < field.options.min) {
        return `${field.name} must be at least ${field.options.min}`;
      }
      if (field.options?.max !== undefined && value > field.options.max) {
        return `${field.name} must be at most ${field.options.max}`;
      }
      return null;

    case "bool":
      if (typeof value !== "boolean") return `${field.name} must be a boolean`;
      return null;

    case "email":
      if (typeof value !== "string" || !EMAIL_RE.test(value)) return `${field.name} must be a valid email`;
      return null;

    case "url":
      if (typeof value !== "string" || !URL_RE.test(value)) return `${field.name} must be a valid URL`;
      return null;

    case "color":
      if (normalizeColor(value, field.options?.alpha === true) === null) {
        return field.options?.alpha
          ? `${field.name} must be a hex color (#rgb, #rgba, #rrggbb or #rrggbbaa)`
          : `${field.name} must be a hex color (#rgb or #rrggbb)`;
      }
      return null;

    case "select": {
      const allowed = field.options?.values ?? [];
      if (allowed.length === 0) {
        return `${field.name}: select field has no allowed values configured`;
      }
      if (field.options?.multiple) {
        if (!Array.isArray(value)) return `${field.name} must be an array`;
        const bad = value.find((v) => !allowed.includes(String(v)));
        if (bad !== undefined) return `${field.name} value '${bad}' not in allowed options`;
      } else {
        if (!allowed.includes(String(value))) return `${field.name} must be one of: ${allowed.join(", ")}`;
      }
      return null;
    }

    case "relation":
      if (typeof value !== "string") return `${field.name} must be a record id (string)`;
      // Existence is verified by checkRelationTarget after this call.
      return null;

    case "date":
      if (typeof value === "number") return null;
      if (typeof value === "string" && !isNaN(Date.parse(value))) return null;
      return `${field.name} must be a date (ISO string or unix timestamp)`;

    case "json":
      // Any JSON-serializable value is fine
      return null;

    case "file": {
      // Upload validation happens in the files API; here the value is just
      // the stored name(s). Each must be one storage filename: clients
      // (the admin UI among them) build `/api/v1/files/.../<name>` URLs
      // from it, and `../../admin/...?` sent an admin's request elsewhere.
      // A multi-file field stores a JSON string as-is, so parse that too.
      let names: unknown = value;
      if (typeof value === "string" && field.options?.["multiple"] === true) {
        try { names = JSON.parse(value); } catch { names = value; }
      }
      const list = Array.isArray(names) ? names : [names];
      for (const n of list) {
        if (typeof n !== "string" || !isValidStorageFilename(n)) {
          return `${field.name} must be the name of an uploaded file`;
        }
      }
      return null;
    }

    case "password":
      if (typeof value !== "string") return `${field.name} must be a string`;
      // Empty allowed only when not required (handled elsewhere)
      if (value === "") return null;
      if (field.options?.min !== undefined && value.length < field.options.min) {
        return `${field.name} must be at least ${field.options.min} characters`;
      }
      if (field.options?.max !== undefined && value.length > field.options.max) {
        return `${field.name} must be at most ${field.options.max} characters`;
      }
      return null;

    case "editor":
      if (typeof value !== "string") return `${field.name} must be a string (HTML)`;
      if (field.options?.max !== undefined && value.length > field.options.max) {
        return `${field.name} must be at most ${field.options.max} characters`;
      }
      return null;

    case "geoPoint": {
      if (typeof value !== "object" || value === null) return `${field.name} must be { lat, lng }`;
      const v = value as Record<string, unknown>;
      const lat = v["lat"], lng = v["lng"];
      if (typeof lat !== "number" || !isFinite(lat) || lat < -90 || lat > 90) {
        return `${field.name}.lat must be a number in [-90, 90]`;
      }
      if (typeof lng !== "number" || !isFinite(lng) || lng < -180 || lng > 180) {
        return `${field.name}.lng must be a number in [-180, 180]`;
      }
      return null;
    }

    case "vector": {
      const dims = field.options?.dimensions;
      if (typeof dims !== "number" || !Number.isInteger(dims) || dims < 1 || dims > 4096) {
        return `${field.name} schema is invalid: dimensions must be an integer in [1, 4096]`;
      }
      if (!Array.isArray(value)) return `${field.name} must be a number[] of length ${dims}`;
      if (value.length !== dims) return `${field.name} must have exactly ${dims} elements (got ${value.length})`;
      for (let i = 0; i < value.length; i++) {
        const n = value[i];
        if (typeof n !== "number" || !Number.isFinite(n)) {
          return `${field.name}[${i}] must be a finite number`;
        }
      }
      return null;
    }

    default:
      return customFieldType(field.type)?.validate?.(value, field) ?? null;
  }
}

async function checkUnique(
  collection: Collection,
  fieldName: string,
  value: unknown,
  existingId?: string
): Promise<boolean> {
  const tableRef = `"${userTableName(collection.name)}"`;
  const where = existingId
    ? `WHERE "${fieldName}" = ? AND "id" != ?`
    : `WHERE "${fieldName}" = ?`;
  const params: unknown[] = existingId ? [value, existingId] : [value];
  const row = await db.get(`SELECT "id" FROM ${tableRef} ${where} LIMIT 1`, params);
  return row === null;
}

async function checkRelationTarget(field: FieldDef, id: string, canSee?: CanSeeRecord): Promise<string | null> {
  if (!field.collection) return `${field.name}: relation has no target collection configured`;
  const target = await getCollection(field.collection);
  if (!target) return `${field.name}: target collection '${field.collection}' not found`;
  const tableRef = `"${userTableName(target.name)}"`;
  const row = await db.get(`SELECT "id" FROM ${tableRef} WHERE "id" = ? LIMIT 1`, [id]);
  // A record the caller can't view gets the same answer as one that doesn't
  // exist: otherwise the error tells them which ids exist in a collection
  // they can't read, and lets them link to someone else's private record.
  if (!row || (canSee && !(await canSee(target, id)))) return `${field.name}: related record not found`;
  return null;
}
