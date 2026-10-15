/**
 * `POST /auth/:collection/promote` copied every extra body key into the user
 * row, and the only filter was "is it a column": an anonymous caller could set
 * `email_verified`, `totp_*`, `password_reset_at` or even `id`. `register`
 * fed extra keys through `insertUser`'s custom-field path with the same gap.
 * Promoting also left the guest's anonymous token working.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { createCollection, getCollection } from "../core/collections.ts";
import { findUserByEmail, findUserById } from "../core/users-table.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { verifyAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-promote-mass";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  setSetting("auth.anonymous.enabled", "1");
  await createCollection({
    name: "users", type: "auth", create_rule: null,
    fields: JSON.stringify([{ name: "nickname", type: "text" }]),
  });
});

afterEach(() => closeDb());

const post = (path: string, body: unknown, token?: string) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

const SYSTEM_KEYS = {
  email_verified: 1,
  totp_enabled: 1,
  totp_secret: "JBSWY3DPEHPK3PXP",
  is_anonymous: 1,
  password_reset_at: 4_000_000_000,
  password_hash: "$argon2id$attacker",
  created_at: 1,
  updated_at: 1,
};

async function anonymous(): Promise<{ token: string; id: string }> {
  const res = await post("/auth/users/anonymous", {});
  const body = await res.json() as { data: { token: string; record: { id: string } } };
  return { token: body.data.token, id: body.data.record.id };
}

describe("promote", () => {
  it("ignores system columns in the body but keeps declared fields", async () => {
    const { token, id } = await anonymous();
    const res = await post("/auth/users/promote", {
      email: "real@test.local", password: "a-good-password-1", nickname: "neo", ...SYSTEM_KEYS,
    }, token);
    expect(res.status).toBe(200);
    const u = (await findUserById((await getCollection("users"))!, id))!;
    expect(u.email).toBe("real@test.local");
    expect(u.email_verified).toBe(0);
    expect(u.totp_enabled).toBe(0);
    expect(u.totp_secret).toBeNull();
    expect(u.is_anonymous).toBe(0);
    expect(u.password_reset_at).toBeLessThan(4_000_000_000);
    expect(u.created_at).toBeGreaterThan(1);
    expect(await Bun.password.verify("a-good-password-1", u.password_hash)).toBe(true);
    expect((u as unknown as Record<string, unknown>)["nickname"]).toBe("neo");
  });

  it("can't change the user's id", async () => {
    const { token, id } = await anonymous();
    await post("/auth/users/promote", { email: "real@test.local", password: "a-good-password-1", id: "attacker-chosen" }, token);
    const col = (await getCollection("users"))!;
    expect(await findUserById(col, "attacker-chosen")).toBeNull();
    expect((await findUserById(col, id))?.email).toBe("real@test.local");
  });

  it("revokes the anonymous token", async () => {
    const { token } = await anonymous();
    const res = await post("/auth/users/promote", { email: "real@test.local", password: "a-good-password-1" }, token);
    expect(res.status).toBe(200);
    const fresh = (await res.json() as { data: { token: string } }).data.token;
    expect(await verifyAuthToken(token, SECRET)).toBeNull();
    expect(await verifyAuthToken(fresh, SECRET)).not.toBeNull();
  });
});

describe("register", () => {
  it("ignores system columns in the body", async () => {
    const res = await post("/auth/users/register", {
      email: "new@test.local", password: "a-good-password-1", nickname: "trin", ...SYSTEM_KEYS,
    });
    expect(res.status).toBe(200);
    const u = (await findUserByEmail((await getCollection("users"))!, "new@test.local"))!;
    expect(u.email_verified).toBe(0);
    expect(u.totp_enabled).toBe(0);
    expect(u.totp_secret).toBeNull();
    expect(u.is_anonymous).toBe(0);
    expect(await Bun.password.verify("a-good-password-1", u.password_hash)).toBe(true);
    expect((u as unknown as Record<string, unknown>)["nickname"]).toBe("trin");
  });
});

describe("promote email uniqueness (review 15 F-5)", () => {
  it("refuses an address that differs from an existing one only in case", async () => {
    const first = await anonymous();
    expect((await post("/auth/users/promote", { email: "alice@test.local", password: "a-good-password-1" }, first.token)).status).toBe(200);
    const second = await anonymous();
    const res = await post("/auth/users/promote", { email: "ALICE@test.local", password: "a-good-password-1" }, second.token);
    expect(res.status).toBe(409);
    expect(await findUserByEmail((await getCollection("users"))!, "ALICE@test.local")).toBeNull();
  });
});
