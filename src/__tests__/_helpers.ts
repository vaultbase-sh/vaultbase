/**
 * Shared helpers for the test suite. Keeps the per-test-file ceremony
 * (creating an auth collection + inserting a user + signing a JWT) in one
 * place so v0.11+ refactors don't need to ripple through every file.
 */
import * as jose from "jose";
import { getCollection, createCollection } from "../core/collections.ts";
import { insertUser } from "../core/users-table.ts";

/**
 * Ensure an auth collection exists with the given name. Idempotent — if
 * the collection is already present, returns it without re-creating.
 */
export async function ensureAuthCollection(name: string): Promise<NonNullable<Awaited<ReturnType<typeof getCollection>>>> {
  let col = await getCollection(name);
  if (!col) {
    col = await createCollection({
      name,
      type: "auth",
      fields: JSON.stringify([]),
      view_rule: null,
    });
  }
  return col;
}

/** Insert an auth user directly into `vb_<col>`. Returns the row id. */
export async function seedAuthUser(opts: {
  collection: string;
  id?: string;
  email?: string;
  passwordHash?: string;
  emailVerified?: boolean;
  isAnonymous?: boolean;
}): Promise<string> {
  const col = await ensureAuthCollection(opts.collection);
  const id = opts.id ?? crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await insertUser(col, {
    id,
    email: opts.email ?? `seed-${id}@test.local`,
    password_hash: opts.passwordHash ?? "x",
    email_verified: opts.emailVerified ? 1 : 0,
    is_anonymous: opts.isAnonymous ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** Mint a user JWT with the v0.11 `collection` claim wired in. */
export async function signUserJwt(
  id: string,
  email: string,
  collectionName: string,
  jwtSecret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({ id, email, collection: collectionName })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("user")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(jwtSecret));
}
