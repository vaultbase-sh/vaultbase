/**
 * API preview presets, read from the instance's own OpenAPI spec
 * (/api/v1/openapi.json), which the server builds from the live collections:
 * auth collections get their sign-in routes, singletons GET and PATCH, views
 * only reads. Keeping the preview on the spec keeps it from drifting.
 */
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface Preset {
  method: Method;
  /** Path as sent; `{id}` and other parameters are left for the user to fill. */
  path: string;
  summary: string;
  group: string;
  body?: string;
  /** Collection the path is about, for filling `{id}` with a real record. */
  collection?: string;
}

interface Schema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  readOnly?: boolean;
}

interface Operation {
  summary?: string;
  parameters?: Array<{ name?: string; in?: string }>;
  tags?: string[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
}

export interface OpenApiSpec {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

const METHODS: Method[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];

/** Endpoints outside the spec that are handy to have one click away. */
export const SYSTEM_PRESETS: Preset[] = [
  { method: "GET", path: "/api/health", summary: "Health and version", group: "System" },
  { method: "GET", path: "/api/v1/collections", summary: "List collections", group: "System" },
  { method: "GET", path: "/api/v1/admin/auth/me", summary: "The signed-in admin", group: "System" },
  { method: "GET", path: "/api/v1/admin/logs?perPage=10", summary: "Recent request logs", group: "System" },
];

function resolve(spec: OpenApiSpec, s: Schema | undefined): Schema | undefined {
  if (!s?.$ref) return s;
  const name = s.$ref.split("/").pop() ?? "";
  return spec.components?.schemas?.[name];
}

/** A small, valid-looking example value for a schema. */
export function sampleFor(spec: OpenApiSpec, schema: Schema | undefined, depth = 0): unknown {
  const s = resolve(spec, schema);
  if (!s || depth > 3) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        if (resolve(spec, v)?.readOnly) continue;
        out[k] = sampleFor(spec, v, depth + 1);
      }
      return out;
    }
    case "array": return [];
    case "integer":
    case "number": return 0;
    case "boolean": return false;
    case "string":
      if (s.format === "email") return "user@example.com";
      if (s.format === "date-time") return new Date(0).toISOString();
      return "";
    default: return s.properties ? sampleFor(spec, { ...s, type: "object" }, depth) : null;
  }
}

/** Every operation in the spec, grouped by its first tag, in spec order. */
export function presetsFromSpec(spec: OpenApiSpec): Preset[] {
  const out: Preset[] = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [m, op] of Object.entries(ops)) {
      const method = m.toUpperCase() as Method;
      if (!METHODS.includes(method)) continue;
      const json = op.requestBody?.content?.["application/json"];
      const body = json ? JSON.stringify(sampleFor(spec, json.schema), null, 2) : undefined;
      const group = op.tags?.[0] ?? "Other";
      const collection = /^\/api\/v1\/([A-Za-z0-9_]+)(\/|$)/.exec(path)?.[1];
      const isCollection = collection && !["auth", "files", "admin", "collections"].includes(collection);
      out.push({
        method,
        // Lists open on a short page rather than the default size.
        path: op.parameters?.some((p) => p.in === "query" && p.name === "perPage") ? `${path}?perPage=10` : path,
        summary: op.summary ?? "",
        group,
        ...(body !== undefined ? { body } : {}),
        ...(isCollection ? { collection } : {}),
      });
    }
  }
  return out;
}

/** Groups in display order: System first, then the spec's, in first-seen order. */
export function groupPresets(presets: Preset[]): Array<{ group: string; items: Preset[] }> {
  const groups = new Map<string, Preset[]>();
  for (const p of presets) {
    const list = groups.get(p.group) ?? [];
    list.push(p);
    groups.set(p.group, list);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}

export function matchesPreset(p: Preset, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return `${p.method} ${p.path} ${p.summary} ${p.group}`.toLowerCase().includes(needle);
}
