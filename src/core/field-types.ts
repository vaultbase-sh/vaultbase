/**
 * Field type registry.
 *
 * The built-in types are registered here by name so the schema editor and
 * collection writes can tell a known type from a typo. Their behaviour still
 * lives where it always has (validate.ts, records.ts, openapi.ts): those
 * switches handle the built-ins and fall through to the registry for
 * anything else.
 *
 * An extension adds a type with `registerFieldType()`. A field of a type
 * that is no longer registered (its extension was removed) keeps working as
 * plain stored text; only new fields must use a registered type.
 */
import type { FieldDef } from "./collections.ts";

export type SqlColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB";

export interface FieldTypeDef {
  /** Type name used in the schema, e.g. "money". Letters, digits and `_`. */
  type: string;
  /** SQLite column type. Default "TEXT". */
  sqlType?: SqlColumnType;
  /**
   * Store the value as JSON text and parse it back on read (like `json`).
   * Use it for object or array values. Ignored when `encode`/`decode` are set.
   */
  json?: boolean;
  /**
   * Check a non-empty value. Return an error message, or null when it's
   * valid. Required / empty checks happen before this is called.
   */
  validate?(value: unknown, field: FieldDef): string | null;
  /** Turn a valid value into its stored form, e.g. lowercase it. Runs before unique checks. */
  normalize?(value: unknown, field: FieldDef): unknown;
  /** JS value → column value. */
  encode?(value: unknown, field: FieldDef): unknown;
  /** Column value → the JS value the API returns. */
  decode?(value: unknown, field: FieldDef): unknown;
  /** JSON Schema for the value, used by the generated OpenAPI document. */
  openapi?(field: FieldDef): Record<string, unknown>;
}

export interface RegisteredFieldType extends FieldTypeDef {
  builtin: boolean;
}

const BUILTIN: Array<[string, SqlColumnType]> = [
  ["text", "TEXT"], ["number", "REAL"], ["bool", "INTEGER"], ["file", "TEXT"],
  ["relation", "TEXT"], ["select", "TEXT"], ["autodate", "INTEGER"], ["email", "TEXT"],
  ["url", "TEXT"], ["date", "INTEGER"], ["json", "TEXT"], ["password", "TEXT"],
  ["editor", "TEXT"], ["geoPoint", "TEXT"], ["vector", "TEXT"], ["color", "TEXT"],
];

const registry = new Map<string, RegisteredFieldType>(
  BUILTIN.map(([type, sqlType]) => [type, { type, sqlType, builtin: true }]),
);

const TYPE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Bumped whenever a type is added or removed, so decoders built from the registry can be dropped. */
let registryVersion = 0;
export function fieldTypesVersion(): number {
  return registryVersion;
}

/**
 * Add a field type. Throws if the name is malformed or already taken; a
 * built-in type can't be replaced.
 */
export function registerFieldType(def: FieldTypeDef): () => void {
  if (!TYPE_NAME_RE.test(def.type)) {
    throw new Error(`invalid field type name '${def.type}' (letters, digits and _, starting with a letter)`);
  }
  if (registry.has(def.type)) throw new Error(`field type '${def.type}' is already registered`);
  const entry: RegisteredFieldType = { ...def, builtin: false };
  registry.set(def.type, entry);
  registryVersion++;
  return () => {
    if (registry.get(def.type) === entry) { registry.delete(def.type); registryVersion++; }
  };
}

export function getFieldType(type: string): RegisteredFieldType | undefined {
  return registry.get(type);
}

/** An extension's type (not a built-in), if one is registered under this name. */
export function customFieldType(type: string): RegisteredFieldType | undefined {
  const t = registry.get(type);
  return t && !t.builtin ? t : undefined;
}

export function listFieldTypes(): Array<{ type: string; builtin: boolean; sqlType: SqlColumnType }> {
  return [...registry.values()].map((t) => ({ type: t.type, builtin: t.builtin, sqlType: t.sqlType ?? "TEXT" }));
}

export function isKnownFieldType(type: unknown): boolean {
  return typeof type === "string" && registry.has(type);
}
