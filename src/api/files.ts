import { and, eq, lt } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { existsSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join, resolve, sep } from "path";
import { getDb } from "../db/client.ts";
import { auditLog, files, fileTokenUses } from "../db/schema.ts";
import { getCollection, parseFields, type FieldDef } from "../core/collections.ts";
import {
  detectFormat,
  canThumbnail,
  forgetThumbVariants,
  generateThumbnail,
  MAX_THUMB_VARIANTS,
  noteThumbVariant,
  releaseThumbVariant,
  reserveThumbVariant,
  parseOutputOptions,
  parseThumbSpec,
  thumbCachePath,
  thumbMime,
  thumbSizeKey,
  thumbVariantCount,
  type ThumbFormat,
  type ThumbSpec,
} from "../core/image.ts";
import { getRecord, updateRecord } from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import { evaluateRule, type AuthContext } from "../core/rules.ts";
import type { RequestContextLike } from "../core/filter.ts";
import { deleteFile, fileExists, fileResponse, readFile, writeFile } from "../core/storage.ts";
import { tokenWindowSeconds } from "../core/auth-tokens.ts";
import { getSetting, MAX_UPLOAD_BYTES, MIN_UPLOAD_BYTES } from "./settings.ts";
import {
  dataPrincipal,
  extractBearer,
  isAllowedUploadMime,
  isSafeToRenderInline,
  isValidStorageFilename,
  peerAddress,
  signAuthToken,
  trustedClientIp,
  verifyAuthToken,
} from "../core/sec.ts";

/** API tokens act within their scopes (see `dataPrincipal`). */
async function getAuthContext(
  request: Request,
  jwtSecret: string,
  access: "read" | "write"
): Promise<AuthContext | null> {
  const token = extractBearer(request);
  if (!token) return null;
  return dataPrincipal(await verifyAuthToken(token, jwtSecret), access);
}

async function isFileProtected(filename: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select().from(files).where(eq(files.filename, filename)).limit(1);
  const meta = rows[0];
  if (!meta) return false;
  const col = await getCollection(meta.collection_id);
  if (!col) return false;
  const fields = parseFields(col.fields);
  const def = fields.find((f) => f.name === meta.field_name);
  return def?.options?.protected === true;
}

async function fileMetaOf(filename: string) {
  const db = getDb();
  const rows = await db.select().from(files).where(eq(files.filename, filename)).limit(1);
  return rows[0] ?? null;
}

/** Pull the peer-IP off the Bun.serve `server` object that Elysia exposes. */
function peerIpOf(server: unknown, request: Request): string | null {
  return peerAddress(request, server);
}

/** Build the file-context object exposed to per-field rules. */
function buildFileRequestContext(
  request: Request,
  ip: string,
  meta: { mime_type: string; size: number; field_name: string },
  collectionName: string,
): RequestContextLike & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "set-cookie") continue;
    headers[lower.replace(/-/g, "_")] = v;
  }
  // `@request.ip` and `@file.*` are read-only — surfaced via the `headers` map
  // so the existing rule engine doesn't need a new operand kind. Rule authors
  // write `@request.headers.x_vb_ip = '1.2.3.4'`-style — but for ergonomics we
  // also expose them under conventional names.
  headers["x_vb_ip"]            = ip;
  headers["x_vb_file_field"]    = meta.field_name;
  headers["x_vb_file_mime"]     = meta.mime_type;
  headers["x_vb_file_size"]     = String(meta.size);
  headers["x_vb_collection"]    = collectionName;
  return {
    method: request.method.toUpperCase(),
    context: "protectedFile",
    headers,
    query: {},
    body: null,
    existing: null,
  };
}

interface FileTokenClaims {
  filename: string;
  ip?: string;
  uses?: number;
  jti?: string;
}

/**
 * Verify a file-audience JWT and return the relevant claims. Returns null on
 * any verify failure (signature / audience / expiry / revocation).
 */
async function verifyFileTokenClaims(token: string, jwtSecret: string): Promise<FileTokenClaims | null> {
  const ctx = await verifyAuthToken(token, jwtSecret, {
    audience: "file",
    recheckPrincipal: false,
  });
  if (!ctx) return null;
  // verifyAuthToken returned ok — re-decode payload (no signature work) to
  // pull the file-specific claims that the common return shape doesn't carry.
  try {
    const mid = token.split(".")[1] ?? "";
    const padded = mid.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(mid.length / 4) * 4, "=");
    const json = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    )) as Record<string, unknown>;
    const filename = typeof json["filename"] === "string" ? json["filename"] : null;
    if (!filename) return null;
    const out: FileTokenClaims = { filename };
    if (typeof json["ip"]   === "string") out.ip   = json["ip"];
    if (typeof json["uses"] === "number") out.uses = json["uses"];
    if (typeof ctx.jti      === "string") out.jti  = ctx.jti;
    return out;
  } catch {
    return null;
  }
}

/**
 * Try to claim a one-time-use token. Returns true on first claim, false on
 * replay (a row with the same `jti` already exists). Idempotent w.r.t. the
 * same jti.
 */
async function claimOneTimeToken(jti: string, ip: string | null): Promise<boolean> {
  try {
    await getDb().insert(fileTokenUses).values({
      jti,
      used_at: Math.floor(Date.now() / 1000),
      ...(ip ? { ip } : {}),
    });
    return true;
  } catch {
    return false; // primary-key conflict → replay
  }
}

/** Prune file_token_uses rows older than 24h. Called from the periodic cleanup. */
export async function pruneFileTokenUses(): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const res = await getDb().delete(fileTokenUses).where(lt(fileTokenUses.used_at, cutoff));
  return (res as unknown as { changes?: number }).changes ?? 0;
}

interface AccessOutcome {
  allowed: boolean;
  reason: string;
  /** Field def for downstream audit / token mint. */
  fieldDef: FieldDef | null;
}

/**
 * Centralised access-decision for a file fetch / token mint. Combines the
 * collection view_rule and the field-level viewRule (AND), then applies the
 * field-level requireAuth gate. Admin always passes (handled by evaluateRule).
 */
async function evaluateFileAccess(
  collectionId: string,
  recordId: string,
  fieldName: string,
  auth: AuthContext | null,
  reqCtx: RequestContextLike | null,
): Promise<AccessOutcome> {
  const col = await getCollection(collectionId);
  if (!col) return { allowed: false, reason: "collection not found", fieldDef: null };

  if (auth?.type === "admin") {
    const fields = parseFields(col.fields);
    return { allowed: true, reason: "admin bypass", fieldDef: fields.find((f) => f.name === fieldName) ?? null };
  }

  const fields = parseFields(col.fields);
  const fieldDef = fields.find((f) => f.name === fieldName) ?? null;
  const opts = fieldDef?.options ?? {};

  // requireAuth gate — must run before any rule eval, since the rule engine
  // treats `null` rules as public.
  if (opts.requireAuth && !auth) return { allowed: false, reason: "auth required", fieldDef };

  // Collection rule
  if (col.view_rule === "") return { allowed: false, reason: "collection: admin only", fieldDef };
  let record: Record<string, unknown> | null = null;
  if (col.view_rule !== null) {
    record = (await getRecord(col.name, recordId)) as Record<string, unknown> | null;
    if (!record) return { allowed: false, reason: "record not found", fieldDef };
    const ok = evaluateRule(col.view_rule, auth, record, reqCtx);
    if (!ok) return { allowed: false, reason: "collection rule denied", fieldDef };
  }

  // Field rule
  const fieldRule = opts.viewRule;
  if (fieldRule === "") return { allowed: false, reason: "field: admin only", fieldDef };
  if (typeof fieldRule === "string" && fieldRule !== "") {
    if (record === null) {
      record = (await getRecord(col.name, recordId)) as Record<string, unknown> | null;
      if (!record) return { allowed: false, reason: "record not found", fieldDef };
    }
    const ok = evaluateRule(fieldRule, auth, record, reqCtx);
    if (!ok) return { allowed: false, reason: "field rule denied", fieldDef };
  }

  return { allowed: true, reason: "rule passed", fieldDef };
}

/** Append a `files.download` row to the audit log. Best-effort — never throws. */
async function emitDownloadAudit(opts: {
  request: Request;
  ip: string | null;
  auth: AuthContext | null;
  filename: string;
  collection: string;
  recordId: string;
  field: string;
  mime: string;
  size: number;
  via: "rule" | "token";
}): Promise<void> {
  try {
    const url = new URL(opts.request.url);
    await getDb().insert(auditLog).values({
      id: crypto.randomUUID(),
      actor_id: opts.auth?.id ?? null,
      actor_email: (opts.auth as { email?: string } | null)?.email ?? null,
      method: "GET",
      path: url.pathname,
      action: "files.download",
      target: opts.filename,
      status: 200,
      ip: opts.ip,
      summary: JSON.stringify({
        collection: opts.collection,
        record: opts.recordId,
        field: opts.field,
        mime: opts.mime,
        size: opts.size,
        via: opts.via,
      }).slice(0, 1024),
      at: Math.floor(Date.now() / 1000),
    });
  } catch { /* audit must never break a download */ }
}

/**
 * A part's media type without parameters. Bun reports text parts with a
 * charset (`text/plain;charset=utf-8`), which no allow-list entry matched,
 * so .txt and .json uploads were refused.
 */
function baseMime(type: string): string {
  return (type || "application/octet-stream").split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
}

function mimeAllowed(mime: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  for (const p of patterns) {
    if (p === mime) return true;
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1);
      if (mime.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Resolve `key` against `uploadDir` and assert it does not escape the dir. */
function safeJoin(uploadDir: string, key: string): string | null {
  if (!isValidStorageFilename(key)) return null;
  const root = resolve(uploadDir);
  const full = resolve(join(root, key));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/**
 * Storage extension for a validated MIME type.
 *
 * The extension used to come from `file.name`, which is client-controlled:
 * uploading `x.html` declared as `image/png` stored `<uuid>.html`, and the
 * storage driver then inferred `Content-Type: text/html` from that name — so
 * the file executed as a page on the API's own origin. Nothing reads the
 * stored extension, so anything unrecognised can safely become `.bin`; the
 * caller's filename is preserved in `original_name` either way.
 */
const EXT_FOR_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/json": "json",
};

function storageExt(mime: string): string {
  return EXT_FOR_MIME[mime.trim().toLowerCase()] ?? "bin";
}

// Thumbnails being generated right now, by cache path. Concurrent misses for
// the same thumb share one decode / resize instead of each doing it.
const thumbsInFlight = new Map<string, Promise<Uint8Array>>();
let thumbsGenerated = 0;

/** Test hook: thumbnails actually generated since process start. */
export function _thumbStats(): { generated: number } {
  return { generated: thumbsGenerated };
}

async function generateThumbOnce(cachePath: string, make: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const pending = thumbsInFlight.get(cachePath);
  if (pending) return pending;
  // A request that missed the cache before an identical one finished
  // generating finds the file here instead of generating it again.
  if (existsSync(cachePath)) return new Uint8Array(await Bun.file(cachePath).arrayBuffer());
  const job = (async () => {
    thumbsGenerated++;
    const thumb = await make();
    // Write then rename, so a concurrent cache hit never reads a half-written file.
    const tmp = `${cachePath}.${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, thumb);
    renameSync(tmp, cachePath);
    return thumb;
  })();
  thumbsInFlight.set(cachePath, job);
  try {
    return await job;
  } finally {
    thumbsInFlight.delete(cachePath);
  }
}

/** Default cap on one upload request (setting `files.max_upload_size`, bytes). */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Multipart framing (boundaries, part headers) on top of the file bytes. */
const MULTIPART_SLACK_BYTES = 64 * 1024;

export function maxUploadBytes(): number {
  const n = parseInt(getSetting("files.max_upload_size", String(DEFAULT_MAX_UPLOAD_BYTES)), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_UPLOAD_BYTES;
  return Math.min(Math.max(n, MIN_UPLOAD_BYTES), MAX_UPLOAD_BYTES);
}

/** This file's thumbnail variants are used up. */
class ThumbLimitError extends Error {}

/**
 * Takes deleted file names out of the record's field, through the normal
 * update path (hooks, realtime, history), before the files themselves go: a
 * field left naming them pointed at files that answered 404. A required
 * field can't lose its last file, so that delete is refused (422).
 */
async function unlinkFromRecord(
  collection: string,
  recordId: string,
  field: FieldDef | undefined,
  removed: string[],
  auth: AuthContext,
  set: { status?: number | string },
): Promise<{ error: string; code: number; details?: Record<string, string> } | null> {
  if (!field || field.type !== "file") return null;
  const record = await getRecord(collection, recordId);
  if (!record) return null;
  const value = (record as Record<string, unknown>)[field.name];
  const gone = new Set(removed);
  let next: unknown;
  if (Array.isArray(value)) {
    const kept = value.filter((f) => !gone.has(String(f)));
    if (kept.length === value.length) return null;
    next = kept;
  } else if (typeof value === "string" && gone.has(value)) {
    next = null;
  } else {
    return null;
  }
  try {
    await updateRecord(collection, recordId, { [field.name]: next }, auth);
  } catch (e) {
    if (e instanceof ValidationError) {
      set.status = 422;
      return { error: "Validation failed", code: 422, details: e.details };
    }
    throw e;
  }
  return null;
}

export function makeFilesPlugin(uploadDir: string, jwtSecret: string) {
  return new Elysia({ name: "files" })
    .post("/files/:collection/:recordId/:field", async ({ params, request, set }) => {
      const auth = await getAuthContext(request, jwtSecret, "write");
      if (!auth) { set.status = 401; return { error: "Unauthorized", code: 401 }; }

      const col = await getCollection(params.collection);
      if (!col) {
        set.status = 404;
        return { error: `Collection '${params.collection}' not found`, code: 404 };
      }

      // Files belong to an existing record. Record ids are generated by the
      // server, so an upload for an id that doesn't exist yet can never be
      // attached to anything — it only fills storage, and it used to be
      // judged by create_rule, which is often looser than update_rule.
      const existing = await getRecord(params.collection, params.recordId);
      if (!existing) { set.status = 404; return { error: "Record not found", code: 404 }; }
      // Authz — admin always; otherwise uploading is an update of the record.
      if (auth.type !== "admin") {
        const rule = col.update_rule;
        if (rule === "") { set.status = 403; return { error: "Forbidden", code: 403 }; }
        if (rule !== null) {
          const ok = evaluateRule(rule, auth, existing as unknown as Record<string, unknown>);
          if (!ok) { set.status = 403; return { error: "Forbidden", code: 403 }; }
        }
      }

      // The multipart body is buffered in memory while parsing, so refuse
      // oversized requests from Content-Length before reading it.
      const cap = maxUploadBytes();
      const declared = Number(request.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > cap + MULTIPART_SLACK_BYTES) {
        set.status = 413;
        return { error: `Upload too large (max ${cap} bytes)`, code: 413 };
      }

      let formData: Awaited<ReturnType<Request["formData"]>>;
      try {
        formData = await request.formData();
      } catch {
        set.status = 400;
        return { error: "Send the file as multipart/form-data, in a field named 'file'", code: 400 };
      }
      const fileEntries = (formData.getAll("file") as unknown[]).filter((v): v is File => v instanceof File);
      const total = fileEntries.reduce((n, f) => n + f.size, 0);
      if (total > cap) {
        set.status = 413;
        return { error: `Upload too large (max ${cap} bytes)`, code: 413 };
      }
      if (fileEntries.length === 0) {
        set.status = 400;
        return { error: "No file uploaded", code: 400 };
      }

      const schema = parseFields(col.fields);
      const fieldDef = schema.find((f) => f.name === params.field);
      if (!fieldDef) {
        set.status = 404;
        return { error: `Field '${params.field}' not found on '${col.name}'`, code: 404 };
      }
      if (fieldDef.type !== "file") {
        set.status = 400;
        return { error: `Field '${params.field}' is not a file field`, code: 400 };
      }

      const opts = fieldDef.options ?? {};
      const multiple = !!opts["multiple"];
      const maxSize = typeof opts["maxSize"] === "number" ? opts["maxSize"] : 0;
      const mimeTypes = Array.isArray(opts["mimeTypes"]) ? (opts["mimeTypes"] as string[]) : [];

      if (!multiple && fileEntries.length > 1) {
        set.status = 400;
        return { error: `Field '${params.field}' is single-file; multiple uploads not allowed`, code: 400 };
      }

      // Validate every file before writing any. Reject anything outside the
      // global allowlist regardless of the field's configured patterns.
      for (const f of fileEntries) {
        if (maxSize > 0 && f.size > maxSize) {
          set.status = 422;
          return {
            error: `File too large: ${f.size} bytes (max ${maxSize})`,
            code: 422,
            details: { [params.field]: `Max ${maxSize} bytes` },
          };
        }
        const fm = baseMime(f.type);
        if (!isAllowedUploadMime(fm)) {
          set.status = 415;
          return { error: `MIME type '${fm}' not allowed`, code: 415 };
        }
        if (!mimeAllowed(fm, mimeTypes)) {
          set.status = 422;
          return {
            error: `MIME type '${fm}' not allowed by field rules`,
            code: 422,
            details: { [params.field]: `Allowed: ${mimeTypes.join(", ")}` },
          };
        }
      }

      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const uploaded: Array<{ id: string; filename: string; originalName: string; size: number; mimeType: string }> = [];
      for (const file of fileEntries) {
        const fileMime = baseMime(file.type);
        const id = crypto.randomUUID();
        const filename = `${id}.${storageExt(fileMime)}`;
        // Pass the File (a Blob) straight through: no second in-memory copy.
        await writeFile(filename, file, fileMime);
        await db.insert(files).values({
          id,
          collection_id: col.id,
          record_id: params.recordId,
          field_name: params.field,
          filename,
          original_name: file.name.slice(0, 255),
          mime_type: fileMime,
          size: file.size,
          created_at: now,
        });
        uploaded.push({ id, filename, originalName: file.name, size: file.size, mimeType: fileMime });
      }

      if (!multiple) return { data: uploaded[0] };
      return { data: uploaded };
    })
    .post(
      "/files/:collection/:recordId/:field/:filename/token",
      async ({ params, request, server, set }) => {
        if (!isValidStorageFilename(params.filename)) {
          set.status = 400; return { error: "Invalid filename", code: 400 };
        }
        // Minting a download token is a read of the file.
        const auth = await getAuthContext(request, jwtSecret, "read");

        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const fields = parseFields(col.fields);
        const fieldDef = fields.find((f) => f.name === params.field);
        if (!fieldDef || fieldDef.type !== "file") {
          set.status = 404; return { error: "File field not found", code: 404 };
        }
        const record = await getRecord(params.collection, params.recordId);
        if (!record) { set.status = 404; return { error: "Record not found", code: 404 }; }

        const db = getDb();
        const fileRows = await db.select().from(files).where(
          and(
            eq(files.collection_id, col.id),
            eq(files.record_id, params.recordId),
            eq(files.field_name, params.field),
            eq(files.filename, params.filename)
          )
        ).limit(1);
        const meta = fileRows[0];
        if (!meta) {
          set.status = 404; return { error: "File not found", code: 404 };
        }

        const peerIp = peerIpOf(server, request);
        const ip = trustedClientIp(request, peerIp);
        const reqCtx = buildFileRequestContext(request, ip, meta, col.name);
        const decision = await evaluateFileAccess(col.id, params.recordId, params.field, auth, reqCtx);
        if (!decision.allowed) { set.status = 403; return { error: "Forbidden", code: 403 }; }

        const opts = fieldDef.options ?? {};
        const payload: Record<string, unknown> = { filename: params.filename };
        if (opts.bindTokenIp)  payload["ip"]   = ip;
        if (opts.oneTimeToken) payload["uses"] = 1;

        const { token, exp } = await signAuthToken({
          payload,
          audience: "file",
          expiresInSeconds: tokenWindowSeconds("file"),
          jwtSecret,
        });
        // `one_time` tells a client not to cache the token: it works once.
        return { data: { token, expires_at: exp, one_time: opts.oneTimeToken === true } };
      }
    )
    .get("/files/:filename", async ({ params, query, request, server, set }) => {
      // Never kept by a shared cache (a CDN in front): its key is the URL,
      // and whether a file is served depends on who asks. Errors too.
      set.headers["Cache-Control"] = "no-store";
      if (!isValidStorageFilename(params.filename)) {
        set.status = 400;
        return { error: "Invalid filename", code: 400 };
      }
      if (!(await fileExists(params.filename))) {
        set.status = 404;
        return { error: "File not found", code: 404 };
      }

      const meta = await fileMetaOf(params.filename);
      const peerIp = peerIpOf(server, request);
      const clientIp = trustedClientIp(request, peerIp);
      const auth = await getAuthContext(request, jwtSecret, "read");

      let allowed = false;
      let via: "rule" | "token" = "rule";
      let collectionName = "";
      let fieldDefForAudit: FieldDef | null = null;

      if (!meta) {
        // Orphan files (no row) — admin-only.
        allowed = auth?.type === "admin";
      } else {
        const col = await getCollection(meta.collection_id);
        collectionName = col?.name ?? "";
        if (col) {
          const fields = parseFields(col.fields);
          fieldDefForAudit = fields.find((f) => f.name === meta.field_name) ?? null;
        }
        const tok = query.token;
        if (tok) {
          // ── Token path ────────────────────────────────────────────────
          const claims = await verifyFileTokenClaims(tok, jwtSecret);
          if (claims && claims.filename === params.filename) {
            // IP binding: token's ip claim must match the requesting client.
            if (claims.ip !== undefined && claims.ip !== clientIp) {
              set.status = 403;
              return { error: "Token bound to a different IP", code: 403 };
            }
            // One-time use: insert-or-fail on the jti.
            if (claims.uses === 1 && claims.jti) {
              const ok = await claimOneTimeToken(claims.jti, clientIp);
              if (!ok) {
                set.status = 410;
                return { error: "Token already used", code: 410 };
              }
            }
            allowed = true;
            via = "token";
          }
        }
        // A protected field is served by token only: falling through to the
        // rule path made `protected` (and one-time / IP-bound tokens) a no-op
        // on any record the caller could view. Admins are exempt.
        // A file whose field no longer exists (dropped or renamed) has no
        // field options left to say whether it was protected: treat it like
        // an orphan, admin-only, rather than falling back to the rules.
        const protectedField = fieldDefForAudit?.options?.protected === true || !fieldDefForAudit;
        if (!allowed && protectedField && auth?.type !== "admin") {
          set.status = 401;
          return { error: "Token required", code: 401 };
        }
        if (!allowed) {
          // ── Rule path ─────────────────────────────────────────────────
          const reqCtx = buildFileRequestContext(request, clientIp, meta, collectionName);
          const decision = await evaluateFileAccess(meta.collection_id, meta.record_id, meta.field_name, auth, reqCtx);
          if (decision.fieldDef) fieldDefForAudit = decision.fieldDef;
          allowed = decision.allowed;
        }
      }

      if (!allowed) {
        // Legacy `protected: true` field with no token? 401 (the front-end
        // knows to mint a token when it sees this code). Otherwise 403.
        if (meta && (await isFileProtected(params.filename)) && !query.token) {
          set.status = 401;
          return { error: "Token required", code: 401 };
        }
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }

      if (meta && fieldDefForAudit?.options?.auditDownloads) {
        await emitDownloadAudit({
          request,
          ip: clientIp,
          auth,
          filename: params.filename,
          collection: collectionName,
          recordId: meta.record_id,
          field: meta.field_name,
          mime: meta.mime_type,
          size: meta.size,
          via,
        });
      }

      const inlineSafe = meta ? isSafeToRenderInline(meta.mime_type) : false;
      const baseHeaders: Record<string, string> = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        // Set explicitly rather than inherited from the storage driver, which
        // infers it from the stored filename. `nosniff` does not help when the
        // declared type genuinely *is* text/html.
        "Content-Type": inlineSafe && meta ? meta.mime_type : "application/octet-stream",
        // Defence in depth: even with a correct type, nothing served from here
        // may execute, load subresources, or reach back into this origin.
        "Content-Security-Policy": "sandbox; default-src 'none'",
        // The browser may keep it, a shared cache may not: access was decided
        // for this caller (a rule can read the session, headers or IP). A
        // token's file isn't kept at all: it may work once, or from one IP.
        "Cache-Control": via === "token" ? "private, no-store" : "private",
      };
      if (!inlineSafe) {
        const safeName = (meta?.original_name ?? params.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        baseHeaders["Content-Disposition"] = `attachment; filename="${safeName}"`;
      }

      const output = parseOutputOptions(query.format, query.quality, request.headers.get("accept"));
      if (typeof output === "string") { set.status = 400; return { error: output, code: 400 }; }
      // `format=auto` varies by Accept, whichever way it resolved.
      if (output.auto) baseHeaders["Vary"] = "Accept";

      const original = async (reason?: string) => {
        const r = await fileResponse(params.filename);
        if (!r) { set.status = 404; return { error: "File not found", code: 404 }; }
        // Layer headers on top of storage Response.
        for (const [k, v] of Object.entries(baseHeaders)) r.headers.set(k, v);
        if (reason) r.headers.set("X-Vaultbase-Thumb", reason);
        return r;
      };

      // `?thumb=` resizes; `?format=` / `?quality=` alone re-encode at source size.
      // `fit` may come as its own query param (`?thumb=64x64&fit=cover`).
      const thumbRaw = query.thumb && query.fit ? `${query.thumb}&fit=${query.fit}` : query.thumb;
      const size = thumbRaw ? parseThumbSpec(thumbRaw) : null;
      if (query.thumb && !size) return original();
      if (!size && !output.format && output.quality === undefined) return original();
      const spec: ThumbSpec = size ?? { width: 0, height: 0, fit: "contain" };
      if (output.format) spec.format = output.format;
      if (output.quality !== undefined) spec.quality = output.quality;

      // A field's thumbs list limits the sizes non-admins can ask for.
      const allowedSizes = fieldDefForAudit?.options?.thumbs;
      if (size && auth?.type !== "admin" && allowedSizes && allowedSizes.length > 0) {
        const wanted = thumbSizeKey(size);
        const ok = allowedSizes.some((s) => {
          const p = parseThumbSpec(s);
          return p !== null && thumbSizeKey(p) === wanted;
        });
        if (!ok) return original("not-allowed");
      }

      const cachePath = thumbCachePath(uploadDir, params.filename, spec);
      const cached = Bun.file(cachePath);
      if (await cached.exists()) {
        const head = new Uint8Array(await cached.slice(0, 16).arrayBuffer());
        const cf = detectFormat(head);
        const headers: Record<string, string> = { ...baseHeaders };
        if (cf) headers["Content-Type"] = thumbMime(cf);
        return new Response(cached, { headers });
      }

      // Each new variant costs a decode and a cache file; cap them per file.
      if (auth?.type !== "admin" && thumbVariantCount(uploadDir, params.filename) >= MAX_THUMB_VARIANTS) {
        return original("limit");
      }

      const buf = await readFile(params.filename);
      if (!buf) { set.status = 404; return { error: "File not found", code: 404 }; }
      const bytes = new Uint8Array(buf);
      const format = detectFormat(bytes);
      // Unknown or not resizable (AVIF): serve the original.
      if (!format || !canThumbnail(format)) return original();

      try {
        const thumb = await generateThumbOnce(cachePath, async () => {
          // Runs once per variant; the slot is taken atomically here.
          if (auth?.type === "admin") noteThumbVariant(params.filename);
          else if (!reserveThumbVariant(uploadDir, params.filename)) throw new ThumbLimitError();
          try {
            return await generateThumbnail(bytes, spec, format as ThumbFormat);
          } catch (e) {
            releaseThumbVariant(params.filename);
            throw e;
          }
        });
        const outFormat = detectFormat(thumb) ?? format;
        return new Response(thumb, {
          headers: { ...baseHeaders, "Content-Type": thumbMime(outFormat) },
        });
      } catch (e) {
        if (e instanceof ThumbLimitError) return original("limit");
        const r = await fileResponse(params.filename);
        if (!r) return new Response(null, { status: 404 });
        for (const [k, v] of Object.entries(baseHeaders)) r.headers.set(k, v);
        return r;
      }
    }, {
      query: t.Object({
        thumb: t.Optional(t.String()),
        fit: t.Optional(t.String()),
        format: t.Optional(t.String()),
        quality: t.Optional(t.String()),
        token: t.Optional(t.String()),
      }),
    })
    .delete("/files/:collection/:recordId/:field", async ({ params, request, set }) => {
      const auth = await getAuthContext(request, jwtSecret, "write");
      if (!auth) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (auth.type !== "admin") {
        const existing = await getRecord(params.collection, params.recordId);
        const rule = col.update_rule;
        if (rule === "") { set.status = 403; return { error: "Forbidden", code: 403 }; }
        if (rule !== null) {
          const ok = evaluateRule(rule, auth, (existing ?? {}) as Record<string, unknown>);
          if (!ok) { set.status = 403; return { error: "Forbidden", code: 403 }; }
        }
      }
      const db = getDb();
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.collection_id, col.id),
            eq(files.record_id, params.recordId),
            eq(files.field_name, params.field)
          )
        );
      if (rows.length === 0) { set.status = 404; return { error: "File not found", code: 404 }; }
      const fieldDef = parseFields(col.fields).find((f) => f.name === params.field);
      const refused = await unlinkFromRecord(col.name, params.recordId, fieldDef, rows.map((r) => r.filename), auth, set);
      if (refused) return refused;
      for (const meta of rows) {
        await deleteFile(meta.filename);
        deleteThumbsFor(uploadDir, meta.filename);
        await db.delete(files).where(eq(files.id, meta.id));
      }
      return { data: { deleted: rows.length } };
    })
    .delete("/files/:collection/:recordId/:field/:filename", async ({ params, request, set }) => {
      const auth = await getAuthContext(request, jwtSecret, "write");
      if (!auth) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      if (!isValidStorageFilename(params.filename)) {
        set.status = 400; return { error: "Invalid filename", code: 400 };
      }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (auth.type !== "admin") {
        const existing = await getRecord(params.collection, params.recordId);
        const rule = col.update_rule;
        if (rule === "") { set.status = 403; return { error: "Forbidden", code: 403 }; }
        if (rule !== null) {
          const ok = evaluateRule(rule, auth, (existing ?? {}) as Record<string, unknown>);
          if (!ok) { set.status = 403; return { error: "Forbidden", code: 403 }; }
        }
      }
      const db = getDb();
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.collection_id, col.id),
            eq(files.record_id, params.recordId),
            eq(files.field_name, params.field),
            eq(files.filename, params.filename)
          )
        )
        .limit(1);
      const meta = rows[0];
      if (!meta) { set.status = 404; return { error: "File not found", code: 404 }; }
      const fieldDef = parseFields(col.fields).find((f) => f.name === params.field);
      const refused = await unlinkFromRecord(col.name, params.recordId, fieldDef, [meta.filename], auth, set);
      if (refused) return refused;
      await deleteFile(meta.filename);
      deleteThumbsFor(uploadDir, meta.filename);
      await db.delete(files).where(eq(files.id, meta.id));
      return { data: null };
    });
  // safeJoin retained for storage-layer hardening if/when it grows callers.
  void safeJoin;
}

function deleteThumbsFor(uploadDir: string, filename: string): void {
  const dir = join(uploadDir, ".thumbs");
  if (!existsSync(dir)) return;
  const prefix = `${filename}__`;
  forgetThumbVariants(filename);
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) {
        try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}
