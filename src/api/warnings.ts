/**
 * `Vaultbase-Warning` for request keys that do nothing: an unknown sort,
 * expand or fields name, or a body key that isn't a field. They used to be
 * dropped in silence, so `?sort=-titel` returned the wrong order with a 200.
 * 0.42 warns (header, plus a server log line once per collection and key);
 * 0.44 answers 400.
 *
 * Unknown and private names get the same wording, so the warning can't be
 * used to find out which fields exist but are hidden.
 */
import { parseFields, privateFieldNames } from "../core/collections.ts";
import type { Collection } from "../db/schema.ts";

const SYSTEM_KEYS = new Set(["id", "created", "updated", "created_at", "updated_at", "collectionId", "collectionName"]);
const AUTH_BODY_KEYS = new Set(["email", "password", "passwordConfirm", "oldPassword", "emailVisibility", "verified"]);
const logged = new Set<string>();

function names(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Warnings for a list request's sort, expand and fields. Views are skipped: their columns come from their SELECT. */
export function queryWarnings(col: Collection, q: { sort?: string; expand?: string; fields?: string }): string[] {
  if (col.type === "view") return [];
  const schema = parseFields(col.fields);
  const hidden = privateFieldNames(col);
  const visible = new Set(schema.filter((f) => !hidden.has(f.name)).map((f) => f.name));
  const out: string[] = [];
  for (const s of names(q.sort)) {
    const f = s.startsWith("-") || s.startsWith("+") ? s.slice(1) : s;
    if (!visible.has(f) && !SYSTEM_KEYS.has(f)) out.push(`unknown sort field '${f}'`);
  }
  const relations = new Set(schema.filter((f) => f.type === "relation" && !hidden.has(f.name)).map((f) => f.name));
  for (const p of names(q.expand)) {
    const head = p.split(".")[0]!;
    if (!relations.has(head)) out.push(`unknown expand '${head}' (not a relation field)`);
  }
  for (const f of names(q.fields)) {
    if (f === "*" || f === "expand") continue;
    if (!visible.has(f) && !SYSTEM_KEYS.has(f)) out.push(`unknown field '${f}' in fields`);
  }
  return out;
}

/** Warnings for body keys that aren't fields of the collection. */
export function bodyWarnings(col: Collection, body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body) || col.type === "view") return [];
  const known = new Set(parseFields(col.fields).map((f) => f.name));
  const out: string[] = [];
  for (const k of Object.keys(body)) {
    if (known.has(k) || SYSTEM_KEYS.has(k) || (col.type === "auth" && AUTH_BODY_KEYS.has(k))) continue;
    out.push(`unknown field '${k}' in body (ignored)`);
  }
  return out;
}

/** Put the warnings on the response and log each new one once. */
export function warn(set: { headers: Record<string, string | number> }, col: Collection, warnings: string[]): void {
  if (warnings.length === 0) return;
  const prev = set.headers["Vaultbase-Warning"];
  set.headers["Vaultbase-Warning"] = [...(prev ? [String(prev)] : []), ...warnings].join(" | ");
  for (const w of warnings) {
    const key = `${col.name}\0${w}`;
    if (logged.has(key) || logged.size > 1000) continue;
    logged.add(key);
    process.stderr.write(`vaultbase: ${col.name}: ${w}\n`);
  }
}
