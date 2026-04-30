import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, getCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { setSetting } from "../api/settings.ts";
import { users } from "../db/schema.ts";
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
  const res = await app.handle(authReq("POST", "/api/auth/users/anonymous", null));
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { token: string; record: { id: string } } };
  return { token: body.data.token, id: body.data.record.id };
}

describe("POST /api/auth/:collection/promote", () => {
  it("promotes anonymous → real account, mints a non-anonymous JWT", async () => {
    const { token, id } = await mintAnonymous();
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(authReq("POST", "/api/auth/users/promote", token, {
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

    // DB row flipped
    const rows = await getDb().select().from(users).where(eq(users.id, id));
    expect(rows[0]!.is_anonymous).toBe(0);
    expect(rows[0]!.email).toBe("real@test.local");
  });

  it("returns 409 when the email is already taken in the collection", async () => {
    // Pre-seed an account with the target email
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    const col = await getCollection("users");
    await getDb().insert(users).values({
      id: crypto.randomUUID(),
      collection_id: col!.id,
      email: "taken@test.local",
      password_hash: await Bun.password.hash("xxxx"),
    });

    const app = makeAuthPlugin(SECRET);
    const anonRes = await app.handle(authReq("POST", "/api/auth/users/anonymous", null));
    const anonBody = await anonRes.json() as { data: { token: string } };

    const res = await app.handle(authReq("POST", "/api/auth/users/promote", anonBody.data.token, {
      email: "taken@test.local",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; code: number };
    expect(body.code).toBe(409);
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
    const res = await app.handle(authReq("POST", "/api/auth/users/promote", token, {
      email: "x@test.local",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(422);
  });

  it("rejects unauthenticated calls", async () => {
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(authReq("POST", "/api/auth/users/promote", null, {
      email: "x@test.local",
      password: "hunter2!!hunter2!!",
    }));
    expect(res.status).toBe(401);
  });
});
