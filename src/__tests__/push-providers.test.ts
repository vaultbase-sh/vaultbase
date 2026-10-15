/**
 * Push providers an extension registers: `helpers.notify` fans out to them
 * once enabled, and the `_notify` worker delivers through them with the same
 * retry and dead-token handling as the built-ins.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setSetting } from "../api/settings.ts";
import { jobsLog } from "../db/schema.ts";
import { startQueueScheduler, stopQueueScheduler } from "../core/queues.ts";
import {
  dispatchNotification, getEnabledProviders, listPushProviders, registerNotificationsWorker,
  registerPushProvider, type PushSendContext,
} from "../core/notifications.ts";

let tmpDir: string;
const sends: PushSendContext[] = [];
let respond: () => { ok: boolean; delivered: number; message: string; invalidTokens?: string[] };
let off: () => void;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-push-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  sends.length = 0;
  respond = () => ({ ok: true, delivered: 1, message: "sent" });
  off = registerPushProvider({
    name: "pager",
    isEnabled: (s) => s["notifications.providers.pager.enabled"] === "1",
    send: async (ctx) => { sends.push(ctx); return respond(); },
  });
  registerNotificationsWorker();
});

afterEach(async () => {
  stopQueueScheduler();
  off();
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForStatus(id: string, want: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [j] = await getDb().select().from(jobsLog).where(eq(jobsLog.id, id)).limit(1);
    if (j?.status === want) return;
    await Bun.sleep(40);
  }
  throw new Error(`job ${id} never reached ${want}`);
}

describe("registered push providers", () => {
  it("is fanned out to once enabled, and delivers through the worker", async () => {
    expect(getEnabledProviders()).not.toContain("pager");
    setSetting("notifications.providers.pager.enabled", "1");
    expect(getEnabledProviders()).toContain("pager");

    const out = await dispatchNotification("user-1", { title: "Hi", body: "there" }, { inbox: false });
    expect(out.enqueued.map((e) => e.provider)).toEqual(["pager"]);
    startQueueScheduler();
    await waitForStatus(out.enqueued[0]!.jobId, "succeeded");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.userId).toBe("user-1");
    expect(sends[0]!.payload.title).toBe("Hi");
  });

  it("disables the device tokens a provider reports as dead", async () => {
    setSetting("notifications.providers.pager.enabled", "1");
    await db.exec(`CREATE TABLE vb_device_tokens (id TEXT PRIMARY KEY, user TEXT, provider TEXT, token TEXT, enabled INTEGER)`);
    await db.exec(`INSERT INTO vb_device_tokens VALUES ('t1', 'user-1', 'pager', 'abc', 1)`);
    respond = () => ({ ok: true, delivered: 0, message: "gone", invalidTokens: ["t1"] });

    const out = await dispatchNotification("user-1", { title: "Hi", body: "x" }, { inbox: false, providers: ["pager"] });
    startQueueScheduler();
    await waitForStatus(out.enqueued[0]!.jobId, "succeeded");
    expect((await db.get<{ enabled: number }>(`SELECT enabled FROM vb_device_tokens WHERE id = 't1'`))!.enabled).toBe(0);
  });

  it("ignores provider names nobody registered", async () => {
    setSetting("notifications.providers.pager.enabled", "1");
    const out = await dispatchNotification("user-1", { title: "Hi", body: "x" }, { inbox: false, providers: ["nope", "pager"] });
    expect(out.enqueued.map((e) => e.provider)).toEqual(["pager"]);
  });

  it("lists providers and refuses duplicates", () => {
    expect(listPushProviders()).toEqual([
      { name: "onesignal", builtin: true }, { name: "fcm", builtin: true }, { name: "pager", builtin: false },
    ]);
    expect(() => registerPushProvider({ name: "fcm", isEnabled: () => false, send: async () => respond() })).toThrow(/already registered/);
  });
});
