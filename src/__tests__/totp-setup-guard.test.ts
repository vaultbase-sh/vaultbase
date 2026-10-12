/**
 * `/totp/setup` stored a fresh secret on the account even when MFA was already
 * on, with no code required. A stolen session could swap the secret for one
 * it controls and then pass every MFA check — including the code that guards
 * `/totp/disable`. Setup now refuses while MFA is enabled.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { ensureAuthCollection, signUserJwt } from "./_helpers.ts";
import { findUserById, insertUser } from "../core/users-table.ts";
import { generateCode, generateSecret } from "../core/totp.ts";

const SECRET = "test-secret-totp-setup";
let userId: string;
let jwt: string;
let original: string;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  const col = await ensureAuthCollection("users");
  userId = crypto.randomUUID();
  original = generateSecret();
  const now = Math.floor(Date.now() / 1000);
  await insertUser(col, { id: userId, email: "a@test.local", password_hash: "x", totp_secret: original, totp_enabled: 1, created_at: now, updated_at: now });
  jwt = await signUserJwt(userId, "a@test.local", "users", SECRET);
});

afterEach(() => closeDb());

const post = (path: string, body: unknown, token: string) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }));

describe("/totp/setup with MFA already on", () => {
  it("refuses and leaves the secret alone", async () => {
    const res = await post("/auth/users/totp/setup", {}, jwt);
    expect(res.status).toBe(409);
    const u = findUserById((await ensureAuthCollection("users")), userId)!;
    expect(u.totp_secret).toBe(original);
    expect(u.totp_enabled).toBe(1);
  });

  it("re-enrolling works after disabling with the current code (legitimate path)", async () => {
    expect((await post("/auth/users/totp/disable", { code: generateCode(original) }, jwt)).status).toBe(200);
    const res = await post("/auth/users/totp/setup", {}, jwt);
    expect(res.status).toBe(200);
    const { secret } = (await res.json() as { data: { secret: string } }).data;
    expect((await post("/auth/users/totp/confirm", { code: generateCode(secret) }, jwt)).status).toBe(200);
  });
});
