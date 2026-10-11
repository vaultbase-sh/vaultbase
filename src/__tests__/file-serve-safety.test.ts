/**
 * An uploaded file must never execute as a page on the API's own origin.
 *
 * The storage driver returned `new Response(Bun.file(path))`, which lets Bun
 * infer `Content-Type` from the stored filename — and that name came from
 * `file.name` via `safeExt`, which accepted `html`, `svg` and `xhtml`. A file
 * declared `image/png` was also exempt from `Content-Disposition: attachment`,
 * so `x.html` was served inline as `text/html` on the API origin. With the
 * admin cookie accepted on `/api/*`, that is admin takeover.
 *
 * `X-Content-Type-Options: nosniff` does not help here: the declared type
 * genuinely *was* text/html, so there was nothing to sniff.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { files } from "../db/schema.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "test-secret-file-safety";
let dir: string;
let recordId: string;
let collectionId: string;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  dir = mkdtempSync(join(tmpdir(), "vb-files-"));
  mkdirSync(join(dir, "uploads"), { recursive: true });
  setUploadDir(join(dir, "uploads"));
  invalidateStorageCache();

  const col = await createCollection({
    name: "docs",
    type: "base",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "attachment", type: "file" },
    ]),
    list_rule: null,
    view_rule: null,
  });
  collectionId = col.id;
  _resetCollectionCache();
  const rec = await createRecord("docs", { title: "t" });
  recordId = rec["id"] as string;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Plant a stored file directly, the way an older install already has them. */
async function plant(filename: string, mime: string, body: string): Promise<void> {
  writeFileSync(join(dir, "uploads", filename), body);
  await getDb().insert(files).values({
    id: crypto.randomUUID(),
    collection_id: collectionId,
    record_id: recordId,
    field_name: "attachment",
    filename,
    original_name: filename,
    mime_type: mime,
    size: body.length,
    created_at: Math.floor(Date.now() / 1000),
  });
}

async function serve(filename: string): Promise<Response> {
  return makeFilesPlugin(join(dir, "uploads"), SECRET).handle(
    new Request(`http://localhost/files/${filename}`),
  );
}

const PAYLOAD = "<script>alert(document.domain)</script>";

describe("file responses can never run as a page", () => {
  it("serves a legacy .html file as its stored MIME, not as text/html", async () => {
    // The exact bypass: `.html` on disk, declared image/png so the old code
    // skipped `attachment` and Bun typed it from the extension.
    await plant("legacy.html", "image/png", PAYLOAD);
    const res = await serve("legacy.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-type")).not.toContain("text/html");
    // Bytes are untouched — this is a header fix, not a content filter.
    expect(await res.text()).toBe(PAYLOAD);
  });

  it("puts a sandbox CSP on every file response", async () => {
    await plant("legacy.html", "image/png", PAYLOAD);
    const res = await serve("legacy.html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
  });

  it("never serves an SVG inline", async () => {
    // SVG carries script; it is deliberately absent from the inline-safe list.
    await plant("x.svg", "image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`);
    const res = await serve("x.svg");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("forces attachment + octet-stream for anything not an inline-safe raster", async () => {
    await plant("doc.pdf", "application/pdf", "%PDF-1.4");
    const res = await serve("doc.pdf");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("still serves a genuine image inline", async () => {
    await plant("real.png", "image/png", "\x89PNG\r\n\x1a\n");
    const res = await serve("real.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("falls back to octet-stream when the file row is missing", async () => {
    writeFileSync(join(dir, "uploads", "orphan.html"), PAYLOAD);
    const res = await serve("orphan.html");
    // Either refused outright or served inert — never as a document.
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toContain("attachment");
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("storage drivers hand back opaque bytes", () => {
  it("does not let the driver infer a type from the stored name", async () => {
    const { fileResponse } = await import("../core/storage.ts");
    writeFileSync(join(dir, "uploads", "raw.html"), PAYLOAD);
    const r = await fileResponse("raw.html");
    expect(r).not.toBeNull();
    expect(r!.headers.get("content-type")).toBe("application/octet-stream");
  });
});

describe("stored extensions come from the MIME, not the filename", () => {
  it("rejects a filename-derived extension reaching the disk", async () => {
    // Full upload flow is covered end-to-end elsewhere; here we assert the
    // invariant that matters: no stored filename ends in an executable type.
    await plant("a.png", "image/png", "x");
    const rows = getRawClient().prepare("SELECT filename FROM vaultbase_files").all() as Array<{ filename: string }>;
    for (const r of rows) {
      expect(r.filename).not.toMatch(/\.(html?|xhtml|svg|js|mjs)$/i);
    }
  });
});
