import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setSetting } from "../api/settings.ts";
import { makeHookHelpers } from "../core/hooks.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-helpers-notify-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  setSetting("notifications.providers.onesignal.enabled", "1");
  setSetting("notifications.providers.onesignal.app_id", "app-1");
  setSetting("notifications.providers.onesignal.api_key", "key-1");
});
afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("helpers.notify", () => {
  it("enqueues to all enabled providers and inserts inbox when table exists", async () => {
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    client.exec(`
      CREATE TABLE vb_notifications (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, type TEXT, title TEXT, body TEXT,
        data TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`);

    const helpers = makeHookHelpers({ collection: "messages", event: "afterCreate" });
    const result = await helpers.notify("user-1", {
      title: "Hi",
      body: "There",
      data: { type: "msg", id: "m1" },
    });

    expect(result.inboxRowId).not.toBeNull();
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0]!.provider).toBe("onesignal");
    expect(result.enqueued[0]!.deduped).toBe(false);

    const row = client.prepare(`SELECT * FROM vb_notifications WHERE id = ?`).get(result.inboxRowId) as {
      title: string; user: string; type: string;
    };
    expect(row.title).toBe("Hi");
    expect(row.user).toBe("user-1");
    expect(row.type).toBe("msg");
  });

  it("opts.inbox=false skips inbox row even when table exists", async () => {
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    client.exec(`
      CREATE TABLE vb_notifications (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, type TEXT, title TEXT, body TEXT,
        data TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`);
    const helpers = makeHookHelpers();
    const result = await helpers.notify("u1", { title: "T", body: "B" }, { inbox: false });
    expect(result.inboxRowId).toBeNull();
    expect(result.enqueued).toHaveLength(1);
  });

  it("opts.push=false enqueues nothing", async () => {
    const helpers = makeHookHelpers();
    const result = await helpers.notify("u1", { title: "T", body: "B" }, { push: false });
    expect(result.enqueued).toEqual([]);
  });

  it("works without bootstrapped collections (inbox skipped, push still fires)", async () => {
    const helpers = makeHookHelpers();
    const result = await helpers.notify("u1", { title: "T", body: "B" });
    expect(result.inboxRowId).toBeNull();
    expect(result.enqueued).toHaveLength(1);
  });
});
