import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { extractAuth } from "../api/logs.ts";

const SECRET = "test-secret-register-validate";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

function authReq(method: string, url: string, token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${url}`, init);
}

describe("POST /api/auth/:collection/register runs validateRecord", () => {
  it("surfaces a 422 with details when an admin-set min on email rejects the input", async () => {
    await createCollection({
      name: "users",
      type: "auth",
      fields: JSON.stringify([
        { name: "email", type: "email", required: true, implicit: true, options: { unique: true, min: 8 } },
        { name: "verified", type: "bool", implicit: true },
      ]),
    });
    const app = makeAuthPlugin(SECRET);
    // 7-char email passes the email regex but fails min=8
    const res = await app.handle(authReq("POST", "/api/auth/users/register", null, {
      email: "a@b.com",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; code: number; details: Record<string, string> };
    expect(body.code).toBe(422);
    expect(body.details).toHaveProperty("email");
    expect(body.details["email"]).toMatch(/at least 8/);
  });

  it("rejects a custom user-defined required field that wasn't provided", async () => {
    await createCollection({
      name: "users",
      type: "auth",
      fields: JSON.stringify([
        { name: "username", type: "text", required: true, options: { min: 3 } },
      ]),
    });
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(authReq("POST", "/api/auth/users/register", null, {
      email: "alice@test.local",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { details: Record<string, string> };
    expect(body.details).toHaveProperty("username");
  });

  it("succeeds when all schema constraints pass", async () => {
    await createCollection({
      name: "users",
      type: "auth",
      fields: JSON.stringify([
        { name: "email", type: "email", required: true, implicit: true, options: { unique: true, min: 5 } },
        { name: "verified", type: "bool", implicit: true },
      ]),
    });
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(authReq("POST", "/api/auth/users/register", null, {
      email: "alice@test.local",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; email: string } };
    expect(body.data.email).toBe("alice@test.local");
  });
});

describe("logs.extractAuth propagates impersonated_by", () => {
  it("copies the JWT claim onto the AuthLogContext", async () => {
    const sec = new TextEncoder().encode(SECRET);
    const { SignJWT } = await import("jose");
    // logs.extractAuth now enforces `iss = "vaultbase"` (matches production
    // signer) — keep the rest of the claim shape unchanged.
    const token = await new SignJWT({ id: "u1", email: "u1@test.local", impersonated_by: "admin-42" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("vaultbase")
      .setAudience("user")
      .setExpirationTime("1h")
      .sign(sec);
    const req = new Request("http://localhost/api/anything", {
      headers: { authorization: `Bearer ${token}` },
    });
    const ctx = await extractAuth(req, sec);
    expect(ctx).not.toBeNull();
    expect(ctx?.id).toBe("u1");
    expect(ctx?.type).toBe("user");
    expect(ctx?.impersonated_by).toBe("admin-42");
  });

  it("leaves impersonated_by unset for non-impersonated tokens", async () => {
    const sec = new TextEncoder().encode(SECRET);
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ id: "u1", email: "u1@test.local" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("vaultbase")
      .setAudience("user")
      .setExpirationTime("1h")
      .sign(sec);
    const req = new Request("http://localhost/api/anything", {
      headers: { authorization: `Bearer ${token}` },
    });
    const ctx = await extractAuth(req, sec);
    expect(ctx?.impersonated_by).toBeUndefined();
  });
});
