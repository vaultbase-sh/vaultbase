/**
 * Email change, invitations, and session invalidation on password reset /
 * admin password change. Mail goes to an in-process SMTP sink.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";

import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { makeAdminsPlugin } from "../api/admins.ts";
import { makeAuthPagesPlugin } from "../admin/auth-pages.ts";
import { seedAuthUser } from "./_helpers.ts";
import { startSmtpSink, tokenFrom, type SmtpSink } from "./_smtp.ts";

const SECRET = "test-secret-account-flows";
let tmpDir: string;
let smtp: SmtpSink;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-acct-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: await Bun.password.hash("admin-pass-123"), password_reset_at: 0, created_at: 0 });
  smtp = startSmtpSink();
});

afterEach(async () => {
  smtp.stop();
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

/** A JWT issued a minute ago, so a reset "now" is strictly newer than its iat. */
async function oldToken(payload: Record<string, unknown>, audience: "user" | "admin") {
  const iat = Math.floor(Date.now() / 1000) - 60;
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience(audience)
    .setIssuedAt(iat).setExpirationTime(iat + 3600).setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
}

const post = (path: string, body: unknown, token?: string) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

async function user(email = "old@test.local", password = "correct-horse-1") {
  const id = await seedAuthUser({ collection: "users", email, passwordHash: await Bun.password.hash(password), emailVerified: true });
  return { id, token: await oldToken({ id, email, collection: "users" }, "user") };
}

async function waitForMail(needle: string): Promise<string> {
  for (let i = 0; i < 50 && !smtp.last(needle); i++) await Bun.sleep(20);
  return smtp.last(needle)!;
}

describe("password reset", () => {
  it("ends sessions issued before the reset", async () => {
    const { token } = await user();
    expect(await verifyAuthToken(token, SECRET)).not.toBeNull();
    expect((await post("/auth/users/request-password-reset", { email: "old@test.local" })).status).toBe(200);
    const reset = tokenFrom(await waitForMail("reset"));
    const res = await post("/auth/users/confirm-password-reset", { token: reset, password: "a-new-password-9" });
    expect(res.status).toBe(200);
    expect(await verifyAuthToken(token, SECRET)).toBeNull();
  });
});

describe("email change", () => {
  it("sends a link to the new address and switches after password confirm", async () => {
    const { id, token } = await user();
    const req = await post("/auth/users/request-email-change", { newEmail: "new@test.local" }, token);
    expect(req.status).toBe(200);
    const mail = await waitForMail("new@test.local");
    expect(mail).toContain("To: new@test.local");
    const t = tokenFrom(mail);

    expect((await post("/auth/users/confirm-email-change", { token: t, password: "wrong" })).status).toBe(401);
    const ok = await post("/auth/users/confirm-email-change", { token: t, password: "correct-horse-1" });
    expect(ok.status).toBe(200);
    const row = getRawClient().prepare(`SELECT email, email_verified FROM vb_users WHERE id = ?`).get(id) as { email: string; email_verified: number };
    expect(row).toEqual({ email: "new@test.local", email_verified: 1 });
    // Old sessions end; the link is single-use.
    expect(await verifyAuthToken(token, SECRET)).toBeNull();
    expect((await post("/auth/users/confirm-email-change", { token: t, password: "correct-horse-1" })).status).toBe(400);
  });

  it("needs a session, refuses an invalid address, and doesn't reveal a taken one", async () => {
    const { token } = await user();
    await seedAuthUser({ collection: "users", email: "taken@test.local" });
    expect((await post("/auth/users/request-email-change", { newEmail: "x@test.local" })).status).toBe(401);
    // A taken address answers like a free one (no link is sent; see
    // register-enumeration.test.ts).
    expect((await post("/auth/users/request-email-change", { newEmail: "taken@test.local" }, token)).status).toBe(200);
    expect((await post("/auth/users/request-email-change", { newEmail: "not-an-email" }, token)).status).toBe(422);
  });

  it("a newer request voids the older link", async () => {
    const { token } = await user();
    await post("/auth/users/request-email-change", { newEmail: "first@test.local" }, token);
    const first = tokenFrom(await waitForMail("first@test.local"));
    // Past the one-a-minute cooldown on email-change requests.
    getRawClient().run("UPDATE vaultbase_auth_tokens SET created_at = created_at - 120 WHERE purpose = 'email_change'");
    await post("/auth/users/request-email-change", { newEmail: "second@test.local" }, token);
    await waitForMail("second@test.local");
    expect((await post("/auth/users/confirm-email-change", { token: first, password: "correct-horse-1" })).status).toBe(400);
  });
});

describe("invitations", () => {
  async function adminToken() {
    return oldToken({ id: "a1" }, "admin");
  }

  it("creates the user, emails a link, and the invitee sets a password", async () => {
    await seedAuthUser({ collection: "users", email: "someone@test.local" }); // ensures the collection
    const res = await post("/admin/users/users/invite", { email: "invitee@test.local" }, await adminToken());
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { id: string } };
    const t = tokenFrom(await waitForMail("invitee@test.local"));

    // Can't log in before accepting.
    expect((await post("/auth/users/login", { email: "invitee@test.local", password: "chosen-password-7" })).status).toBe(401);
    expect((await post("/auth/users/accept-invite", { token: t, password: "chosen-password-7" })).status).toBe(200);
    expect((await post("/auth/users/login", { email: "invitee@test.local", password: "chosen-password-7" })).status).toBe(200);
    const row = getRawClient().prepare(`SELECT email_verified FROM vb_users WHERE id = ?`).get(data.id) as { email_verified: number };
    expect(row.email_verified).toBe(1);
    expect((await post("/auth/users/accept-invite", { token: t, password: "another-password-8" })).status).toBe(400);
  });

  it("is admin-only and refuses existing emails", async () => {
    await seedAuthUser({ collection: "users", email: "dup@test.local" });
    expect((await post("/admin/users/users/invite", { email: "x@test.local" })).status).toBe(401);
    expect((await post("/admin/users/users/invite", { email: "dup@test.local" }, await adminToken())).status).toBe(409);
  });
});

describe("admin password change", () => {
  it("ends that admin's existing sessions", async () => {
    const tok = await oldToken({ id: "a1" }, "admin");
    expect(await verifyAuthToken(tok, SECRET, { audience: "admin" })).not.toBeNull();
    const res = await makeAdminsPlugin(SECRET).handle(new Request("http://localhost/admin/admins/a1", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ password: "brand-new-admin-pw-1" }),
    }));
    expect(res.status).toBe(200);
    expect(await verifyAuthToken(tok, SECRET, { audience: "admin" })).toBeNull();
  });
});

describe("hosted pages", () => {
  const page = (path: string) => makeAuthPagesPlugin().handle(new Request(`http://localhost${path}`));

  it("carry a nonce CSP that allows their own script", async () => {
    for (const p of ["/auth/reset", "/auth/verify", "/auth/otp", "/auth/invite", "/auth/confirm-email-change"]) {
      const res = await page(`${p}?token=abc&collection=users`);
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect([p, !!nonce]).toEqual([p, true]);
      const html = await res.text();
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(html).not.toContain("<script>");
    }
  });

  it("can't be broken out of with a crafted token", async () => {
    const res = await page(`/auth/reset?token=${encodeURIComponent("</script><script>alert(1)</script>")}&collection=users`);
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
