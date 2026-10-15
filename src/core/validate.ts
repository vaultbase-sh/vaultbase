import { db } from "../db/index.ts";
import { customFieldType } from "./field-types.ts";
import { type Collection } from "../db/schema.ts";
import type { FieldDef } from "./collections.ts";
import { getCollection, parseFields, userTableName } from "./collections.ts";
import { sanitizeHtml } from "./html-sanitize.ts";
import { isValidStorageFilename } from "./sec.ts";

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
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
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
