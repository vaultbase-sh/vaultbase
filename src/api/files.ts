import { and, eq } from "drizzle-orm";
import Elysia from "elysia";
import { unlinkSync } from "fs";
import { join } from "path";
import { getDb } from "../db/client.ts";
import { files } from "../db/schema.ts";

export function makeFilesPlugin(uploadDir: string) {
  return new Elysia({ name: "files" })
    .post("/api/files/:collection/:recordId/:field", async ({ params, request, set }) => {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        set.status = 400;
        return { error: "No file uploaded", code: 400 };
      }
      const ext = file.name.split(".").pop() ?? "bin";
      const id = crypto.randomUUID();
      const filename = `${id}.${ext}`;
      const dest = join(uploadDir, filename);
      await Bun.write(dest, file);

      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await db.insert(files).values({
        id,
        collection_id: params.collection,
        record_id: params.recordId,
        field_name: params.field,
        filename,
        original_name: file.name,
        mime_type: file.type || "application/octet-stream",
        size: file.size,
        created_at: now,
      });

      return { data: { id, filename, originalName: file.name, size: file.size } };
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
      const db = getDb();
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.collection_id, params.collection),
            eq(files.record_id, params.recordId),
            eq(files.field_name, params.field)
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
