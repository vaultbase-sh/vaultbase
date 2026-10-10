import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { signAuthToken, verifyAuthToken } from "../core/sec.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-auth-refresh";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function refresh(token: string) {
  const res = await makeAuthPlugin(SECRET).handle(
    new Request("http://localhost/auth/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const body = (await res.json()) as { data?: { token: string }; error?: string };
  return { status: res.status, token: body.data?.token ?? null };
}

describe("POST /auth/refresh", () => {
  it("refreshed user token still verifies (keeps the collection claim)", async () => {
    const id = await seedAuthUser({ collection: "users", email: "a@test.local" });
    const original = await signUserJwt(id, "a@test.local", "users", SECRET);
    expect(await verifyAuthToken(original, SECRET)).not.toBeNull();

    const r = await refresh(original);
    expect(r.status).toBe(200);
    expect(r.token).toBeTruthy();
    expect(jose.decodeJwt(r.token!)["collection"]).toBe("users");
    const ctx = await verifyAuthToken(r.token!, SECRET);
    expect(ctx?.id).toBe(id);
    expect(ctx?.type).toBe("user");
  });

  it("anonymous user stays anonymous after refresh", async () => {
    const id = await seedAuthUser({ collection: "users", isAnonymous: true });
    const { token } = await signAuthToken({
      payload: { id, email: `anon-${id}@test.local`, collection: "users", anonymous: true },
      audience: "user",
      expiresInSeconds: 3600,
      jwtSecret: SECRET,
    });
    const r = await refresh(token);
    expect(r.status).toBe(200);
    const claims = jose.decodeJwt(r.token!);
    expect(claims["anonymous"]).toBe(true);
    expect(claims["collection"]).toBe("users");
    expect(await verifyAuthToken(r.token!, SECRET)).not.toBeNull();
  });

  it("refuses to refresh an impersonation token (sessions stay time-boxed)", async () => {
    const id = await seedAuthUser({ collection: "users", email: "b@test.local" });
    const { token } = await signAuthToken({
      payload: { id, email: "b@test.local", collection: "users", impersonated_by: "admin-1" },
      audience: "user",
      expiresInSeconds: 600,
      jwtSecret: SECRET,
    });
    const r = await refresh(token);
    expect(r.status).toBe(403);
    expect(r.token).toBeNull();
  });
});
