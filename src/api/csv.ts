import Elysia from "elysia";
import * as jose from "jose";
import { encodeRow, parseCsvToObjects } from "../core/csv.ts";
import { getCollection, parseFields, type FieldDef } from "../core/collections.ts";
import { createRecord, listRecords, type RecordWithMeta } from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";

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

/**
 * Coerce a CSV cell back to the right JS type for createRecord. Empty strings
 * become null for everything except text-like fields where empty is meaningful.
 */
function decodeCell(raw: string, type: string): unknown {
  if (raw === "") {
    if (type === "text" || type === "editor" || type === "email" || type === "url" || type === "password") {
      return raw; // keep empty strings
    }
    return null;
  }
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === "bool") {
    return raw === "true" || raw === "1";
  }
  if (type === "json" || type === "geoPoint") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (type === "select") {
    // Multi-select serialized as JSON array; single-select serialized as scalar string.
    if (raw.startsWith("[")) {
      try { return JSON.parse(raw); } catch { return raw; }
    }
    return raw;
  }
  if (type === "file") {
    // File field: serialized either as a single filename or a JSON array.
    if (raw.startsWith("[")) {
      try { return JSON.parse(raw); } catch { return raw; }
    }
    return raw;
  }
  if (type === "date" || type === "autodate") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    return raw; // ISO strings are accepted by encodeValue
  }
  return raw;
}

/**
 * Subset of FieldDef that only requires `name` and `type` — the export pipeline
 * doesn't need (or want) the rest. Kept narrow so callers can pass either the
 * full FieldDef[] or a hand-rolled shape from tests.
 */
export interface CsvColumn {
  name: string;
  type?: string;
}

/**
 * Filter a collection's parsed fields down to the columns the CSV export
 * surfaces. System / implicit / autodate / password fields are stripped; the
 * remaining fields keep their original schema order.
 *
 * Single source of truth so the streaming and (test-only) buffered code paths
 * agree on column derivation.
 */
export function exportColumnsForFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter(
    (f) => !f.system && !f.implicit && f.type !== "autodate" && f.type !== "password"
  );
}

/** Header row layout: id, created, updated, then the user-defined columns. */
export function exportHeaderRow(columns: CsvColumn[]): string[] {
  return ["id", "created", "updated", ...columns.map((c) => c.name)];
}

/**
 * Format a batch of records into 2D row-array form ready for CSV encoding.
 * Object/array fields are JSON-stringified; null/undefined become "".
 *
 * Exported so the streaming export and any in-memory caller share identical
 * row-formatting semantics — guarantees byte-for-byte equivalence with the
 * pre-streaming implementation.
 */
export function formatRowsForCsv(records: RecordWithMeta[], columns: CsvColumn[]): unknown[][] {
  const out: unknown[][] = [];
  for (const r of records) {
    const row: unknown[] = [r.id, r.created, r.updated];
    for (const col of columns) {
      const v = (r as unknown as Record<string, unknown>)[col.name];
      if (v === null || v === undefined) {
        row.push("");
      } else if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
        row.push(JSON.stringify(v));
      } else {
        row.push(v);
      }
    }
    out.push(row);
  }
  return out;
}

export function makeCsvPlugin(jwtSecret: string) {
  return new Elysia({ name: "csv" })
    // Export all rows of a base collection as CSV — streamed.
    //
    // Why streaming: at ~100k rows the buffered version (encodeCsv on the full
    // row matrix) blows out memory. Here we page through `listRecords` and
    // enqueue each page's CSV bytes as we go, so the response size is bounded
    // by the page size, not the table size.
    //
    // Output is byte-identical to the previous buffered implementation:
    //   header CRLF row1 CRLF row2 ... CRLF rowN     (no trailing CRLF)
    .get("/api/admin/export/:collection", async ({ params, request, set }) => {
      // Atomic auth/rule check — runs synchronously before we hand back a Response
      // so unauthorized callers get a plain JSON error, never a stream.
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "base") {
        set.status = 422;
        return { error: `Export only supported on base collections (got ${col.type})`, code: 422 };
      }

      const fields = exportColumnsForFields(parseFields(col.fields));
      const headerCols = exportHeaderRow(fields);

      const PAGE = 500;
      const encoder = new TextEncoder();
      let cancelled = false;
      let page = 1;
      // Pre-fetched next page kept in flight so we can `enqueue` the previous
      // batch and `await` the next one without serialising network/db latency
      // and CSV formatting time.
      let nextBatch: Promise<Awaited<ReturnType<typeof listRecords>>> | null = null;

      const fetchPage = (p: number) => listRecords(col.name, { page: p, perPage: PAGE });

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Header first — never delayed by a query. Writing it from start()
          // means clients see the column row immediately, even on slow tables.
          controller.enqueue(encoder.encode(encodeRow(headerCols)));
          nextBatch = fetchPage(page);
        },
        async pull(controller) {
          if (cancelled || !nextBatch) {
            controller.close();
            return;
          }
          let result;
          try {
            result = await nextBatch;
          } catch (err) {
            controller.error(err);
            return;
          }
          if (cancelled) return; // client disconnected while we awaited

          // Determine if this is the last page BEFORE enqueueing, so we can
          // stop the next-page fetch from kicking off needlessly.
          const isLast = result.totalItems <= page * PAGE;
          if (!isLast) {
            page++;
            nextBatch = fetchPage(page);
          } else {
            nextBatch = null;
          }

          const rows = formatRowsForCsv(result.data, fields);
          for (const row of rows) {
            // Each row is prefixed with CRLF so the final byte is always the
            // last row's last character — matching encodeCsv()'s no-trailing-
            // newline contract.
            controller.enqueue(encoder.encode("\r\n" + encodeRow(row)));
          }

          if (isLast) controller.close();
        },
        cancel() {
          // Client disconnected mid-stream: stop paging. Any in-flight
          // listRecords promise still resolves (it's a sync sqlite query
          // wrapped in async), but the cancelled flag makes pull() bail
          // before issuing further queries or enqueues.
          cancelled = true;
          nextBatch = null;
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${col.name}.csv"`,
        },
      });
    })

    // Import CSV rows into a base collection.
    .post("/api/admin/import/:collection", async ({ params, request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "base") {
        set.status = 422;
        return { error: `Import only supported on base collections (got ${col.type})`, code: 422 };
      }

      const text = await request.text();
      if (!text.trim()) {
        set.status = 422;
        return { error: "Empty CSV body", code: 422 };
      }

      let parsed: Record<string, string>[];
      try {
        parsed = parseCsvToObjects(text);
      } catch (e) {
        set.status = 422;
        return { error: e instanceof Error ? e.message : "CSV parse failed", code: 422 };
      }

      const fields = parseFields(col.fields);
      const fieldByName = new Map(fields.filter((f) => !f.system).map((f) => [f.name, f]));

      const errors: Array<{ row: number; details: Record<string, string> | string }> = [];
      let created = 0;

      for (let i = 0; i < parsed.length; i++) {
        const csvRow = parsed[i]!;
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(csvRow)) {
          // Skip system/meta columns; the records API generates them.
          if (k === "id" || k === "created" || k === "updated") continue;
          const def = fieldByName.get(k);
          if (!def) continue; // ignore unknown columns
          data[k] = decodeCell(v, def.type);
        }
        try {
          await createRecord(col.name, data, null);
          created++;
        } catch (e) {
          if (e instanceof ValidationError) {
            errors.push({ row: i + 2, details: e.details }); // +2: header is row 1, body starts at row 2
          } else {
            errors.push({ row: i + 2, details: e instanceof Error ? e.message : String(e) });
          }
        }
      }

      return {
        data: {
          created,
          failed: errors.length,
          total: parsed.length,
          errors: errors.slice(0, 50), // cap to keep response reasonable
        },
      };
    });
}
