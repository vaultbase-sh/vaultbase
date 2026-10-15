/**
 * Follow-ups from review of the auth fixes:
 *  - `/totp/recovery/regenerate` minted new recovery codes for anyone holding
 *    a session; it now takes a current authenticator code.
 *  - reset / OTP / email-change requests waited for the mail server only
 *    when the address had an account, so response time revealed it.
 *  - signing out with a token that had just been refreshed left the
 *    replacement live.
 *  - promote answered 409 or 422 for a weak password depending on whether
 *    the address was taken.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { TCPSocketListener } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateEmailCache } from "../core/email.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { ensureAuthCollection, seedAuthUser, signUserJwt } from "./_helpers.ts";
import { insertUser } from "../core/users-table.ts";
import { generateCode, generateSecret } from "../core/totp.ts";

const SECRET = "test-secret-review-followups";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-followups-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const post = (path: string, body: unknown, token?: string) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

describe("recovery codes need a second factor", () => {
  async function mfaUser() {
    const col = await ensureAuthCollection("users");
    const id = crypto.randomUUID();
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    await insertUser(col, { id, email: "m@test.local", password_hash: "x", totp_secret: secret, totp_enabled: 1, created_at: now, updated_at: now });
    return { secret, jwt: await signUserJwt(id, "m@test.local", "users", SECRET) };
  }

  it("a session alone can't regenerate recovery codes", async () => {
    const { jwt } = await mfaUser();
    expect((await post("/auth/users/totp/recovery/regenerate", {}, jwt)).status).toBe(401);
    expect((await post("/auth/users/totp/recovery/regenerate", { code: "000000" }, jwt)).status).toBe(401);
  });

  it("with a current code it works (legitimate path)", async () => {
    const { jwt, secret } = await mfaUser();
    const res = await post("/auth/users/totp/recovery/regenerate", { code: generateCode(secret) }, jwt);
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { codes: string[] } }).data.codes).toHaveLength(10);
  });

  it("enabling MFA hands out the first set of recovery codes", async () => {
    const id = await seedAuthUser({ collection: "users", email: "n@test.local" });
    const jwt = await signUserJwt(id, "n@test.local", "users", SECRET);
    const setup = await (await post("/auth/users/totp/setup", {}, jwt)).json() as { data: { secret: string } };
    const res = await post("/auth/users/totp/confirm", { code: generateCode(setup.data.secret) }, jwt);
    const body = await res.json() as { data: { enabled: boolean; recovery_codes: string[] } };
    expect(body.data.enabled).toBe(true);
    expect(body.data.recovery_codes).toHaveLength(10);
  });
});

describe("/totp/confirm", () => {
  it("refuses when MFA is already on, so it can't mint recovery codes", async () => {
    const col = await ensureAuthCollection("users");
    const id = crypto.randomUUID();
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    await insertUser(col, { id, email: "on@test.local", password_hash: "x", totp_secret: secret, totp_enabled: 1, created_at: now, updated_at: now });
    const jwt = await signUserJwt(id, "on@test.local", "users", SECRET);
    expect((await post("/auth/users/totp/confirm", { code: generateCode(secret) }, jwt)).status).toBe(409);
  });

  it("guesses at a pending enrolment are capped", async () => {
    const id = await seedAuthUser({ collection: "users", email: "p@test.local" });
    const jwt = await signUserJwt(id, "p@test.local", "users", SECRET);
    const { secret } = (await (await post("/auth/users/totp/setup", {}, jwt)).json() as { data: { secret: string } }).data;
    const wrong = String((Number(generateCode(secret)) + 500_000) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 10; i++) expect((await post("/auth/users/totp/confirm", { code: wrong }, jwt)).status).toBe(401);
    expect((await post("/auth/users/totp/confirm", { code: generateCode(secret) }, jwt)).status).toBe(429);
  });
});

describe("request endpoints don't wait for the mail server", () => {
  let silent: TCPSocketListener<unknown>;
  beforeEach(() => {
    // Accepts connections and never answers: an awaited send would hang
    // until the SMTP timeout.
    silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    setSetting("smtp.enabled", "1");
    setSetting("smtp.host", "127.0.0.1");
    setSetting("smtp.port", String(silent.port));
    setSetting("smtp.from", "noreply@test.local");
    setSetting("auth.otp.enabled", "1");
    invalidateEmailCache();
  });
  afterEach(() => silent.stop(true));

  for (const path of ["/auth/users/request-password-reset", "/auth/users/otp/request"]) {
    it(`${path} answers at once for an existing address`, async () => {
      await seedAuthUser({ collection: "users", email: "has-account@test.local" });
      const t0 = Date.now();
      expect((await post(path, { email: "has-account@test.local" })).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2000);
    });
  }

  it("request-email-change answers at once for a free address", async () => {
    const id = await seedAuthUser({ collection: "users", email: "me@test.local" });
    const jwt = await signUserJwt(id, "me@test.local", "users", SECRET);
    const t0 = Date.now();
    expect((await post("/auth/users/request-email-change", { newEmail: "free@test.local" }, jwt)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("logout after a refresh", () => {
  it("signing out with the replaced token also ends its replacement", async () => {
    const id = await seedAuthUser({ collection: "users", email: "r@test.local" });
    const iat = Math.floor(Date.now() / 1000) - 5;
    const old = await new jose.SignJWT({ id, email: "r@test.local", collection: "users" })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("user")
      .setIssuedAt(iat).setExpirationTime(iat + 3600).setJti(crypto.randomUUID())
      .sign(new TextEncoder().encode(SECRET));
    const fresh = (await (await post("/auth/refresh", {}, old)).json() as { data: { token: string } }).data.token;
    expect((await post("/auth/logout", {}, old)).status).toBe(200);
    expect(await verifyAuthToken(fresh, SECRET)).toBeNull();
    expect((await post("/auth/refresh", {}, old)).status).toBe(401);
  });
});

describe("promote", () => {
  it("a weak password gets the same answer whether or not the address is taken", async () => {
    setSetting("auth.anonymous.enabled", "1");
    await ensureAuthCollection("users");
    await seedAuthUser({ collection: "users", email: "taken@test.local" });
    const anon = (await (await post("/auth/users/anonymous", {})).json() as { data: { token: string } }).data.token;
    const taken = await post("/auth/users/promote", { email: "taken@test.local", password: "x" }, anon);
    const free = await post("/auth/users/promote", { email: "free@test.local", password: "x" }, anon);
    expect(taken.status).toBe(free.status);
  });
});
