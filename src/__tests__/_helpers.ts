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

/**
 * Create a collection the records API will serve to anonymous callers.
 *
 * Rules default to admin-only (`""`) since the public-by-default fix, so a
 * test that exercises the API without auth has to ask for public access
 * explicitly — `null` means public (see `evaluateRule` in core/rules.ts).
 * Anything the caller passes wins, so fixtures that set their own rules are
 * unaffected.
 */
export async function createPublicCollection(
  init: Parameters<typeof createCollection>[0],
): Promise<Awaited<ReturnType<typeof createCollection>>> {
  return createCollection({
    list_rule: null,
    view_rule: null,
    create_rule: null,
    update_rule: null,
    delete_rule: null,
    ...init,
  });
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

/**
 * The stored id of a one-time token: tokens are kept as a SHA-256 hash, so
 * a test that seeds `vaultbase_auth_tokens` directly stores this and
 * presents the raw value.
 */
export function hashedTokenId(raw: string): string {
  return "h:" + new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}
