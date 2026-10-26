/**
 * One-time tokens (reset and verify links, OTP links, invites, MFA tickets,
 * OAuth merge tokens, PKCE state) were stored verbatim as the row id, so
 * anyone who could read the database — a backup, a read-only SQL session —
 * could reset any pending password. They are stored as a SHA-256 hash now.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { authTokens } from "../db/schema.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { getCollection } from "../core/collections.ts";
import { hashedTokenId, seedAuthUser } from "./_helpers.ts";
import { startSmtpSink, tokenFrom, type SmtpSink } from "./_smtp.ts";
import { onSqlite } from "./_helpers.ts";

const SECRET = "test-secret-token-hashing";
let tmpDir: string;
let smtp: SmtpSink;
let userId: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-tokhash-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  smtp = startSmtpSink();
  userId = await seedAuthUser({ collection: "users", email: "u@test.local", passwordHash: await Bun.password.hash("old-password-123"), emailVerified: true });
});

afterEach(async () => {
  smtp.stop();
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const post = (path: string, body: unknown) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

async function emailedResetToken(): Promise<string> {
  await post("/auth/users/request-password-reset", { email: "u@test.local" });
  for (let i = 0; i < 50 && !smtp.last("reset"); i++) await Bun.sleep(20);
  return tokenFrom(smtp.last("reset"));
}

describe("one-time tokens at rest", () => {
  it("the emailed token is not in the database; its hash is", async () => {
    const token = await emailedResetToken();
    const ids = (await getDb().select().from(authTokens)).map((r) => r.id);
    expect(ids).not.toContain(token);
    expect(ids).toContain(hashedTokenId(token));
  });

  it("the stored value can't be used as the token", async () => {
    await emailedResetToken();
    const [row] = await getDb().select().from(authTokens);
    const res = await post("/auth/users/confirm-password-reset", { token: row!.id, password: "a-new-password-1" });
    expect(res.status).toBe(400);
  });

  it("the emailed token still resets the password (legitimate path)", async () => {
    const token = await emailedResetToken();
    expect((await post("/auth/users/confirm-password-reset", { token, password: "a-new-password-1" })).status).toBe(200);
  });

  // The legacy re-key ran only on SQLite (db/migrate.ts); no Postgres install predates hashing.
  it.skipIf(!onSqlite)("a link issued before the upgrade (stored in plaintext) is re-keyed and still works", async () => {
    const col = (await getCollection("users"))!;
    const legacy = "b".repeat(64);
    await getDb().insert(authTokens).values({
      id: legacy, user_id: userId, collection_id: col.id, purpose: "password_reset",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });
    await runMigrations();
    const ids = (await getDb().select().from(authTokens)).map((r) => r.id);
    expect(ids).not.toContain(legacy);
    expect(ids).toContain(hashedTokenId(legacy));
    expect((await post("/auth/users/confirm-password-reset", { token: legacy, password: "a-new-password-1" })).status).toBe(200);
  });

  it("the OTP code is not stored in a form a database reader can use", async () => {
    const { setSetting } = await import("../api/settings.ts");
    await setSetting("auth.otp.enabled", "1");
    await post("/auth/users/otp/request", { email: "u@test.local" });
    for (let i = 0; i < 50 && !smtp.last("code"); i++) await Bun.sleep(20);
    const code = /\n\s+(\d{6})\n/.exec(smtp.last("code") ?? "")![1]!;
    const [row] = await getDb().select().from(authTokens).where(eq(authTokens.purpose, "otp"));
    expect(row!.code).not.toBe(code);
    expect(row!.code).not.toBe(new Bun.CryptoHasher("sha256").update(code).digest("hex"));
    expect((await post("/auth/users/otp/auth", { email: "u@test.local", code: row!.code })).status).toBe(400);
    expect((await post("/auth/users/otp/auth", { email: "u@test.local", code })).status).toBe(200);
  });

  // The legacy re-key ran only on SQLite (db/migrate.ts); no Postgres install predates hashing.
  it.skipIf(!onSqlite)("pre-upgrade OTP rows (plaintext codes) are voided by the migration", async () => {
    const col = (await getCollection("users"))!;
    await getDb().insert(authTokens).values({
      id: "c".repeat(64), user_id: userId, collection_id: col.id, purpose: "otp", code: "123456",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });
    await runMigrations();
    const [row] = await getDb().select().from(authTokens).where(eq(authTokens.purpose, "otp"));
    expect(row!.code).toBeNull();
    expect(row!.used_at).not.toBeNull();
  });

  // The legacy re-key ran only on SQLite (db/migrate.ts); no Postgres install predates hashing.
  it.skipIf(!onSqlite)("a pre-upgrade row whose hashed id is already taken doesn't stop the migration", async () => {
    const col = (await getCollection("users"))!;
    const x = "state-chosen-by-a-caller";
    const exp = Math.floor(Date.now() / 1000) + 600;
    await getDb().insert(authTokens).values([
      { id: x, user_id: "", collection_id: col.id, purpose: "oauth2_pkce", expires_at: exp },
      { id: hashedTokenId(x), user_id: "", collection_id: col.id, purpose: "oauth2_pkce", expires_at: exp },
    ]);
    await runMigrations();
    const ids = (await getDb().select().from(authTokens)).map((r) => r.id);
    expect(ids).not.toContain(x);
  });
});
