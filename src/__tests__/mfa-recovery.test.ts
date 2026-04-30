import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { mfaRecoveryCodes, users } from "../db/schema.ts";
import { generateCode, generateSecret } from "../core/totp.ts";
import { eq } from "drizzle-orm";

const SECRET = "test-secret-mfa-recovery";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function setupUserWithTotp(): Promise<{ id: string; email: string; token: string; totpSecret: string }> {
  await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
  const id = crypto.randomUUID();
  const email = "alice@test.local";
  const totpSecret = generateSecret();
  await getDb().insert(users).values({
    id,
    collection_id: (await (await import("../core/collections.ts")).getCollection("users"))!.id,
    email,
    password_hash: await Bun.password.hash("hunter2!!"),
    totp_secret: totpSecret,
    totp_enabled: 1,
  });
  const token = await new jose.SignJWT({ id, email, collection: "users" })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("user")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { id, email, token, totpSecret };
}

function authReq(method: string, url: string, token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${url}`, init);
}

describe("totp/recovery/regenerate", () => {
  it("returns 10 fresh plaintext codes formatted XXXX-XXXX", async () => {
    const { token } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", token));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { codes: string[] } };
    expect(body.data.codes).toHaveLength(10);
    for (const code of body.data.codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
    // All unique
    expect(new Set(body.data.codes).size).toBe(10);
  });

  it("replaces all existing codes (regenerate is destructive)", async () => {
    const { id, token } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", token));
    const firstRows = await getDb().select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.user_id, id));
    expect(firstRows).toHaveLength(10);
    await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", token));
    const secondRows = await getDb().select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.user_id, id));
    expect(secondRows).toHaveLength(10);
    // Hashes must differ from first round
    const firstHashes = new Set(firstRows.map((r) => r.code_hash));
    for (const r of secondRows) {
      expect(firstHashes.has(r.code_hash)).toBe(false);
    }
  });

  it("requires auth", async () => {
    const app = makeAuthPlugin(SECRET);
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    const res = await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", null));
    expect(res.status).toBe(401);
  });
});

describe("totp/recovery/status", () => {
  it("reports totals and remaining counts", async () => {
    const { token } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    let res = await app.handle(authReq("GET", "/api/auth/users/totp/recovery/status", token));
    let body = await res.json() as { data: { total: number; remaining: number } };
    expect(body.data).toEqual({ total: 0, remaining: 0 });

    await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", token));
    res = await app.handle(authReq("GET", "/api/auth/users/totp/recovery/status", token));
    body = await res.json() as { data: { total: number; remaining: number } };
    expect(body.data).toEqual({ total: 10, remaining: 10 });
  });

  it("never returns plaintext or hashes", async () => {
    const { token } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", token));
    const res = await app.handle(authReq("GET", "/api/auth/users/totp/recovery/status", token));
    const text = await res.text();
    expect(text).not.toContain("code_hash");
    expect(text).not.toMatch(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/);
  });
});

describe("login/mfa with recovery_code", () => {
  async function freshLoginTicket(userId: string, collectionId: string): Promise<string> {
    const { authTokens } = await import("../db/schema.ts");
    const ticket = "mfa-test-" + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(authTokens).values({
      id: ticket,
      user_id: userId,
      collection_id: collectionId,
      purpose: "mfa_ticket",
      expires_at: now + 300,
    });
    return ticket;
  }

  it("accepts an unused recovery code and rejects it on reuse", async () => {
    const { id, token } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    const regen = await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", token));
    const codes = ((await regen.json()) as { data: { codes: string[] } }).data.codes;
    const code = codes[0]!;

    const col = await (await import("../core/collections.ts")).getCollection("users");
    const ticket = await freshLoginTicket(id, col!.id);

    const ok = await app.handle(authReq("POST", "/api/auth/users/login/mfa", null, { mfa_token: ticket, recovery_code: code }));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { data: { token: string } };
    expect(typeof body.data.token).toBe("string");

    // Reuse on a fresh ticket — code should now be marked used.
    const ticket2 = await freshLoginTicket(id, col!.id);
    const reuse = await app.handle(authReq("POST", "/api/auth/users/login/mfa", null, { mfa_token: ticket2, recovery_code: code }));
    expect(reuse.status).toBe(401);
  });

  it("rejects a bogus recovery code", async () => {
    const { id, token } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", token));
    const col = await (await import("../core/collections.ts")).getCollection("users");
    const ticket = await freshLoginTicket(id, col!.id);
    const res = await app.handle(authReq("POST", "/api/auth/users/login/mfa", null, { mfa_token: ticket, recovery_code: "AAAA-AAAA" }));
    expect(res.status).toBe(401);
  });

  it("422 when both code and recovery_code supplied", async () => {
    const { id, totpSecret } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    const col = await (await import("../core/collections.ts")).getCollection("users");
    const ticket = await freshLoginTicket(id, col!.id);
    const totp = generateCode(totpSecret, Math.floor(Date.now() / 1000));
    const res = await app.handle(authReq("POST", "/api/auth/users/login/mfa", null, {
      mfa_token: ticket,
      code: totp,
      recovery_code: "ABCD-EFGH",
    }));
    expect(res.status).toBe(422);
  });

  it("422 when neither code nor recovery_code supplied", async () => {
    const { id } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    const col = await (await import("../core/collections.ts")).getCollection("users");
    const ticket = await freshLoginTicket(id, col!.id);
    const res = await app.handle(authReq("POST", "/api/auth/users/login/mfa", null, { mfa_token: ticket }));
    expect(res.status).toBe(422);
  });
});

describe("totp/disable wipes recovery codes", () => {
  it("removes all rows for the user when MFA is disabled", async () => {
    const { id, token, totpSecret } = await setupUserWithTotp();
    const app = makeAuthPlugin(SECRET);
    await app.handle(authReq("POST", "/api/auth/users/totp/recovery/regenerate", token));
    const before = await getDb().select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.user_id, id));
    expect(before.length).toBe(10);

    const totp = generateCode(totpSecret, Math.floor(Date.now() / 1000));
    const res = await app.handle(authReq("POST", "/api/auth/users/totp/disable", token, { code: totp }));
    expect(res.status).toBe(200);

    const after = await getDb().select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.user_id, id));
    expect(after.length).toBe(0);
  });
});
