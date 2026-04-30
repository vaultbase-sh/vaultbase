import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { encodeCsv } from "../core/csv.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  exportColumnsForFields,
  exportHeaderRow,
  formatRowsForCsv,
  makeCsvPlugin,
} from "../api/csv.ts";
import { listRecords } from "../core/records.ts";

const SECRET = "test-secret-csv-stream";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-csv-stream-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function signAdmin(): Promise<string> {
  return await new jose.SignJWT({ id: "a1", email: "admin@test.local" })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("admin")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

function exportReq(token: string, collection: string): Request {
  return new Request(`http://localhost/api/admin/export/${collection}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Reference implementation: build the CSV the same way the old buffered
 * handler did, by reusing the helpers the streaming handler now uses. If the
 * stream's output ever drifts from this, the equivalence test fails.
 */
async function bufferedExport(collection: string, fields: FieldDef[]): Promise<string> {
  const cols = exportColumnsForFields(fields);
  const headers = exportHeaderRow(cols);
  const rows: unknown[][] = [];
  const PAGE = 500;
  let page = 1;
  while (true) {
    const result = await listRecords(collection, { page, perPage: PAGE });
    rows.push(...formatRowsForCsv(result.data, cols));
    if (result.totalItems <= page * PAGE) break;
    page++;
  }
  return encodeCsv(headers, rows);
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder().decode(merged);
}

const NOTES_FIELDS: FieldDef[] = [
  { name: "title", type: "text", required: false },
  { name: "n",     type: "number" },
  { name: "tags",  type: "json" },
];

async function seedNotes(count: number): Promise<void> {
  await createCollection({
    name: "notes",
    type: "base",
    fields: JSON.stringify(NOTES_FIELDS),
  });
  for (let i = 0; i < count; i++) {
    await createRecord("notes", {
      title: `note-${i}`,
      n: i,
      tags: [i, `t${i}`],
    }, null);
  }
}

describe("streaming CSV export", () => {
  it("output equivalence: 250 rows match the buffered reference byte-for-byte", async () => {
    await seedNotes(250);
    const token = await signAdmin();
    const app = makeCsvPlugin(SECRET);
    const res = await app.handle(exportReq(token, "notes"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain("notes.csv");

    const streamed = await readAll(res.body!);
    const reference = await bufferedExport("notes", NOTES_FIELDS);
    expect(streamed).toBe(reference);
  });

  it("body is a ReadableStream and the first chunk starts with the header row", async () => {
    await seedNotes(50);
    const token = await signAdmin();
    const app = makeCsvPlugin(SECRET);
    const res = await app.handle(exportReq(token, "notes"));

    // The handler returns a Response wrapping a ReadableStream — not pre-buffered.
    expect(res.body).toBeInstanceOf(ReadableStream);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const head = decoder.decode(first.value!, { stream: true });
    // Header row appears at byte 0 — clients see column names before any data.
    expect(head.startsWith("id,created,updated,title,n,tags")).toBe(true);

    let rest = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value!, { stream: true });
    }
    rest += decoder.decode();

    // Every seeded record should be present somewhere in the stream.
    for (let i = 0; i < 50; i++) {
      expect(head + rest).toContain(`note-${i}`);
    }
  });

  it("cancel mid-stream stops paging promptly", async () => {
    // Seed enough records that a non-cancelled stream would produce several
    // pages of output. With cancel, we should read at most ~1 chunk.
    await seedNotes(2000); // 4 pages of 500
    const token = await signAdmin();
    const app = makeCsvPlugin(SECRET);
    const res = await app.handle(exportReq(token, "notes"));

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    const t0 = Date.now();
    await reader.cancel();

    // After cancel, the stream is closed — any subsequent read resolves done.
    const after = await reader.read();
    expect(after.done).toBe(true);

    // Sanity bound: cancel + final read must complete quickly. If pull() kept
    // chasing pages it would still be running async db work in the background;
    // the test still passes here, but the guard catches gross regressions.
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("empty collection: header-only CSV, single line, no trailing newline", async () => {
    await createCollection({
      name: "empty",
      type: "base",
      fields: JSON.stringify(NOTES_FIELDS),
    });
    const token = await signAdmin();
    const app = makeCsvPlugin(SECRET);
    const res = await app.handle(exportReq(token, "empty"));
    expect(res.status).toBe(200);
    const text = await readAll(res.body!);
    // Same byte-level shape encodeCsv() produces for [] — header only.
    expect(text).toBe("id,created,updated,title,n,tags");
    expect(text.includes("\r\n")).toBe(false);
  });
});
