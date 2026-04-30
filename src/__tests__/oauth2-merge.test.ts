import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { closeDb, getDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { authTokens, oauthLinks, users } from "../db/schema.ts";
import { and, eq } from "drizzle-orm";
import { makeAuthPlugin } from "../api/auth.ts";

const JWT_SECRET = "test-secret-for-merge";
const PROVIDER = "google";
const PROVIDER_USER_ID = "google-uid-42";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function authCol(): Promise<{ id: string; name: string }> {
  const col = await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
  return { id: col.id, name: col.name };
}

async function seedUser(collectionId: string, email: string, password: string): Promise<string> {
  const id = crypto.randomUUID();
  const hash = await Bun.password.hash(password);
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(users).values({
    id,
    collection_id: collectionId,
    email,
    password_hash: hash,
    email_verified: 1,
    data: "{}",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** Stage a pending merge by writing the same row /oauth2/exchange would. */
async function stagePendingMerge(
  userId: string,
  collectionId: string,
  email: string
): Promise<string> {
  const tokenId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(authTokens).values({
    id: tokenId,
    user_id: userId,
    collection_id: collectionId,
    purpose: "oauth2_merge",
    code: JSON.stringify({
      provider: PROVIDER,
      provider_user_id: PROVIDER_USER_ID,
      email,
      name: null,
    }),
    expires_at: now + 900,
    used_at: null,
    created_at: now,
  });
  return tokenId;
}

async function signUserJwt(userId: string, email: string): Promise<string> {
  return await new jose.SignJWT({ id: userId, email })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("user")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function confirmReq(token: string | null, body: Record<string, unknown>): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/auth/users/oauth2/merge-confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("oauth2 merge-confirm", () => {
  it("links the provider when the password matches", async () => {
    const col = await authCol();
    const userId = await seedUser(col.id, "alice@example.test", "correct-horse-battery-staple");
    const mergeToken = await stagePendingMerge(userId, col.id, "alice@example.test");

    const app = makeAuthPlugin(JWT_SECRET);
    const res = await app.handle(confirmReq(null, {
      merge_token: mergeToken,
      password: "correct-horse-battery-staple",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string; linked_provider: string } };
    expect(body.data.linked_provider).toBe(PROVIDER);
    expect(body.data.token.length).toBeGreaterThan(20);

    const links = await getDb().select().from(oauthLinks).where(and(
      eq(oauthLinks.user_id, userId),
      eq(oauthLinks.provider, PROVIDER),
    ));
    expect(links).toHaveLength(1);
    expect(links[0]!.provider_user_id).toBe(PROVIDER_USER_ID);

    // Token consumed
    const tok = (await getDb().select().from(authTokens).where(eq(authTokens.id, mergeToken)))[0]!;
    expect(tok.used_at).not.toBeNull();
  });

  it("links when proven via valid user JWT instead of password", async () => {
    const col = await authCol();
    const userId = await seedUser(col.id, "bob@example.test", "pw");
    const mergeToken = await stagePendingMerge(userId, col.id, "bob@example.test");
    const userJwt = await signUserJwt(userId, "bob@example.test");

    const app = makeAuthPlugin(JWT_SECRET);
    const res = await app.handle(confirmReq(userJwt, { merge_token: mergeToken }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { linked_provider: string } };
    expect(body.data.linked_provider).toBe(PROVIDER);
  });

  it("rejects an invalid password", async () => {
    const col = await authCol();
    const userId = await seedUser(col.id, "carol@example.test", "real-pw");
    const mergeToken = await stagePendingMerge(userId, col.id, "carol@example.test");

    const app = makeAuthPlugin(JWT_SECRET);
    const res = await app.handle(confirmReq(null, {
      merge_token: mergeToken,
      password: "wrong",
    }));
    expect(res.status).toBe(401);

    const links = await getDb().select().from(oauthLinks).where(eq(oauthLinks.user_id, userId));
    expect(links).toHaveLength(0);
  });

  it("rejects a JWT that belongs to a different user", async () => {
    const col = await authCol();
    const userId = await seedUser(col.id, "dave@example.test", "pw");
    const otherId = await seedUser(col.id, "eve@example.test", "pw");
    const mergeToken = await stagePendingMerge(userId, col.id, "dave@example.test");
    const wrongJwt = await signUserJwt(otherId, "eve@example.test");

    const app = makeAuthPlugin(JWT_SECRET);
    const res = await app.handle(confirmReq(wrongJwt, { merge_token: mergeToken }));
    expect(res.status).toBe(401);
  });

  it("rejects an expired merge token", async () => {
    const col = await authCol();
    const userId = await seedUser(col.id, "frank@example.test", "pw");
    const mergeToken = crypto.randomUUID();
    await getDb().insert(authTokens).values({
      id: mergeToken,
      user_id: userId,
      collection_id: col.id,
      purpose: "oauth2_merge",
      code: JSON.stringify({ provider: PROVIDER, provider_user_id: PROVIDER_USER_ID, email: "frank@example.test", name: null }),
      expires_at: Math.floor(Date.now() / 1000) - 60, // expired 1 min ago
      used_at: null,
      created_at: Math.floor(Date.now() / 1000) - 1000,
    });

    const app = makeAuthPlugin(JWT_SECRET);
    const res = await app.handle(confirmReq(null, {
      merge_token: mergeToken,
      password: "pw",
    }));
    expect(res.status).toBe(401);
  });

  it("rejects a single-use token a second time", async () => {
    const col = await authCol();
    const userId = await seedUser(col.id, "grace@example.test", "pw");
    const mergeToken = await stagePendingMerge(userId, col.id, "grace@example.test");

    const app = makeAuthPlugin(JWT_SECRET);
    const first = await app.handle(confirmReq(null, { merge_token: mergeToken, password: "pw" }));
    expect(first.status).toBe(200);
    const second = await app.handle(confirmReq(null, { merge_token: mergeToken, password: "pw" }));
    expect(second.status).toBe(401);
  });

  it("is idempotent if the link already exists", async () => {
    const col = await authCol();
    const userId = await seedUser(col.id, "henry@example.test", "pw");
    // Pre-existing link
    await getDb().insert(oauthLinks).values({
      id: crypto.randomUUID(),
      user_id: userId,
      collection_id: col.id,
      provider: PROVIDER,
      provider_user_id: PROVIDER_USER_ID,
      provider_email: "henry@example.test",
    });
    const mergeToken = await stagePendingMerge(userId, col.id, "henry@example.test");

    const app = makeAuthPlugin(JWT_SECRET);
    const res = await app.handle(confirmReq(null, { merge_token: mergeToken, password: "pw" }));
    expect(res.status).toBe(200);

    const links = await getDb().select().from(oauthLinks).where(and(
      eq(oauthLinks.user_id, userId),
      eq(oauthLinks.provider, PROVIDER),
    ));
    expect(links).toHaveLength(1); // not duplicated
  });
});
