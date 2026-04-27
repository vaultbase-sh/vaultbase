import { and, eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { files } from "../db/schema.ts";
import { getCollection, parseFields } from "../core/collections.ts";
import {
  detectFormat,
  generateThumbnail,
  parseThumbSpec,
  thumbCachePath,
  type ThumbFormat,
} from "../core/image.ts";

const FILE_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  try {
    await jose.jwtVerify(token, new TextEncoder().encode(jwtSecret), { audience: "admin" });
    return true;
  } catch {
    return false;
  }
}

/** Returns true if `filename` belongs to a file field marked `protected: true`. */
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

async function verifyFileToken(token: string, filename: string, jwtSecret: string): Promise<boolean> {
  try {
    const { payload } = await jose.jwtVerify(
      token,
      new TextEncoder().encode(jwtSecret),
      { audience: "file" }
    );
    return payload["filename"] === filename;
  } catch {
    return false;
  }
}

function mimeAllowed(mime: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  for (const p of patterns) {
    if (p === mime) return true;
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1); // "image/"
      if (mime.startsWith(prefix)) return true;
    }
  }
  return false;
}

export function makeFilesPlugin(uploadDir: string, jwtSecret: string) {
  return new Elysia({ name: "files" })
    .post("/api/files/:collection/:recordId/:field", async ({ params, request, set }) => {
      const formData = await request.formData();
      const fileEntries = (formData.getAll("file") as unknown[]).filter((v): v is File => v instanceof File);
      if (fileEntries.length === 0) {
        set.status = 400;
        return { error: "No file uploaded", code: 400 };
      }

      // Look up collection schema and validate against field options
      const col = await getCollection(params.collection);
      if (!col) {
        set.status = 404;
        return { error: `Collection '${params.collection}' not found`, code: 404 };
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

      // Validate every file before writing any
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
        if (!mimeAllowed(fm, mimeTypes)) {
          set.status = 422;
          return {
            error: `MIME type '${fm}' not allowed`,
            code: 422,
            details: { [params.field]: `Allowed: ${mimeTypes.join(", ")}` },
          };
        }
      }

      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const uploaded: Array<{ id: string; filename: string; originalName: string; size: number; mimeType: string }> = [];
      for (const file of fileEntries) {
        const ext = file.name.split(".").pop() ?? "bin";
        const id = crypto.randomUUID();
        const filename = `${id}.${ext}`;
        const dest = join(uploadDir, filename);
        await Bun.write(dest, file);
        const fileMime = file.type || "application/octet-stream";
        await db.insert(files).values({
          id,
          collection_id: col.id,
          record_id: params.recordId,
          field_name: params.field,
          filename,
          original_name: file.name,
          mime_type: fileMime,
          size: file.size,
          created_at: now,
        });
        uploaded.push({ id, filename, originalName: file.name, size: file.size, mimeType: fileMime });
      }

      // Single-file: return the lone object for backwards compat
      if (!multiple) return { data: uploaded[0] };
      return { data: uploaded };
    })
    // Issue a 1-hour bearer token for a protected file. Admin-only — apps that
    // need user-scoped sharing can build on top using the underlying record rules.
    .post(
      "/api/files/:collection/:recordId/:field/:filename/token",
      async ({ params, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        const exp = Math.floor(Date.now() / 1000) + FILE_TOKEN_TTL_SECONDS;
        const token = await new jose.SignJWT({ filename: params.filename })
          .setProtectedHeader({ alg: "HS256" })
          .setAudience("file")
          .setExpirationTime(exp)
          .sign(new TextEncoder().encode(jwtSecret));
        return { data: { token, expires_at: exp } };
      }
    )
    .get("/api/files/:filename", async ({ params, query, set }) => {
      const dest = join(uploadDir, params.filename);
      const f = Bun.file(dest);
      if (!(await f.exists())) {
        set.status = 404;
        return { error: "File not found", code: 404 };
      }

      // Enforce token gate when the field is protected.
      if (await isFileProtected(params.filename)) {
        const tok = query.token;
        if (!tok || !(await verifyFileToken(tok, params.filename, jwtSecret))) {
          set.status = 401;
          return { error: "Token required", code: 401 };
        }
      }

      const spec = parseThumbSpec(query.thumb);
      if (!spec) return new Response(f);

      // Cache hit?
      const cachePath = thumbCachePath(uploadDir, params.filename, spec);
      const cached = Bun.file(cachePath);
      if (await cached.exists()) return new Response(cached);

      // Read original, sniff format. Fall back to original if not an image.
      const buf = new Uint8Array(await f.arrayBuffer());
      const format = detectFormat(buf);
      if (!format) return new Response(f);

      try {
        const thumb = await generateThumbnail(buf, spec, format as ThumbFormat);
        await Bun.write(cachePath, thumb);
        return new Response(thumb, {
          headers: {
            "Content-Type": format === "jpeg" ? "image/jpeg" : "image/png",
          },
        });
      } catch {
        // Decoder failure — give the caller the original rather than 500ing.
        return new Response(f);
      }
    }, {
      query: t.Object({
        thumb: t.Optional(t.String()),
        token: t.Optional(t.String()),
      }),
    })
    .delete("/api/files/:collection/:recordId/:field", async ({ params, set }) => {
      const col = await getCollection(params.collection);
      const collId = col?.id ?? params.collection;
      const db = getDb();
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.collection_id, collId),
            eq(files.record_id, params.recordId),
            eq(files.field_name, params.field)
          )
        );
      if (rows.length === 0) { set.status = 404; return { error: "File not found", code: 404 }; }
      for (const meta of rows) {
        const dest = join(uploadDir, meta.filename);
        try { unlinkSync(dest); } catch { /* already deleted */ }
        deleteThumbsFor(uploadDir, meta.filename);
        await db.delete(files).where(eq(files.id, meta.id));
      }
      return { data: { deleted: rows.length } };
    })
    // Delete a specific file by filename (used for multi-file fields)
    .delete("/api/files/:collection/:recordId/:field/:filename", async ({ params, set }) => {
      const col = await getCollection(params.collection);
      const collId = col?.id ?? params.collection;
      const db = getDb();
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.collection_id, collId),
            eq(files.record_id, params.recordId),
            eq(files.field_name, params.field),
            eq(files.filename, params.filename)
          )
        )
        .limit(1);
      const meta = rows[0];
      if (!meta) { set.status = 404; return { error: "File not found", code: 404 }; }
      const dest = join(uploadDir, meta.filename);
      try { unlinkSync(dest); } catch { /* already deleted */ }
      deleteThumbsFor(uploadDir, meta.filename);
      await db.delete(files).where(eq(files.id, meta.id));
      return { data: null };
    });
}

/** Remove every cached thumbnail derived from a given source filename. */
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
