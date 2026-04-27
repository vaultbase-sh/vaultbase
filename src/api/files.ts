import { and, eq } from "drizzle-orm";
import Elysia from "elysia";
import { unlinkSync } from "fs";
import { join } from "path";
import { getDb } from "../db/client.ts";
import { files } from "../db/schema.ts";
import { getCollection, parseFields } from "../core/collections.ts";

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

export function makeFilesPlugin(uploadDir: string) {
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
    .get("/api/files/:filename", async ({ params, set }) => {
      const dest = join(uploadDir, params.filename);
      const f = Bun.file(dest);
      if (!(await f.exists())) {
        set.status = 404;
        return { error: "File not found", code: 404 };
      }
      return new Response(f);
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
      await db.delete(files).where(eq(files.id, meta.id));
      return { data: null };
    });
}
