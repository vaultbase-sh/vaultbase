/**
 * Step 2 of MFA sign-in: a 6-digit TOTP code (or a recovery code) traded with
 * the ticket from `/login`.
 *
 * The attempt cap used to live on the ticket, so calling `/login` again with
 * the known password minted a fresh 5-guess budget and the TOTP space could be
 * walked. The counter was read-modify-write, so parallel guesses each saw the
 * same count, and a code that had just been used could be replayed within its
 * 90-second window. These tests drive the real routes.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { ensureAuthCollection, signUserJwt } from "./_helpers.ts";
import { insertUser } from "../core/users-table.ts";
import { generateCode, generateSecret } from "../core/totp.ts";

const SECRET = "test-secret-mfa-attempts";
const EMAIL = "alice@test.local";
const PASSWORD = "correct-horse-battery-1";
let totpSecret: string;
let userId: string;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  const col = await ensureAuthCollection("users");
  userId = crypto.randomUUID();
  totpSecret = generateSecret();
  const now = Math.floor(Date.now() / 1000);
  await insertUser(col, {
    id: userId, email: EMAIL, password_hash: await Bun.password.hash(PASSWORD),
    totp_secret: totpSecret, totp_enabled: 1, created_at: now, updated_at: now,
  });
});

afterEach(() => closeDb());

const post = (path: string, body: unknown, token?: string) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

async function ticket(): Promise<string> {
  const res = await post("/auth/users/login", { email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { mfa_token: string } };
  return body.data.mfa_token;
}

const current = () => generateCode(totpSecret);
const wrong = () => String((Number(current()) + 500_000) % 1_000_000).padStart(6, "0");
const mfa = (t: string, code: string) => post("/auth/users/login/mfa", { mfa_token: t, code });

describe("MFA step-2 attempt budget", () => {
  it("the right code signs in (legitimate path)", async () => {
    const res = await mfa(await ticket(), current());
    expect(res.status).toBe(200);
  });

  it("a fresh ticket from /login does not reset the budget", async () => {
    for (let round = 0; round < 2; round++) {
      const t = await ticket();
      for (let i = 0; i < 5; i++) expect((await mfa(t, wrong())).status).toBe(401);
    }
    // 10 failures on the account: even the right code on a new ticket is refused.
    expect((await mfa(await ticket(), current())).status).toBe(429);
  });

  it("parallel wrong guesses on one ticket are all counted", async () => {
    const t = await ticket();
    await Promise.all(Array.from({ length: 6 }, () => mfa(t, wrong())));
    expect((await mfa(t, current())).status).toBe(400);
  });

  it("a ticket can only be redeemed once", async () => {
    // Two different valid second factors, so replay protection on the TOTP
    // step can't be what stops the second one.
    const jwt = await signUserJwt(userId, EMAIL, "users", SECRET);
    const regen = await post("/auth/users/totp/recovery/regenerate", {}, jwt);
    const recovery = (await regen.json() as { data: { codes: string[] } }).data.codes[0]!;
    const t = await ticket();
    const results = await Promise.all([
      mfa(t, current()),
      post("/auth/users/login/mfa", { mfa_token: t, recovery_code: recovery }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});

describe("TOTP replay", () => {
  it("a code that was just used can't be used again on a new ticket", async () => {
    const code = current();
    expect((await mfa(await ticket(), code)).status).toBe(200);
    expect((await mfa(await ticket(), code)).status).toBe(401);
  });

  it("/totp/disable refuses a code already spent on sign-in", async () => {
    const code = current();
    expect((await mfa(await ticket(), code)).status).toBe(200);
    const jwt = await signUserJwt(userId, EMAIL, "users", SECRET);
    expect((await post("/auth/users/totp/disable", { code }, jwt)).status).toBe(401);
  });
});

describe("/totp/disable attempt budget", () => {
  it("guesses against /totp/disable are capped per account", async () => {
    const jwt = await signUserJwt(userId, EMAIL, "users", SECRET);
    for (let i = 0; i < 10; i++) expect((await post("/auth/users/totp/disable", { code: wrong() }, jwt)).status).toBe(401);
    expect((await post("/auth/users/totp/disable", { code: current() }, jwt)).status).toBe(429);
  });

  it("the right code still disables MFA (legitimate path)", async () => {
    const jwt = await signUserJwt(userId, EMAIL, "users", SECRET);
    expect((await post("/auth/users/totp/disable", { code: current() }, jwt)).status).toBe(200);
  });
});

describe("recovery codes", () => {
  it("one recovery code can't be spent twice by racing two tickets", async () => {
    const jwt = await signUserJwt(userId, EMAIL, "users", SECRET);
    const regen = await post("/auth/users/totp/recovery/regenerate", {}, jwt);
    const code = (await regen.json() as { data: { codes: string[] } }).data.codes[0]!;
    const [t1, t2] = [await ticket(), await ticket()];
    const results = await Promise.all([
      post("/auth/users/login/mfa", { mfa_token: t1, recovery_code: code }),
      post("/auth/users/login/mfa", { mfa_token: t2, recovery_code: code }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });
});
