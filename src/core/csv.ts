/**
 * Minimal RFC 4180 CSV parser + writer. Handles quoted fields, embedded
 * commas/newlines, and the doubled-quote escape ("" -> ").
 *
 * Pure JS — no external dep — so it bundles cleanly into the single binary.
 */

const CR = "\r";
const LF = "\n";
const QUOTE = '"';
const COMMA = ",";

/** Encode a single value as a CSV field. Quotes only when needed. */
export function encodeField(val: unknown): string {
  if (val === null || val === undefined) return "";
  let s: string;
  if (typeof val === "string") s = val;
  else if (typeof val === "number" || typeof val === "boolean") s = String(val);
  else s = JSON.stringify(val);
  if (s.includes(COMMA) || s.includes(QUOTE) || s.includes(CR) || s.includes(LF)) {
    return QUOTE + s.replace(/"/g, '""') + QUOTE;
  }
  return s;
}

/** Encode a row as a CSV line (no trailing newline). */
export function encodeRow(values: unknown[]): string {
  return values.map(encodeField).join(COMMA);
}

/** Encode an entire table — first arg is header columns, second is data rows in matching column order. */
export function encodeCsv(headers: string[], rows: unknown[][]): string {
  const lines = [encodeRow(headers)];
  for (const r of rows) lines.push(encodeRow(r));
  // Use \r\n per RFC 4180 — many spreadsheet tools strongly prefer it.
  return lines.join("\r\n");
}

/**
 * Parse a CSV string into an array of rows. Each row is an array of strings.
 * Empty trailing lines are skipped. Throws on unterminated quoted fields.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const n = input.length;

  while (i < n) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === QUOTE) {
        if (input[i + 1] === QUOTE) {
          // Escaped quote: emit one quote, skip both
          field += QUOTE;
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === QUOTE && field === "") {
        // Opening quote only valid at the start of a field
        inQuotes = true;
        i++;
      } else if (ch === COMMA) {
        row.push(field);
        field = "";
        i++;
      } else if (ch === CR || ch === LF) {
        row.push(field);
        field = "";
        // Skip CRLF as a single line break
        if (ch === CR && input[i + 1] === LF) i += 2;
        else i++;
        // Drop empty trailing rows that arise from a final newline
        if (row.length === 1 && row[0] === "") {
          row = [];
          continue;
        }
        rows.push(row);
        row = [];
      } else {
        field += ch;
        i++;
      }
    }
  }
  if (inQuotes) throw new Error("Unterminated quoted field");
  // Flush the final row if no trailing newline
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Convenience: parse and pivot to objects keyed by the header row. */
export function parseCsvToObjects(input: string): Record<string, string>[] {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const headers = rows[0]!;
  return rows.slice(1).map((r) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      out[headers[i]!] = r[i] ?? "";
    }
    return out;
  });
}
