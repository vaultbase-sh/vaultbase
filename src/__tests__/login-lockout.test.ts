/**
 * Password sign-in lockout. User login used to have no per-account lockout at
 * all (only the per-IP rate limit, which a distributed guesser walks past),
 * and the admin lockout shipped disabled (`auth.lockout.max_attempts = 0`).
 * Both now lock an account after 10 failures in the window by default.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { eq } from "drizzle-orm";
import { admin, authTokens, loginFailures } from "../db/schema.ts";
import { getCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { seedAuthUser } from "./_helpers.ts";

const SECRET = "test-secret-login-lockout";
const PASSWORD = "correct-horse-battery-1";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  const hash = await Bun.password.hash(PASSWORD);
  await seedAuthUser({ collection: "users", email: "alice@test.local", passwordHash: hash });
  await seedAuthUser({ collection: "users", email: "bob@test.local", passwordHash: hash });
  await getDb().insert(admin).values({ id: "a1", email: "admin@test.local", password_hash: hash, password_reset_at: 0, created_at: 0 });
});

afterEach(() => closeDb());

const post = (path: string, body: unknown) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const userLogin = (email: string, password: string) => post("/auth/users/login", { email, password });
const adminLogin = (password: string) => post("/admin/auth/login", { email: "admin@test.local", password });

describe("user login lockout", () => {
  it("the right password signs in (legitimate path)", async () => {
    expect((await userLogin("alice@test.local", PASSWORD)).status).toBe(200);
  });

  it("10 wrong passwords lock the account, even against the right one", async () => {
    for (let i = 0; i < 10; i++) expect((await userLogin("alice@test.local", `guess-${i}`)).status).toBe(401);
    expect((await userLogin("alice@test.local", PASSWORD)).status).toBe(429);
  });

  it("the lockout is per account: another user still signs in", async () => {
    for (let i = 0; i < 10; i++) await userLogin("alice@test.local", `guess-${i}`);
    expect((await userLogin("bob@test.local", PASSWORD)).status).toBe(200);
  });

  it("email case doesn't give a fresh budget", async () => {
    for (let i = 0; i < 10; i++) await userLogin(i % 2 ? "ALICE@test.local" : "alice@test.local", `guess-${i}`);
    expect((await userLogin("alice@test.local", PASSWORD)).status).toBe(429);
  });

  it("a successful sign-in clears earlier failures", async () => {
    for (let i = 0; i < 9; i++) await userLogin("alice@test.local", `guess-${i}`);
    expect((await userLogin("alice@test.local", PASSWORD)).status).toBe(200);
    for (let i = 0; i < 9; i++) await userLogin("alice@test.local", `guess-${i}`);
    expect((await userLogin("alice@test.local", PASSWORD)).status).toBe(200);
  });

  it("failures against a user don't lock the admin with the same email, and vice versa", async () => {
    await seedAuthUser({ collection: "users", email: "admin@test.local", passwordHash: await Bun.password.hash(PASSWORD) });
    for (let i = 0; i < 10; i++) await userLogin("admin@test.local", `guess-${i}`);
    expect((await adminLogin(PASSWORD)).status).toBe(200);
  });

  it("parallel wrong passwords can't race past the limit", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => userLogin("alice@test.local", `guess-${i}`)));
    // A 401 means the password was actually checked. A burst may be refused
    // (429) before any check runs; what must hold is that at most 10 ran.
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(10);
    const col = (await getCollection("users"))!;
    const rows = await getDb().select().from(loginFailures).where(eq(loginFailures.key, `user:${col.id}:alice@test.local`));
    expect(rows.length).toBeLessThanOrEqual(10);
  });

  it("an operator can still turn lockout off with max_attempts = 0", async () => {
    setSetting("auth.lockout.max_attempts", "0");
    for (let i = 0; i < 12; i++) await userLogin("alice@test.local", `guess-${i}`);
    expect((await userLogin("alice@test.local", PASSWORD)).status).toBe(200);
  });
});

describe("admin login lockout", () => {
  it("is on by default: 10 wrong passwords lock the admin", async () => {
    for (let i = 0; i < 10; i++) expect((await adminLogin(`guess-${i}`)).status).toBe(401);
    expect((await adminLogin(PASSWORD)).status).toBe(429);
  });

  it("the right password signs in (legitimate path)", async () => {
    expect((await adminLogin(PASSWORD)).status).toBe(200);
  });
});

describe("IP key", () => {
  const fromIp = (path: string, body: unknown) =>
    makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify(body),
    }));

  it("users failing behind a shared address don't lock the admin out", async () => {
    setSetting("security.trusted_proxies", "127.0.0.1");
    for (let i = 0; i < 12; i++) await fromIp("/auth/users/login", { email: `user${i}@test.local`, password: "nope" });
    expect((await fromIp("/admin/auth/login", { email: "admin@test.local", password: PASSWORD })).status).toBe(200);
  });

  it("signing in to your own account doesn't reset the IP's count", async () => {
    setSetting("security.trusted_proxies", "127.0.0.1");
    for (let i = 0; i < 49; i++) await fromIp("/auth/users/login", { email: `spray${i}@test.local`, password: "nope" });
    expect((await fromIp("/auth/users/login", { email: "bob@test.local", password: PASSWORD })).status).toBe(200);
    expect((await fromIp("/auth/users/login", { email: "spray-x@test.local", password: "nope" })).status).toBe(401);
    expect((await fromIp("/auth/users/login", { email: "alice@test.local", password: PASSWORD })).status).toBe(429);
  });
});

describe("other password checks share the lockout", () => {
  it("confirm-email-change: guessing the password with a stolen link is capped", async () => {
    const col = (await getCollection("users"))!;
    const userId = (await import("../core/users-table.ts")).findUserByEmail(col, "alice@test.local")!.id;
    await getDb().insert(authTokens).values({
      id: "change-token", user_id: userId, collection_id: col.id, purpose: "email_change",
      payload: "attacker@test.local", expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    for (let i = 0; i < 10; i++) {
      expect((await post("/auth/users/confirm-email-change", { token: "change-token", password: `guess-${i}` })).status).toBe(401);
    }
    expect((await post("/auth/users/confirm-email-change", { token: "change-token", password: PASSWORD })).status).toBe(429);
  });

  it("oauth2/merge-confirm: password guesses are capped", async () => {
    const col = (await getCollection("users"))!;
    const userId = (await import("../core/users-table.ts")).findUserByEmail(col, "alice@test.local")!.id;
    await getDb().insert(authTokens).values({
      id: "merge-token", user_id: userId, collection_id: col.id, purpose: "oauth2_merge",
      code: JSON.stringify({ provider: "github", provider_user_id: "gh-1", email: "alice@test.local", name: null }),
      expires_at: Math.floor(Date.now() / 1000) + 900,
    });
    for (let i = 0; i < 10; i++) {
      expect((await post("/auth/users/oauth2/merge-confirm", { merge_token: "merge-token", password: `guess-${i}` })).status).toBe(401);
    }
    expect((await post("/auth/users/oauth2/merge-confirm", { merge_token: "merge-token", password: PASSWORD })).status).toBe(429);
  });
});
