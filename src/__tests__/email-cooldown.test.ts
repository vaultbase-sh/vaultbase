/**
 * Password-reset and OTP emails go to an address anyone can type. With only
 * the per-IP rate limit in the way, a victim's inbox could be flooded from
 * many addresses. Each user now gets at most one email per kind per minute;
 * the endpoints still answer 200 so nothing is revealed.
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
import { authTokens } from "../db/schema.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";
import { startSmtpSink, type SmtpSink } from "./_smtp.ts";

const SECRET = "test-secret-email-cooldown";
const EMAIL = "victim@test.local";
let tmpDir: string;
let smtp: SmtpSink;
let userId: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-cooldown-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  setSetting("auth.otp.enabled", "1");
  smtp = startSmtpSink();
  userId = await seedAuthUser({ collection: "users", email: EMAIL, passwordHash: await Bun.password.hash("pw-1234567890"), emailVerified: true });
});

afterEach(async () => {
  smtp.stop();
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const post = (path: string, body: unknown) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

/**
 * Pretend the tokens of `purpose` just issued were issued `seconds` earlier.
 * Requests answer before the email (and, for OTP, the token row) is done, so
 * this waits for a token not yet aged; a fixed wait wasn't always enough on CI.
 */
async function age(purpose: string, seconds: number): Promise<void> {
  const fresh = async () => (await getDb().select().from(authTokens)
    .where(and(eq(authTokens.user_id, userId), eq(authTokens.purpose, purpose))))
    .filter((r) => r.created_at > Math.floor(Date.now() / 1000) - 30);
  let rows = await fresh();
  for (let i = 0; i < 100 && rows.length === 0; i++) { await Bun.sleep(20); rows = await fresh(); }
  for (const r of rows) await getDb().update(authTokens).set({ created_at: r.created_at - seconds }).where(eq(authTokens.id, r.id));
}

/** Wait for `expected` emails, then a little longer so an extra one would show. */
async function settle(expected: number, count = () => smtp.messages.length): Promise<void> {
  for (let i = 0; i < 100 && count() < expected; i++) await Bun.sleep(20);
  await Bun.sleep(100);
}

const flows = [
  { name: "password reset", path: "/auth/users/request-password-reset", purpose: "password_reset" },
  { name: "OTP", path: "/auth/users/otp/request", purpose: "otp" },
];

for (const f of flows) {
  describe(`${f.name} email cooldown`, () => {
    it("a second request within a minute sends nothing, but still answers 200", async () => {
      expect((await post(f.path, { email: EMAIL })).status).toBe(200);
      expect((await post(f.path, { email: EMAIL })).status).toBe(200);
      await settle(1);
      expect(smtp.messages).toHaveLength(1);
    });

    it("after the cooldown another email goes out (legitimate path)", async () => {
      await post(f.path, { email: EMAIL });
      await age(f.purpose, 61);
      await post(f.path, { email: EMAIL });
      await settle(2);
      expect(smtp.messages).toHaveLength(2);
    });

    it("has no hourly cap a stranger could use up: one per minute keeps going", async () => {
      for (let i = 0; i < 7; i++) {
        await post(f.path, { email: EMAIL });
        await age(f.purpose, 61);
      }
      await settle(7);
      expect(smtp.messages).toHaveLength(7);
    });

    it("parallel requests send one email", async () => {
      await Promise.all(Array.from({ length: 5 }, () => post(f.path, { email: EMAIL })));
      await settle(1);
      expect(smtp.messages).toHaveLength(1);
    });
  });
}

describe("register with a taken address", () => {
  it("doesn't let repeated registrations flood the owner with reset emails", async () => {
    for (let i = 0; i < 3; i++) await post("/auth/users/register", { email: EMAIL, password: "another-password-1" });
    await settle(1, () => smtp.messages.filter((m) => m.includes("reset")).length);
    expect(smtp.messages.filter((m) => m.includes("reset"))).toHaveLength(1);
  });
});

describe("request-email-change cooldown", () => {
  it("a signed-in user can't use it to flood a stranger's inbox", async () => {
    const jwt = await signUserJwt(userId, EMAIL, "users", SECRET);
    const send = (to: string) => makeAuthPlugin(SECRET).handle(new Request("http://localhost/auth/users/request-email-change", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ newEmail: to }),
    }));
    expect((await send("stranger@test.local")).status).toBe(200);
    expect((await send("stranger@test.local")).status).toBe(429);
    // A taken address answers the same 429 inside the window: no oracle.
    await seedAuthUser({ collection: "users", email: "taken@test.local" });
    expect((await send("taken@test.local")).status).toBe(429);
    await settle(1);
    expect(smtp.messages).toHaveLength(1);
    await age("email_change", 61);
    expect((await send("stranger@test.local")).status).toBe(200);
  });
});
