import { and, eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { existsSync, readdirSync, unlinkSync } from "fs";
import { join, resolve, sep } from "path";
import { getDb } from "../db/client.ts";
import { files } from "../db/schema.ts";
import { getCollection, parseFields } from "../core/collections.ts";
import {
  detectFormat,
  generateThumbnail,
  parseThumbSpec,
  thumbCachePath,
  thumbMime,
  type ThumbFormat,
} from "../core/image.ts";
import { getRecord } from "../core/records.ts";
import { evaluateRule, type AuthContext } from "../core/rules.ts";
import { deleteFile, fileExists, fileResponse, readFile, writeFile } from "../core/storage.ts";
import { tokenWindowSeconds } from "../core/auth-tokens.ts";
import {
  extractBearer,
  isAllowedUploadMime,
  isSafeToRenderInline,
  isValidStorageFilename,
  signAuthToken,
  verifyAuthToken,
} from "../core/sec.ts";

async function getAuthContext(
  request: Request,
  jwtSecret: string
): Promise<AuthContext | null> {
  const token = extractBearer(request);
  if (!token) return null;
  return await verifyAuthToken(token, jwtSecret);
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

async function viewRuleAllows(
  collectionId: string,
  recordId: string,
  auth: AuthContext | null
): Promise<boolean> {
  const col = await getCollection(collectionId);
  if (!col) return false;
  if (auth?.type === "admin") return true;
  if (col.view_rule === "") return false;
  if (col.view_rule === null) return true;
  const record = await getRecord(col.name, recordId);
  if (!record) return false;
  return evaluateRule(col.view_rule, auth, record as unknown as Record<string, unknown>);
}

async function verifyFileToken(token: string, filename: string, jwtSecret: string): Promise<boolean> {
  const ctx = await verifyAuthToken(token, jwtSecret, {
    audience: "file",
    recheckPrincipal: false,
  });
  if (!ctx) return false;
  // Filename binding lives in the JWT payload; verifyAuthToken returns the
  // common shape but we need the raw filename claim. Re-decode without verify
  // (already verified above) is wasteful — instead the signer puts filename in
  // the payload and we compare by re-decoding the JWT's middle segment.
  try {
    const mid = token.split(".")[1] ?? "";
    const json = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(mid.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(mid.length / 4) * 4, "=")),
          (c) => c.charCodeAt(0))
      )
    );
    return json.filename === filename;
  } catch {
    return false;
  }
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

const SAFE_EXT_RE = /^[a-z0-9]{1,12}$/i;

function safeExt(originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot < 0) return "bin";
  const ext = originalName.slice(dot + 1).toLowerCase();
  return SAFE_EXT_RE.test(ext) ? ext : "bin";
}

export function makeFilesPlugin(uploadDir: string, jwtSecret: string) {
  return new Elysia({ name: "files" })
    .post("/api/files/:collection/:recordId/:field", async ({ params, request, set }) => {
      const auth = await getAuthContext(request, jwtSecret);
      if (!auth) { set.status = 401; return { error: "Unauthorized", code: 401 }; }

      const col = await getCollection(params.collection);
      if (!col) {
        set.status = 404;
        return { error: `Collection '${params.collection}' not found`, code: 404 };
      }

      // Authz — admin always; else evaluate the appropriate rule. New record
      // → create_rule; existing record → update_rule.
      const existing = await getRecord(params.collection, params.recordId);
      if (auth.type !== "admin") {
        const rule = existing ? col.update_rule : col.create_rule;
        if (rule === "") { set.status = 403; return { error: "Forbidden", code: 403 }; }
        if (rule !== null) {
          const ok = evaluateRule(rule, auth, (existing ?? {}) as Record<string, unknown>);
          if (!ok) { set.status = 403; return { error: "Forbidden", code: 403 }; }
        }
      }

      const formData = await request.formData();
      const fileEntries = (formData.getAll("file") as unknown[]).filter((v): v is File => v instanceof File);
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
        const fm = f.type || "application/octet-stream";
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
        const ext = safeExt(file.name);
        const id = crypto.randomUUID();
        const filename = `${id}.${ext}`;
        const fileMime = file.type || "application/octet-stream";
        await writeFile(filename, await file.arrayBuffer(), fileMime);
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
      "/api/files/:collection/:recordId/:field/:filename/token",
      async ({ params, request, set }) => {
        if (!isValidStorageFilename(params.filename)) {
          set.status = 400; return { error: "Invalid filename", code: 400 };
        }
        const auth = await getAuthContext(request, jwtSecret);

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
        if (fileRows.length === 0) {
          set.status = 404; return { error: "File not found", code: 404 };
        }

        if (auth?.type !== "admin") {
          if (col.view_rule === "") {
            set.status = 403; return { error: "Forbidden", code: 403 };
          }
          if (col.view_rule !== null) {
            const allowed = evaluateRule(
              col.view_rule,
              auth,
              record as unknown as Record<string, unknown>,
            );
            if (!allowed) { set.status = 403; return { error: "Forbidden", code: 403 }; }
          }
        }

        const { token, exp } = await signAuthToken({
          payload: { filename: params.filename },
          audience: "file",
          expiresInSeconds: tokenWindowSeconds("file"),
          jwtSecret,
        });
        return { data: { token, expires_at: exp } };
      }
    )
    .get("/api/files/:filename", async ({ params, query, request, set }) => {
      if (!isValidStorageFilename(params.filename)) {
        set.status = 400;
        return { error: "Invalid filename", code: 400 };
      }
      if (!(await fileExists(params.filename))) {
        set.status = 404;
        return { error: "File not found", code: 404 };
      }

      const meta = await fileMetaOf(params.filename);
      // Always evaluate the parent record's view_rule (C-3 fix). Token gate
      // remains for `protected` fields so off-app links (img/src in user mail
      // etc.) still work for legitimate holders.
      let allowed = false;
      if (meta) {
        const tok = query.token;
        if (tok && (await verifyFileToken(tok, params.filename, jwtSecret))) {
          allowed = true;
        } else {
          const auth = await getAuthContext(request, jwtSecret);
          allowed = await viewRuleAllows(meta.collection_id, meta.record_id, auth);
        }
      } else {
        // Orphan files (no row) — admin-only.
        const auth = await getAuthContext(request, jwtSecret);
        allowed = auth?.type === "admin";
      }
      if (!allowed) {
        // Check token gate as a last-resort path for protected legacy fields.
        if (await isFileProtected(params.filename)) {
          const tok = query.token;
          if (!tok || !(await verifyFileToken(tok, params.filename, jwtSecret))) {
            set.status = 401;
            return { error: "Token required", code: 401 };
          }
          allowed = true;
        }
      }
      if (!allowed) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }

      const inlineSafe = meta ? isSafeToRenderInline(meta.mime_type) : false;
      const baseHeaders: Record<string, string> = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      };
      if (!inlineSafe) {
        const safeName = (meta?.original_name ?? params.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        baseHeaders["Content-Disposition"] = `attachment; filename="${safeName}"`;
      }

      const spec = parseThumbSpec(query.thumb);
      if (!spec) {
        const r = await fileResponse(params.filename);
        if (!r) { set.status = 404; return { error: "File not found", code: 404 }; }
        // Layer headers on top of storage Response.
        for (const [k, v] of Object.entries(baseHeaders)) r.headers.set(k, v);
        return r;
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

      const buf = await readFile(params.filename);
      if (!buf) { set.status = 404; return { error: "File not found", code: 404 }; }
      const bytes = new Uint8Array(buf);
      const format = detectFormat(bytes);
      if (!format) {
        const r = await fileResponse(params.filename);
        if (!r) return new Response(null, { status: 404 });
        for (const [k, v] of Object.entries(baseHeaders)) r.headers.set(k, v);
        return r;
      }

      try {
        const thumb = await generateThumbnail(bytes, spec, format as ThumbFormat);
        await Bun.write(cachePath, thumb);
        const outFormat = detectFormat(thumb) ?? format;
        return new Response(thumb, {
          headers: { ...baseHeaders, "Content-Type": thumbMime(outFormat) },
        });
      } catch {
        const r = await fileResponse(params.filename);
        if (!r) return new Response(null, { status: 404 });
        for (const [k, v] of Object.entries(baseHeaders)) r.headers.set(k, v);
        return r;
      }
    }, {
      query: t.Object({
        thumb: t.Optional(t.String()),
        token: t.Optional(t.String()),
      }),
    })
    .delete("/api/files/:collection/:recordId/:field", async ({ params, request, set }) => {
      const auth = await getAuthContext(request, jwtSecret);
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
      for (const meta of rows) {
        await deleteFile(meta.filename);
        deleteThumbsFor(uploadDir, meta.filename);
        await db.delete(files).where(eq(files.id, meta.id));
      }
      return { data: { deleted: rows.length } };
    })
    .delete("/api/files/:collection/:recordId/:field/:filename", async ({ params, request, set }) => {
      const auth = await getAuthContext(request, jwtSecret);
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
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) {
        try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}
