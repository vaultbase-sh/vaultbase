/**
 * OTP sign-in codes are 6 digits, so the only thing standing between an
 * attacker who knows an email and the account is the attempt counter.
 *
 * The code path used to look the token up *by code*: a wrong guess matched no
 * row, so nothing was ever counted, and older codes stayed valid after a new
 * one was sent. These tests drive the real routes.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setSetting } from "../api/settings.ts";
import { authTokens, loginFailures } from "../db/schema.ts";
import { getCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { seedAuthUser } from "./_helpers.ts";
import { startSmtpSink, tokenFrom, type SmtpSink } from "./_smtp.ts";

const SECRET = "test-secret-otp-bruteforce";
const EMAIL = "victim@test.local";
let tmpDir: string;
let smtp: SmtpSink;
let userId: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-otp-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  setSetting("auth.otp.enabled", "1");
  smtp = startSmtpSink();
  userId = await seedAuthUser({ collection: "users", email: EMAIL, emailVerified: true });
});

afterEach(() => {
  smtp.stop();
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const post = (path: string, body: unknown) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

/** Ask for a code and pull it out of the captured email. */
async function requestCode(): Promise<string> {
  const before = smtp.messages.length;
  expect((await post("/auth/users/otp/request", { email: EMAIL })).status).toBe(200);
  for (let i = 0; i < 50 && smtp.messages.length === before; i++) await Bun.sleep(20);
  const m = /\n\s+(\d{6})\n/.exec(smtp.messages[smtp.messages.length - 1] ?? "");
  if (!m) throw new Error("no code in OTP email");
  return m[1]!;
}

/** Let the next request through the per-email send cooldown. */
async function ageOtpTokens(seconds: number): Promise<void> {
  const rows = await getDb().select().from(authTokens).where(and(eq(authTokens.user_id, userId), eq(authTokens.purpose, "otp")));
  for (const r of rows) {
    await getDb().update(authTokens).set({ created_at: r.created_at - seconds }).where(eq(authTokens.id, r.id));
  }
}

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
const auth = (code: string) => post("/auth/users/otp/auth", { email: EMAIL, code });

describe("OTP code brute force", () => {
  it("the right code signs in (legitimate path)", async () => {
    const code = await requestCode();
    const res = await auth(code);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string } };
    expect(typeof body.data.token).toBe("string");
  });

  it("wrong guesses are counted: after 5 the code is dead, even the right one", async () => {
    const code = await requestCode();
    for (let i = 0; i < 5; i++) expect((await auth(wrong(code))).status).toBe(400);
    expect((await auth(code)).status).toBe(400);
  });

  it("a code can only be used once", async () => {
    const code = await requestCode();
    expect((await auth(code)).status).toBe(200);
    expect((await auth(code)).status).toBe(400);
  });

  it("requesting a new code invalidates the old one", async () => {
    const first = await requestCode();
    await ageOtpTokens(120);
    const second = await requestCode();
    if (first === second) return; // 1-in-a-million collision; nothing to assert
    expect((await auth(first)).status).toBe(400);
    expect((await auth(second)).status).toBe(200);
  });

  it("an expired code is rejected", async () => {
    const code = await requestCode();
    await getDb().update(authTokens).set({ expires_at: Math.floor(Date.now() / 1000) - 1 })
      .where(and(eq(authTokens.user_id, userId), eq(authTokens.purpose, "otp")));
    expect((await auth(code)).status).toBe(400);
  });

  it("failures are counted per account, not per code: fresh codes don't reset the budget", async () => {
    // Two codes' worth of wrong guesses (5 + 5) locks the account's OTP sign-in.
    for (let round = 0; round < 2; round++) {
      const code = await requestCode();
      for (let i = 0; i < 5; i++) await auth(wrong(code));
      await ageOtpTokens(120);
    }
    const code = await requestCode();
    expect((await auth(code)).status).toBe(429);
  });

  it("wrong guesses against another account don't lock this one", async () => {
    await seedAuthUser({ collection: "users", email: "other@test.local", emailVerified: true });
    for (let i = 0; i < 12; i++) await post("/auth/users/otp/auth", { email: "other@test.local", code: "000000" });
    const code = await requestCode();
    expect((await auth(code)).status).toBe(200);
  });

  // A burst may be refused outright (429) before any code is compared; what
  // must hold is how many comparisons ever run: 5 per code, 10 per account.
  it("parallel guesses can't race past the per-code limit", async () => {
    await requestCode();
    await Promise.all(Array.from({ length: 40 }, () => auth("000000")));
    const [tok] = await getDb().select().from(authTokens).where(and(eq(authTokens.user_id, userId), eq(authTokens.purpose, "otp")));
    expect(tok!.attempts).toBeLessThanOrEqual(5);
  });

  it("parallel guesses spread over many codes stop at the account limit", async () => {
    for (let round = 0; round < 4; round++) {
      await requestCode();
      await ageOtpTokens(120);
      await Promise.all(Array.from({ length: 10 }, () => auth("000000")));
    }
    const rows = await getDb().select().from(authTokens).where(and(eq(authTokens.user_id, userId), eq(authTokens.purpose, "otp")));
    expect(rows.reduce((n, r) => n + r.attempts, 0)).toBeLessThanOrEqual(10);
    const failures = await getDb().select().from(loginFailures).where(eq(loginFailures.key, `otp:${(await getCollection("users"))!.id}:${EMAIL}`));
    expect(failures.length).toBeLessThanOrEqual(10);
  });

  it("requesting a new code also voids the old magic link", async () => {
    await requestCode();
    const link = tokenFrom(smtp.messages[smtp.messages.length - 1]);
    await ageOtpTokens(120);
    await requestCode();
    expect((await post("/auth/users/otp/auth", { token: link })).status).toBe(400);
  });

  it("an unknown address hits the same 429, so the limit doesn't reveal accounts", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post("/auth/users/otp/auth", { email: "nobody@test.local", code: "123456" })).status).toBe(400);
    }
    expect((await post("/auth/users/otp/auth", { email: "nobody@test.local", code: "123456" })).status).toBe(429);
  });
});
