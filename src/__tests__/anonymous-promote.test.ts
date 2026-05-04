import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, getCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { setSetting } from "../api/settings.ts";
import { insertUser } from "../core/users-table.ts";
import { eq } from "drizzle-orm";

const SECRET = "test-secret-anon-promote";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  // Anonymous defaults to off — turn it on so we can mint an anon user.
  setSetting("auth.anonymous.enabled", "1");
});

afterEach(() => closeDb());

function authReq(method: string, url: string, token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${url}`, init);
}

async function mintAnonymous(): Promise<{ token: string; id: string }> {
  await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
  const app = makeAuthPlugin(SECRET);
  const res = await app.handle(authReq("POST", "/auth/users/anonymous", null));
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { token: string; record: { id: string } } };
  return { token: body.data.token, id: body.data.record.id };
}

describe("POST /api/auth/:collection/promote", () => {
  it("promotes anonymous → real account, mints a non-anonymous JWT", async () => {
    const { token, id } = await mintAnonymous();
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(authReq("POST", "/auth/users/promote", token, {
      email: "real@test.local",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string; record: { id: string; email: string } } };
    expect(body.data.record.email).toBe("real@test.local");
    expect(body.data.record.id).toBe(id);

    // JWT must not carry `anonymous: true`
    const { payload } = await jose.jwtVerify(body.data.token, new TextEncoder().encode(SECRET), { audience: "user" });
    expect(payload["anonymous"]).toBeUndefined();
    expect(payload["email"]).toBe("real@test.local");

    // DB row flipped — read from per-collection table.
    const row = getRawClient().prepare(`SELECT email, is_anonymous FROM vb_users WHERE id = ?`).get(id) as
      { email: string; is_anonymous: number } | undefined;
    expect(row?.is_anonymous).toBe(0);
    expect(row?.email).toBe("real@test.local");
  });

  it("returns 409 when the email is already taken in the collection", async () => {
    // Pre-seed an account with the target email
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    const col = await getCollection("users");
    const now = Math.floor(Date.now() / 1000);
    await insertUser(col!, {
      id: crypto.randomUUID(),
      email: "taken@test.local",
      password_hash: await Bun.password.hash("xxxx"),
      created_at: now,
      updated_at: now,
    });

    const app = makeAuthPlugin(SECRET);
    const anonRes = await app.handle(authReq("POST", "/auth/users/anonymous", null));
    const anonBody = await anonRes.json() as { data: { token: string } };

    const res = await app.handle(authReq("POST", "/auth/users/promote", anonBody.data.token, {
      email: "taken@test.local",
      password: "hunter2!!hunter2!!",
    }));
    // v0.11: per-collection email uniqueness now enforced at validate-time
    // (previously vb_<auth-col> was empty so uniqueness only fired at the
    // explicit dup-check). Either status surfaces "email taken".
    expect([409, 422]).toContain(res.status);
    const body = await res.json() as { error: string; code: number };
    expect([409, 422]).toContain(body.code);
  });

  it("rejects a non-anonymous user token", async () => {
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    // Sign a normal user JWT — no `anonymous: true` claim.
    const token = await new jose.SignJWT({ id: "u1", email: "real@test.local", collection: "users" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("user")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(authReq("POST", "/auth/users/promote", token, {
      email: "x@test.local",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(422);
  });

  it("rejects unauthenticated calls", async () => {
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(authReq("POST", "/auth/users/promote", null, {
      email: "x@test.local",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(401);
  });
});
