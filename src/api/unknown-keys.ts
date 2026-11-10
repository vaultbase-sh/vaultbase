/**
 * Request keys that do nothing: an unknown sort, expand or fields name on a
 * list, or a body key that isn't a field on create and update. They used to
 * be dropped in silence, so `?sort=-titel` returned the wrong order with a
 * 200. 0.42 and 0.43 warned (a `Vaultbase-Warning` header); since 0.44 the
 * request answers 400. The checks are the ones the warnings used, so only
 * requests that were warned about are refused.
 *
 * Unknown and private names get the same wording, and the answer never
 * lists the valid names, so it can't be used to find out which fields exist
 * but are hidden.
 */
import { parseFields, privateFieldNames } from "../core/collections.ts";
import type { Collection } from "../db/schema.ts";

/** Keys the server itself puts on a record: sending them back (a fetched record, edited and saved) is fine. */
const SYSTEM_KEYS = new Set(["id", "created", "updated", "created_at", "updated_at", "collectionId", "collectionName"]);
/** Other keys a returned record can carry: `expand` when expanded, `_score` from a vector search. */
const RESPONSE_ONLY_KEYS = new Set(["expand", "_score"]);
/** Columns a user record carries that aren't fields of its auth collection. */
const AUTH_RECORD_KEYS = ["email_verified", "totp_enabled", "is_anonymous"];
/**
 * Auth collections: the sign-up and password keys, and the columns a user
 * record carries that aren't fields (`email_verified`, `totp_enabled`,
 * `is_anonymous`). An update ignores those three (they change through the
 * auth flows), so a fetched user record can still be saved back.
 */
const AUTH_BODY_KEYS = new Set([
  "email", "password", "passwordConfirm", "oldPassword", "emailVisibility", "verified",
  ...AUTH_RECORD_KEYS,
]);

/** One refused key: `key` is the query parameter or the body key it is about. */
export interface UnknownKey { key: string; message: string }

function names(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** What's wrong with a list request's sort, expand and fields. Views are skipped: their columns come from their SELECT. */
export function unknownQueryKeys(col: Collection, q: { sort?: string; expand?: string; fields?: string }): UnknownKey[] {
  if (col.type === "view") return [];
  const schema = parseFields(col.fields);
  const hidden = privateFieldNames(col);
  const visible = new Set(schema.filter((f) => !hidden.has(f.name)).map((f) => f.name));
  const out: UnknownKey[] = [];
  // `sort=@rank` (the whole value) orders a search by relevance; it names no field.
  for (const s of q.sort === "@rank" ? [] : names(q.sort)) {
    const f = s.startsWith("-") || s.startsWith("+") ? s.slice(1) : s;
    if (!visible.has(f) && !SYSTEM_KEYS.has(f)) out.push({ key: "sort", message: `unknown sort field '${f}'` });
  }
  const relations = new Set(schema.filter((f) => f.type === "relation" && !hidden.has(f.name)).map((f) => f.name));
  for (const p of names(q.expand)) {
    const head = p.split(".")[0]!;
    if (!relations.has(head)) out.push({ key: "expand", message: `unknown expand '${head}' (not a relation field)` });
  }
  // `fields` keeps any key a returned record has, so it takes those too.
  const returned = new Set([...RESPONSE_ONLY_KEYS, ...(col.type === "auth" ? AUTH_RECORD_KEYS : [])]);
  for (const f of names(q.fields)) {
    if (f === "*" || returned.has(f)) continue;
    if (!visible.has(f) && !SYSTEM_KEYS.has(f)) out.push({ key: "fields", message: `unknown field '${f}' in fields` });
  }
  return out;
}

/** Body keys that aren't fields of the collection. */
export function unknownBodyKeys(col: Collection, body: unknown): UnknownKey[] {
  if (!body || typeof body !== "object" || Array.isArray(body) || col.type === "view") return [];
  const known = new Set(parseFields(col.fields).map((f) => f.name));
  const out: UnknownKey[] = [];
  for (const k of Object.keys(body)) {
    if (known.has(k) || SYSTEM_KEYS.has(k) || RESPONSE_ONLY_KEYS.has(k) || (col.type === "auth" && AUTH_BODY_KEYS.has(k))) continue;
    out.push({ key: k, message: `unknown field '${k}' in body` });
  }
  return out;
}

export interface UnknownKeysBody { error: string; code: 400; details: Record<string, string> }

/**
 * The 400 for unknown keys. `details` maps the query parameter or body key
 * to what's wrong with it (the shape a 422's `details` has, which the SDKs
 * read); `error` names the first few.
 */
export function unknownKeys(set: { status?: number | string }, problems: UnknownKey[]): UnknownKeysBody {
  set.status = 400;
  const messages = problems.map((p) => p.message);
  const text = messages.slice(0, 3).join("; ") + (messages.length > 3 ? `; and ${messages.length - 3} more` : "");
  const details: Record<string, string> = {};
  for (const p of problems) details[p.key] = details[p.key] ? `${details[p.key]}; ${p.message}` : p.message;
  return { error: text.charAt(0).toUpperCase() + text.slice(1), code: 400, details };
}
