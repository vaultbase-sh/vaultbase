/**
 * Register answers the same body whether or not the email is taken, but the
 * taken branch returned before hashing the password, so it was measurably
 * faster (Shannon AUTH-09). It also skipped validation, so a payload that
 * fails validation got 422 only for new addresses. Email change told a
 * signed-in user outright that an address was "already in use".
 */
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";
import { startSmtpSink, type SmtpSink } from "./_smtp.ts";

const SECRET = "test-secret-register-enum";
let tmpDir: string;
let smtp: SmtpSink;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-enum-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  smtp = startSmtpSink();
  await createCollection({ name: "users", type: "auth", create_rule: null, fields: JSON.stringify([{ name: "age", type: "number", options: { min: 0 } }]) });
  await seedAuthUser({ collection: "users", email: "taken@test.local", passwordHash: await Bun.password.hash("pw-123456789012") });
});

afterEach(async () => {
  smtp.stop();
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const post = (path: string, body: unknown, token?: string) =>
  makeAuthPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

describe("register with a taken email", () => {
  it("hashes the password like a new signup does (no timing shortcut)", async () => {
    const spy = spyOn(Bun.password, "hash");
    try {
      await post("/auth/users/register", { email: "taken@test.local", password: "another-password-1" });
      const taken = spy.mock.calls.length;
      spy.mockClear();
      await post("/auth/users/register", { email: "fresh@test.local", password: "another-password-1" });
      expect(taken).toBe(spy.mock.calls.length);
      expect(taken).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("validates the body first, so invalid data gets the same 422 either way", async () => {
    const bad = { password: "another-password-1", age: -5 };
    const a = await post("/auth/users/register", { email: "taken@test.local", ...bad });
    const b = await post("/auth/users/register", { email: "fresh2@test.local", ...bad });
    expect(a.status).toBe(422);
    expect(b.status).toBe(422);
  });
});

describe("request-email-change to a taken address", () => {
  it("answers like any other request and sends nothing", async () => {
    const id = await seedAuthUser({ collection: "users", email: "me@test.local" });
    const jwt = await signUserJwt(id, "me@test.local", "users", SECRET);
    const taken = await post("/auth/users/request-email-change", { newEmail: "taken@test.local" }, jwt);
    expect(taken.status).toBe(200);
    expect(await taken.json()).toEqual({ data: { sent: true } });
    await Bun.sleep(100);
    expect(smtp.messages).toHaveLength(0);
  });

  it("a free address still gets the confirmation link (legitimate path)", async () => {
    const id = await seedAuthUser({ collection: "users", email: "me@test.local" });
    const jwt = await signUserJwt(id, "me@test.local", "users", SECRET);
    expect((await post("/auth/users/request-email-change", { newEmail: "free@test.local" }, jwt)).status).toBe(200);
    await Bun.sleep(100);
    expect(smtp.messages).toHaveLength(1);
  });
});
