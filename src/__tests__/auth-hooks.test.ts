/**
 * Auth-collection signup paths fire the same hook lifecycle as the
 * records flow:
 *   - /register     → beforeCreate + afterCreate
 *   - /anonymous    → afterCreate (no body to validate)
 *   - oauth signup  → afterCreate
 *
 * Pre-v0.11.1 the auth path bypassed core/records.ts and never hit
 * runBeforeHook/runAfterHook. This regression test pins the new
 * behaviour.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { hooks as hooksTable } from "../db/schema.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { createCollection } from "../core/collections.ts";
import { makeAuthPlugin } from "../api/auth.ts";

const SECRET = "test-secret-auth-hooks";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-auth-hooks-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  invalidateHookCache();
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* swallow */ }
});

async function installHook(collection: string, event: string, code: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(hooksTable).values({
    id: crypto.randomUUID(),
    name: `${collection}-${event}`,
    collection_name: collection,
    event,
    code,
    enabled: 1,
    created_at: now,
    updated_at: now,
  });
  invalidateHookCache();
}

/** Wait for the after-hook fire-and-forget microtask to settle. */
async function flushAfterHook(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

describe("auth signup hook lifecycle", () => {
  it("/register fires beforeCreate + afterCreate", async () => {
    await createCollection({
      name: "users", type: "auth",
      fields: JSON.stringify([{ name: "marker", type: "text" }]),
      view_rule: null,
    });
    // Mark hooks via globalThis side channel — cheap way to assert
    // they ran without DOM/spies.
    (globalThis as Record<string, unknown>)["_beforeHits"] = 0;
    (globalThis as Record<string, unknown>)["_afterHits"] = 0;
    await installHook("users", "beforeCreate", `globalThis._beforeHits = (globalThis._beforeHits || 0) + 1;`);
    await installHook("users", "afterCreate",  `globalThis._afterHits  = (globalThis._afterHits  || 0) + 1;`);

    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(new Request("http://localhost/auth/users/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@x.com", password: "hunter2!!hunter2!!" }),
    }));
    expect(res.status).toBe(200);
    await flushAfterHook();
    expect((globalThis as Record<string, unknown>)["_beforeHits"]).toBe(1);
    expect((globalThis as Record<string, unknown>)["_afterHits"]).toBe(1);
  });

  it("/anonymous fires afterCreate", async () => {
    await createCollection({
      name: "users", type: "auth",
      fields: JSON.stringify([]), view_rule: null,
    });
    // Anonymous auth is opt-in by default — enable for this test.
    const { settings } = await import("../db/schema.ts");
    await getDb().insert(settings).values({ key: "auth.anonymous.enabled", value: "1", updated_at: Math.floor(Date.now() / 1000) });

    (globalThis as Record<string, unknown>)["_anonHits"] = 0;
    await installHook("users", "afterCreate", `globalThis._anonHits = (globalThis._anonHits || 0) + 1;`);

    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(new Request("http://localhost/auth/users/anonymous", { method: "POST" }));
    expect(res.status).toBe(200);
    await flushAfterHook();
    expect((globalThis as Record<string, unknown>)["_anonHits"]).toBe(1);
  });

  it("global hooks (collection_name='') fire on auth signup too", async () => {
    await createCollection({
      name: "users", type: "auth",
      fields: JSON.stringify([]), view_rule: null,
    });
    (globalThis as Record<string, unknown>)["_globalHits"] = 0;
    await installHook("", "afterCreate", `globalThis._globalHits = (globalThis._globalHits || 0) + 1;`);

    const app = makeAuthPlugin(SECRET);
    await app.handle(new Request("http://localhost/auth/users/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@x.com", password: "hunter2!!hunter2!!" }),
    }));
    await flushAfterHook();
    expect((globalThis as Record<string, unknown>)["_globalHits"]).toBe(1);
  });
});
