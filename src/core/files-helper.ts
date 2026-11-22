/**
 * `helpers.files`: store a file on a record's file field from server code
 * (hooks, custom routes, cron jobs, queue workers) without the multipart
 * upload route. It checks the same limits as an upload (the server's type
 * allow-list, the max upload size, the field's maxSize and mimeTypes),
 * writes through the configured storage driver (local or S3), adds the
 * `vaultbase_files` row, and then sets the field through the records path
 * (helpers.records), so validation, hooks, record history, realtime and
 * webhooks all run. A multi-file field gets the file appended; a single-file
 * field has it replaced (the old file goes with the hourly cleanup).
 *
 * Trusted server code, like helpers.records: no API rules apply.
 */
import { nested } from "./records-helper.ts";
import { ValidationError } from "./validate.ts";

export interface SavedFile {
  id: string;
  /** The stored name: what the record's field holds. */
  filename: string;
  originalName: string;
  size: number;
  mimeType: string;
}

export interface SaveFileOpts {
  /** The file's name (kept as its original name). Default "file". */
  name?: string;
  /** Its media type. Default: the Blob's type, else one from `name`'s extension, else application/octet-stream. */
  type?: string;
}

export interface FilesHelper {
  /** Store `data` and attach it to the record's file field. */
  save(
    collection: string,
    recordId: string,
    field: string,
    data: Uint8Array | ArrayBuffer | Blob | string,
    opts?: SaveFileOpts,
  ): Promise<{ file: SavedFile; record: Record<string, unknown> }>;
}

/** Tries of the read-append-write of a multi-file field when another write lands in between. */
const MAX_APPEND_TRIES = 25;

async function bytesOf(data: Uint8Array | ArrayBuffer | Blob | string): Promise<{ bytes: Uint8Array; blobType: string }> {
  if (typeof data === "string") return { bytes: new TextEncoder().encode(data), blobType: "" };
  if (data instanceof Uint8Array) return { bytes: data, blobType: "" };
  if (data instanceof ArrayBuffer) return { bytes: new Uint8Array(data), blobType: "" };
  if (typeof Blob !== "undefined" && data instanceof Blob) return { bytes: new Uint8Array(await data.arrayBuffer()), blobType: data.type };
  throw new Error("helpers.files.save: data must be a Uint8Array, ArrayBuffer, Blob or string");
}

export function makeFilesHelper(): FilesHelper {
  return {
    save: (collection, recordId, field, data, opts = {}) => nested("files.save", async () => {
      const [{ getCollection, parseFields }, records, filesApi, sec, storage, extra, dbc, schema, orm] = await Promise.all([
        import("./collections.ts"),
        import("./records.ts"),
        import("../api/files.ts"),
        import("./sec.ts"),
        import("./storage.ts"),
        import("./hook-helpers-extra.ts"),
        import("../db/client.ts"),
        import("../db/schema.ts"),
        import("drizzle-orm"),
      ]);

      const col = await getCollection(collection);
      if (!col) throw new Error(`helpers.files.save: collection '${collection}' not found`);
      const fieldDef = parseFields(col.fields).find((f) => f.name === field);
      if (!fieldDef) throw new Error(`helpers.files.save: field '${field}' not found on '${col.name}'`);
      if (fieldDef.type !== "file") throw new Error(`helpers.files.save: field '${field}' is not a file field`);
      if (!(await records.getRecord(col.name, recordId))) throw new Error(`helpers.files.save: record '${recordId}' not found in '${col.name}'`);

      const { bytes, blobType } = await bytesOf(data);
      const originalName = (opts.name ?? "file").slice(0, 255);
      const dot = originalName.lastIndexOf(".");
      const fromName = dot >= 0 ? extra.MIME_BY_EXT[originalName.slice(dot).toLowerCase()] : undefined;
      const mimeType = filesApi.baseMime(opts.type || blobType || fromName || "application/octet-stream");

      // The checks the upload route makes, with the same messages.
      const cap = filesApi.maxUploadBytes();
      if (bytes.byteLength > cap) throw new ValidationError({ [field]: `Upload too large (max ${cap} bytes)` });
      const o = fieldDef.options ?? {};
      const maxSize = typeof o["maxSize"] === "number" ? o["maxSize"] : 0;
      if (maxSize > 0 && bytes.byteLength > maxSize) throw new ValidationError({ [field]: `Max ${maxSize} bytes` });
      if (!sec.isAllowedUploadMime(mimeType)) throw new ValidationError({ [field]: `MIME type '${mimeType}' not allowed` });
      const mimeTypes = Array.isArray(o["mimeTypes"]) ? (o["mimeTypes"] as string[]) : [];
      if (!filesApi.mimeAllowed(mimeType, mimeTypes)) throw new ValidationError({ [field]: `Allowed: ${mimeTypes.join(", ")}` });

      const id = crypto.randomUUID();
      const filename = `${id}.${filesApi.storageExt(mimeType)}`;
      const db = dbc.getDb();
      await storage.writeFile(filename, bytes, mimeType);
      try {
        await db.insert(schema.files).values({
          id,
          collection_id: col.id,
          record_id: recordId,
          field_name: field,
          filename,
          original_name: originalName,
          mime_type: mimeType,
          size: bytes.byteLength,
          created_at: Math.floor(Date.now() / 1000),
        });

        const multiple = o["multiple"] === true;
        let record: Record<string, unknown> | null = null;
        for (let attempt = 1; !record; attempt++) {
          const current = await records.getRecord(col.name, recordId);
          if (!current) throw new Error(`helpers.files.save: record '${recordId}' was deleted`);
          const value = (current as Record<string, unknown>)[field];
          const next = multiple ? [...(Array.isArray(value) ? value : []), filename] : filename;
          try {
            // Pinned to the version just read, so a file another write added
            // to a multi-file field in between isn't dropped: read again.
            record = await records.updateRecord(col.name, recordId, { [field]: next }, null,
              { ifUnchanged: current as unknown as Record<string, unknown> }) as unknown as Record<string, unknown>;
          } catch (e) {
            if (!(e instanceof records.PreconditionFailedError) || attempt >= MAX_APPEND_TRIES) throw e;
          }
        }
        return { file: { id, filename, originalName, size: bytes.byteLength, mimeType }, record };
      } catch (e) {
        // Nothing names the file: take it away now instead of leaving it to the sweep.
        await db.delete(schema.files).where(orm.eq(schema.files.id, id)).catch(() => {});
        await storage.deleteFile(filename).catch(() => {});
        throw e;
      }
    }),
  };
}
