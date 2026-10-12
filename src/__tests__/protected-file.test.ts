/**
 * A file field marked `protected` is only served with a short-lived download
 * token (optionally one-time and IP-bound). Without a token, the request fell
 * through to the ordinary rule path and was served whenever the record's
 * rules allowed it — so on a publicly viewable record, `protected` did
 * nothing and one-time / IP-bound tokens could be skipped entirely.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { createRecord } from "../core/records.ts";
import { admin, files } from "../db/schema.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { createPublicCollection, seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-protected-file";
let tmpDir: string;
let filename: string;
let recordId: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-protected-"));
  setLogsDir(tmpDir);
  setUploadDir(tmpDir);
  invalidateStorageCache();
  initDb(":memory:");
  await runMigrations();
  // A record anyone may view, with a protected one-time-token attachment.
  const col = await createPublicCollection({
    name: "docs",
    type: "base",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "attachment", type: "file", options: { protected: true, oneTimeToken: true } },
    ]),
  });
  const rec = await createRecord("docs", { title: "public record" }, null);
  recordId = rec.id;
  filename = `${crypto.randomUUID()}.pdf`;
  writeFileSync(join(tmpDir, filename), "%PDF-secret");
  await getDb().insert(files).values({
    id: crypto.randomUUID(), collection_id: col.id, record_id: rec.id, field_name: "attachment",
    filename, original_name: "secret.pdf", mime_type: "application/pdf", size: 11, created_at: 0,
  });
});

afterEach(() => {
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const app = () => makeFilesPlugin(tmpDir, SECRET);
const get = (path: string, bearer?: string) =>
  app().handle(new Request(`http://localhost${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));

async function mintToken(bearer?: string): Promise<string> {
  const res = await app().handle(new Request(`http://localhost/files/docs/${recordId}/attachment/${filename}/token`, {
    method: "POST", headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  }));
  expect(res.status).toBe(200);
  return (await res.json() as { data: { token: string } }).data.token;
}

describe("protected file field", () => {
  it("is not served without a token, even when the record is public", async () => {
    expect((await get(`/files/${filename}`)).status).toBe(401);
  });

  it("a signed-in user still needs a token", async () => {
    const id = await seedAuthUser({ collection: "users", email: "u@test.local" });
    const jwt = await signUserJwt(id, "u@test.local", "users", SECRET);
    expect((await get(`/files/${filename}`, jwt)).status).toBe(401);
  });

  it("an invalid token is refused, not passed on to the rules", async () => {
    expect((await get(`/files/${filename}?token=not-a-token`)).status).toBe(401);
  });

  it("a valid token serves it once (legitimate path)", async () => {
    const token = await mintToken();
    const ok = await get(`/files/${filename}?token=${token}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("%PDF-secret");
    expect((await get(`/files/${filename}?token=${token}`)).status).toBe(410);
  });

  it("an admin is served without a token", async () => {
    await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const t = await new jose.SignJWT({ id: "a1", email: "a@test.local" }).setProtectedHeader({ alg: "HS256" })
      .setIssuer("vaultbase").setAudience("admin").setIssuedAt().setExpirationTime("1h").setJti(crypto.randomUUID())
      .sign(new TextEncoder().encode(SECRET));
    expect((await get(`/files/${filename}`, t)).status).toBe(200);
  });

  it("a file whose field was dropped isn't served by the rules again", async () => {
    const { getCollection, updateCollection } = await import("../core/collections.ts");
    const col = (await getCollection("docs"))!;
    await updateCollection(col.id, { fields: JSON.stringify([{ name: "title", type: "text" }]) } as Parameters<typeof updateCollection>[1]);
    expect((await get(`/files/${filename}`)).status).toBe(401);
  });
});
