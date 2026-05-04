/**
 * Rule-based file protection — per-field viewRule + requireAuth +
 * oneTimeToken + bindTokenIp + auditDownloads.
 *
 * Covers the behaviours documented in concepts/files.md under "Rule-based
 * file protection" — paired-rule AND combination, IP binding, single-use,
 * inheritance, and audit emission.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { createCollection, type FieldDef, type FieldOptions } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { auditLog, files } from "../db/schema.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { eq } from "drizzle-orm";

const SECRET = "test-secret-file-rules";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-file-rules-"));
  setLogsDir(tmpDir);
  setUploadDir(tmpDir);
  invalidateStorageCache();
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function signUser(id: string, email: string): Promise<string> {
  const { seedAuthUser, signUserJwt } = await import("./_helpers.ts");
  // Idempotent — duplicate seed swallowed.
  try { await seedAuthUser({ collection: "users", id, email }); } catch { /* dup */ }
  return signUserJwt(id, email, "users", SECRET);
}

async function signAdmin(id: string): Promise<string> {
  const { admin } = await import("../db/schema.ts");
  const now = Math.floor(Date.now() / 1000);
  try {
    await getDb().insert(admin).values({
      id, email: "admin@test.local", password_hash: "x",
      password_reset_at: 0, created_at: now,
    });
  } catch { /* dup */ }
  return await new jose.SignJWT({ id, email: "admin@test.local" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("admin")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
}

interface SetupOpts {
  collectionViewRule: string | null;
  fieldOptions: FieldOptions;
  owner: string;
  /** Optional record-level fields (e.g. tier) to write into the record. */
  extra?: Record<string, unknown>;
}

async function setupFile(opts: SetupOpts) {
  const fields: FieldDef[] = [
    { name: "title", type: "text", required: false },
    { name: "owner", type: "text", required: false },
    { name: "tier", type: "text", required: false },
    { name: "attachment", type: "file", options: opts.fieldOptions },
  ];
  const col = await createCollection({
    name: "notes",
    type: "base",
    fields: JSON.stringify(fields),
    view_rule: opts.collectionViewRule,
  });
  const rec = await createRecord(
    "notes",
    { title: "hi", owner: opts.owner, ...(opts.extra ?? {}) },
    null,
  );

  const filename = `${crypto.randomUUID()}.bin`;
  // Write actual bytes so fileExists/fileResponse don't 404 the GET path.
  writeFileSync(join(tmpDir, filename), "secret\n");
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(files).values({
    id: crypto.randomUUID(),
    collection_id: col.id,
    record_id: rec.id,
    field_name: "attachment",
    filename,
    original_name: "secret.bin",
    mime_type: "application/octet-stream",
    size: 7,
    created_at: now,
  });
  return { col, rec, filename };
}

function tokenReq(token: string | null, recId: string, filename: string, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return new Request(
    `http://localhost/files/notes/${recId}/attachment/${filename}/token`,
    { method: "POST", headers: h },
  );
}

function getReq(filename: string, query: Record<string, string> = {}, token: string | null = null, headers: Record<string, string> = {}): Request {
  const qs = new URLSearchParams(query).toString();
  const url = `http://localhost/files/${filename}${qs ? `?${qs}` : ""}`;
  const h: Record<string, string> = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return new Request(url, { method: "GET", headers: h });
}

// ── Per-field viewRule ──────────────────────────────────────────────────────

describe("file viewRule — per-field rule", () => {
  it("inherits collection rule when undefined (default)", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,           // public
      fieldOptions: {},                    // no field rule
      owner: "u1",
    });
    const app = makeFilesPlugin(tmpDir, SECRET);
    // Public collection + no field rule → anon mint OK.
    const res = await app.handle(tokenReq(null, rec.id, filename));
    expect(res.status).toBe(200);
  });

  it("denies token mint when field rule fails even though collection rule passes", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,                                     // public collection
      fieldOptions: { viewRule: "owner = @request.auth.id" },       // owner-only at field
      owner: "u-other",
    });
    const userToken = await signUser("u1", "u1@test.local");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(userToken, rec.id, filename));
    expect(res.status).toBe(403);
  });

  it("denies download when field rule fails (rule path, no token)", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: { viewRule: "owner = @request.auth.id" },
      owner: "u-other",
    });
    void rec;
    const userToken = await signUser("u1", "u1@test.local");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(getReq(filename, {}, userToken));
    expect(res.status).toBe(403);
  });

  it("admin bypasses field rule", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: "",                                       // admin-only collection
      fieldOptions: { viewRule: "owner = 'never-matches'" },        // also strict at field
      owner: "u-other",
    });
    const adminToken = await signAdmin("a1");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(adminToken, rec.id, filename));
    expect(res.status).toBe(200);
  });

  it("field rule \"\" forces admin-only even when collection is public", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: { viewRule: "" },
      owner: "u1",
    });
    const userToken = await signUser("u1", "u1@test.local");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(userToken, rec.id, filename));
    expect(res.status).toBe(403);
  });
});

// ── requireAuth ─────────────────────────────────────────────────────────────

describe("file requireAuth", () => {
  it("blocks anonymous fetch even on a public collection", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: { requireAuth: true },
      owner: "u1",
    });
    void rec;
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(getReq(filename));
    expect(res.status).toBe(403);
  });

  it("allows an authenticated user on the same public collection", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: { requireAuth: true },
      owner: "u1",
    });
    void rec;
    const userToken = await signUser("u1", "u1@test.local");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(getReq(filename, {}, userToken));
    expect(res.status).toBe(200);
  });
});

// ── One-time token ──────────────────────────────────────────────────────────

describe("file oneTimeToken", () => {
  it("first fetch succeeds, second fetch returns 410", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: { oneTimeToken: true },
      owner: "u1",
    });
    const app = makeFilesPlugin(tmpDir, SECRET);
    const mint = await app.handle(tokenReq(null, rec.id, filename));
    const body = await mint.json() as { data: { token: string } };
    const tok = body.data.token;

    const a = await app.handle(getReq(filename, { token: tok }));
    expect(a.status).toBe(200);

    const b = await app.handle(getReq(filename, { token: tok }));
    expect(b.status).toBe(410);
  });
});

// ── IP-bound token ──────────────────────────────────────────────────────────

describe("file bindTokenIp", () => {
  // Bun.serve's `requestIP` is unavailable when running through `app.handle`,
  // so the client IP we get back is `"unknown"`. This actually verifies the
  // behaviour we want: same-string match passes, different-string fails.

  it("token bound to IP A is rejected when IP claim diverges", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: { bindTokenIp: true },
      owner: "u1",
    });
    const app = makeFilesPlugin(tmpDir, SECRET);

    // Mint a token. The current client IP is "unknown" (no peer plumbing in
    // tests). Then forge a JWT with a *different* ip claim and confirm it's
    // rejected — this proves the comparison runs.
    const mint = await app.handle(tokenReq(null, rec.id, filename));
    expect(mint.status).toBe(200);
    const body = await mint.json() as { data: { token: string } };
    void body;

    const forged = await new jose.SignJWT({ filename, ip: "9.9.9.9" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("vaultbase")
      .setAudience("file")
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime("1h")
      .setJti(crypto.randomUUID())
      .sign(new TextEncoder().encode(SECRET));

    const res = await app.handle(getReq(filename, { token: forged }));
    expect(res.status).toBe(403);
  });

  it("token bound to the request IP is accepted", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: { bindTokenIp: true },
      owner: "u1",
    });
    void rec;
    const app = makeFilesPlugin(tmpDir, SECRET);

    // Forge a token whose ip claim matches the test runtime's client IP.
    const forged = await new jose.SignJWT({ filename, ip: "unknown" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("vaultbase")
      .setAudience("file")
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime("1h")
      .setJti(crypto.randomUUID())
      .sign(new TextEncoder().encode(SECRET));

    const res = await app.handle(getReq(filename, { token: forged }));
    expect(res.status).toBe(200);
  });
});

// ── Audit ───────────────────────────────────────────────────────────────────

describe("file auditDownloads", () => {
  it("emits a files.download row when set", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: { auditDownloads: true },
      owner: "u1",
    });
    void rec;
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(getReq(filename));
    expect(res.status).toBe(200);

    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, "files.download"));
    expect(rows.length).toBe(1);
    expect(rows[0]?.target).toBe(filename);
  });

  it("does not emit when the option is off", async () => {
    const { rec, filename } = await setupFile({
      collectionViewRule: null,
      fieldOptions: {},
      owner: "u1",
    });
    void rec;
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(getReq(filename));
    expect(res.status).toBe(200);

    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, "files.download"));
    expect(rows.length).toBe(0);
  });
});
