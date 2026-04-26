import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { records, type Collection } from "../db/schema.ts";
import type { FieldDef } from "./collections.ts";
import { parseFields } from "./collections.ts";

export class ValidationError extends Error {
  details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("Validation failed");
    this.details = details;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

/**
 * Validate a record against its collection schema.
 * Throws ValidationError with per-field messages on failure.
 *
 * @param mode "create" requires all required fields; "update" only validates provided fields
 * @param existingId existing record id (skip unique check against self when updating)
 */
export async function validateRecord(
  collection: Collection,
  data: Record<string, unknown> | null | undefined,
  mode: "create" | "update",
  existingId?: string
): Promise<void> {
  data = data ?? {};
  const schema = parseFields(collection.fields);
  const errors: Record<string, string> = {};

  for (const field of schema) {
    if (field.system || field.type === "autodate") continue;

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

    // Unique check (DB query)
    if (field.options?.unique) {
      const isUnique = await checkUnique(collection.id, field.name, value, existingId);
      if (!isUnique) errors[field.name] = `${field.name} must be unique`;
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
      // Note: target existence not checked here — would require another query.
      // Rely on FK constraint or app-level checks.
      return null;

    case "date":
      if (typeof value === "number") return null;
      if (typeof value === "string" && !isNaN(Date.parse(value))) return null;
      return `${field.name} must be a date (ISO string or unix timestamp)`;

    case "json":
      // Any JSON-serializable value is fine
      return null;

    case "file":
      // File upload validation happens in files API, not here
      return null;

    default:
      return null;
  }
}

async function checkUnique(
  collectionId: string,
  fieldName: string,
  value: unknown,
  existingId?: string
): Promise<boolean> {
  const db = getDb();
  const expr = sql`JSON_EXTRACT(${records.data}, ${`$.${fieldName}`}) = ${value as string | number}`;
  const conditions = existingId
    ? and(eq(records.collection_id, collectionId), expr, ne(records.id, existingId))
    : and(eq(records.collection_id, collectionId), expr);
  const rows = await db.select({ id: records.id }).from(records).where(conditions).limit(1);
  return rows.length === 0;
}
