/**
 * `GET /admin/settings` returned every secret decrypted — SMTP password,
 * OAuth client secrets, S3 keys, the metrics token — so anything that could
 * read one admin response (an XSS in the admin UI, a cached or logged
 * response) had them all. Secret-valued settings are now masked on the way
 * out; sending the mask back on PATCH keeps the stored value.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { makeSettingsPlugin, getSetting, setSetting, SECRET_SETTING_MASK } from "../api/settings.ts";
import { signAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-settings-mask";
let token: string;

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a1@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  token = (await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;
  setSetting("smtp.pass", "hunter2-smtp");
  setSetting("oauth2.google.client_secret", "g-secret");
  setSetting("smtp.host", "mail.example.com");
});

afterEach(() => closeDb());

const call = (method: string, body?: unknown) => makeSettingsPlugin(SECRET).handle(new Request("http://localhost/admin/settings", {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}));

describe("settings secrets", () => {
  it("are masked in GET", async () => {
    const body = await (await call("GET")).json() as { data: Record<string, string> };
    expect(JSON.stringify(body)).not.toContain("hunter2-smtp");
    expect(JSON.stringify(body)).not.toContain("g-secret");
    expect(body.data["smtp.pass"]).toBe(SECRET_SETTING_MASK);
    expect(body.data["smtp.host"]).toBe("mail.example.com");
  });

  it("are masked in the PATCH response", async () => {
    const body = await (await call("PATCH", { "smtp.host": "smtp.example.org" })).json() as { data: Record<string, string> };
    expect(JSON.stringify(body)).not.toContain("hunter2-smtp");
  });

  it("sending the mask back keeps the stored value (legitimate round-trip)", async () => {
    expect((await call("PATCH", { "smtp.pass": SECRET_SETTING_MASK, "smtp.host": "h2" })).status).toBe(200);
    expect(getSetting("smtp.pass", "")).toBe("hunter2-smtp");
    expect(getSetting("smtp.host", "")).toBe("h2");
  });

  it("a new value or an empty one still replaces it", async () => {
    await call("PATCH", { "smtp.pass": "new-pass" });
    expect(getSetting("smtp.pass", "")).toBe("new-pass");
    await call("PATCH", { "smtp.pass": "" });
    expect(getSetting("smtp.pass", "")).toBe("");
  });

  it("an unset secret reads as empty, not as the mask", async () => {
    const body = await (await call("GET")).json() as { data: Record<string, string> };
    expect(body.data["s3.secret_access_key"] ?? "").toBe("");
  });
});

describe("thumbnail cache", () => {
  it("survives a setting unrelated to storage, and goes with a storage one", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { setUploadDir, thumbCacheDir } = await import("../core/storage.ts");
    const dir = mkdtempSync(join(tmpdir(), "vb-thumbs-"));
    try {
      setUploadDir(dir);
      mkdirSync(thumbCacheDir(), { recursive: true });
      const thumb = join(thumbCacheDir(), "a.png__100x100");
      writeFileSync(thumb, "x");
      expect((await call("PATCH", { "smtp.host": "other.example.com" })).status).toBe(200);
      expect(existsSync(thumb)).toBe(true);
      expect((await call("PATCH", { "s3.bucket": "b2" })).status).toBe(200);
      expect(existsSync(thumb)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
