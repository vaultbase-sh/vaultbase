import Elysia from "elysia";
import * as jose from "jose";
import { encodeCsv, parseCsvToObjects } from "../core/csv.ts";
import { getCollection, parseFields } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
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

export function makeCsvPlugin(jwtSecret: string) {
  return new Elysia({ name: "csv" })
    // Export all rows of a base collection as CSV.
    .get("/api/admin/export/:collection", async ({ params, request, set }) => {
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

      const fields = parseFields(col.fields).filter(
        (f) => !f.system && !f.implicit && f.type !== "autodate" && f.type !== "password"
      );
      const headers = ["id", "created", "updated", ...fields.map((f) => f.name)];

      // Stream-friendly: page through results to handle large collections.
      const PAGE = 500;
      const rows: unknown[][] = [];
      let page = 1;
      while (true) {
        const result = await listRecords(col.name, { page, perPage: PAGE });
        for (const r of result.data) {
          rows.push([
            r.id,
            r.created,
            r.updated,
            ...fields.map((f) => {
              const v = (r as unknown as Record<string, unknown>)[f.name];
              if (v === null || v === undefined) return "";
              if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
                return JSON.stringify(v);
              }
              return v;
            }),
          ]);
        }
        if (result.totalItems <= page * PAGE) break;
        page++;
      }

      const body = encodeCsv(headers, rows);
      set.headers["Content-Type"] = "text/csv; charset=utf-8";
      set.headers["Content-Disposition"] = `attachment; filename="${col.name}.csv"`;
      return body;
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
