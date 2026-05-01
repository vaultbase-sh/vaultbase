import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { closeDb, getDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { oauthLinks, users } from "../db/schema.ts";
import { eq, and } from "drizzle-orm";
import { makeAuthPlugin } from "../api/auth.ts";

const JWT_SECRET = "test-secret-for-unlink";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function setupAuthCollection(): Promise<{ id: string; name: string }> {
  const col = await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
  return { id: col.id, name: col.name };
}

async function insertUser(opts: {
  collection_id: string;
  password_hash?: string;
  is_anonymous?: 0 | 1;
}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(users).values({
    id,
    collection_id: opts.collection_id,
    email: `${id}@example.test`,
    password_hash: opts.password_hash ?? "hashed-pw-placeholder",
    is_anonymous: opts.is_anonymous ?? 0,
    data: "{}",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function insertLink(userId: string, collectionId: string, provider: string): Promise<void> {
  await getDb().insert(oauthLinks).values({
    id: crypto.randomUUID(),
    user_id: userId,
    collection_id: collectionId,
    provider,
    provider_user_id: `${provider}-${userId}`,
    provider_email: `${provider}@example.test`,
  });
}

async function userJwt(userId: string, collectionName: string): Promise<string> {
  return new jose.SignJWT({ id: userId, email: `${userId}@example.test`, collection: collectionName })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("user")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function unlinkRequest(token: string, collectionName: string, provider: string): Request {
  return new Request(
    `http://localhost/auth/${collectionName}/oauth2/${provider}/unlink`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } }
  );
}

describe("DELETE /api/auth/:collection/oauth2/:provider/unlink", () => {
  it("removes the link row on success and returns { data: null }", async () => {
    const col = await setupAuthCollection();
    const userId = await insertUser({ collection_id: col.id });
    // Two links so unlinking one is safe.
    await insertLink(userId, col.id, "google");
    await insertLink(userId, col.id, "github");

    const app = makeAuthPlugin(JWT_SECRET);
    const token = await userJwt(userId, col.name);
    const res = await app.handle(unlinkRequest(token, col.name, "google"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: unknown; error?: string; code?: number };
    expect(body).toEqual({ data: null });

    const remaining = await getDb()
      .select()
      .from(oauthLinks)
      .where(and(eq(oauthLinks.user_id, userId), eq(oauthLinks.provider, "google")));
    expect(remaining).toHaveLength(0);
  });

  it("returns 404 when the user has no link for that provider", async () => {
    const col = await setupAuthCollection();
    const userId = await insertUser({ collection_id: col.id });
    // Only github linked; unlinking google should 404.
    await insertLink(userId, col.id, "github");

    const app = makeAuthPlugin(JWT_SECRET);
    const token = await userJwt(userId, col.name);
    const res = await app.handle(unlinkRequest(token, col.name, "google"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { data?: unknown; error?: string; code?: number };
    expect(body.code).toBe(404);
  });

  it("returns 409 when unlinking would leave the user locked out (no password + only this link)", async () => {
    const col = await setupAuthCollection();
    // Empty password_hash + only one link = unlinking is irreversible.
    const userId = await insertUser({ collection_id: col.id, password_hash: "" });
    await insertLink(userId, col.id, "google");

    const app = makeAuthPlugin(JWT_SECRET);
    const token = await userJwt(userId, col.name);
    const res = await app.handle(unlinkRequest(token, col.name, "google"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { data?: unknown; error?: string; code?: number };
    expect(body).toEqual({ error: "Cannot unlink — would leave you locked out", code: 409 });
    // Link must NOT have been deleted.
    const stillThere = await getDb()
      .select()
      .from(oauthLinks)
      .where(and(eq(oauthLinks.user_id, userId), eq(oauthLinks.provider, "google")));
    expect(stillThere).toHaveLength(1);
  });

  it("admins use the same endpoint to unlink THEIR OWN links — they cannot unlink other users' links via it", async () => {
    const col = await setupAuthCollection();
    // Two distinct users in the same auth collection.
    const adminUserId = await insertUser({ collection_id: col.id });
    const otherUserId = await insertUser({ collection_id: col.id });
    await insertLink(adminUserId, col.id, "google");
    await insertLink(adminUserId, col.id, "github"); // safety link for adminUser
    await insertLink(otherUserId, col.id, "google");

    const app = makeAuthPlugin(JWT_SECRET);
    const adminToken = await userJwt(adminUserId, col.name);

    // Admin unlinks their OWN google link — succeeds.
    const ownRes = await app.handle(unlinkRequest(adminToken, col.name, "google"));
    expect(ownRes.status).toBe(200);

    // The OTHER user's google link is untouched (the endpoint resolves user_id
    // from the JWT, not from any path param).
    const otherStill = await getDb()
      .select()
      .from(oauthLinks)
      .where(and(eq(oauthLinks.user_id, otherUserId), eq(oauthLinks.provider, "google")));
    expect(otherStill).toHaveLength(1);

    // Admin's own google link is gone.
    const ownStill = await getDb()
      .select()
      .from(oauthLinks)
      .where(and(eq(oauthLinks.user_id, adminUserId), eq(oauthLinks.provider, "google")));
    expect(ownStill).toHaveLength(0);
  });
});
