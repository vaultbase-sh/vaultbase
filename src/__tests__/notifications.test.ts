import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setSetting } from "../api/settings.ts";
import {
  loadProviderConfigs,
  getEnabledProviders,
  sendOneSignal,
  sendFcm,
  dispatchNotification,
  testOneSignalConnection,
  testFcmConnection,
  _resetFcmTokenCache,
  type FcmDeviceToken,
} from "../core/notifications.ts";

let tmpDir: string;
let origFetch: typeof fetch;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-notify-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  origFetch = globalThis.fetch;
  _resetFcmTokenCache();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── settings → config ────────────────────────────────────────────────────────

describe("loadProviderConfigs / getEnabledProviders", () => {
  it("returns disabled-empty when nothing is configured", () => {
    const cfg = loadProviderConfigs();
    expect(cfg.onesignal.enabled).toBe(false);
    expect(cfg.fcm.enabled).toBe(false);
    expect(getEnabledProviders()).toEqual([]);
  });

  it("reads OneSignal settings", () => {
    setSetting("notifications.providers.onesignal.enabled", "1");
    setSetting("notifications.providers.onesignal.app_id", "app-xyz");
    setSetting("notifications.providers.onesignal.api_key", "key-abc");
    const cfg = loadProviderConfigs();
    expect(cfg.onesignal).toEqual({ enabled: true, app_id: "app-xyz", api_key: "key-abc" });
    expect(getEnabledProviders()).toEqual(["onesignal"]);
  });

  it("treats `enabled=1` but missing creds as disabled", () => {
    setSetting("notifications.providers.onesignal.enabled", "1");
    expect(getEnabledProviders()).toEqual([]);
  });

  it("returns both providers in canonical order when both enabled", () => {
    setSetting("notifications.providers.onesignal.enabled", "1");
    setSetting("notifications.providers.onesignal.app_id", "a");
    setSetting("notifications.providers.onesignal.api_key", "k");
    setSetting("notifications.providers.fcm.enabled", "1");
    setSetting("notifications.providers.fcm.service_account", '{"type":"x","project_id":"p","private_key":"x","client_email":"e"}');
    expect(getEnabledProviders()).toEqual(["onesignal", "fcm"]);
  });
});

// ── OneSignal driver ─────────────────────────────────────────────────────────

describe("sendOneSignal", () => {
  it("posts the right body and reports recipients", async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    globalThis.fetch = (async (url: unknown, init: RequestInit | undefined) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({ id: "n-123", recipients: 3 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await sendOneSignal(
      { enabled: true, app_id: "app-xyz", api_key: "key-abc" },
      "user-1",
      { title: "Hi", body: "There", data: { type: "test", id: "1" } },
    );

    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(3);
    expect(res.invalidTokens).toEqual([]);
    expect(captured!.url).toBe("https://api.onesignal.com/notifications");
    expect((captured!.init?.headers as Record<string, string>).Authorization).toBe("Basic key-abc");
    const body = JSON.parse(String(captured!.init?.body));
    expect(body.app_id).toBe("app-xyz");
    expect(body.include_aliases.external_id).toEqual(["user-1"]);
    expect(body.headings.en).toBe("Hi");
    expect(body.contents.en).toBe("There");
    expect(body.data.type).toBe("test");
  });

  it("flags recipients=0 as a misconfiguration hint (still ok=true to avoid retry)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "n-empty", recipients: 0 }),
        { status: 200, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;

    const res = await sendOneSignal(
      { enabled: true, app_id: "a", api_key: "k" },
      "ghost-user",
      { title: "x", body: "y" },
    );
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(0);
    expect(res.message).toContain("recipients=0");
    expect(res.message).toContain("ghost-user");
  });

  it("treats 401 as permanent (ok=true so queue won't retry)", async () => {
    globalThis.fetch = (async () =>
      new Response("invalid app_id or REST API key", { status: 401 })
    ) as unknown as typeof fetch;

    const res = await sendOneSignal(
      { enabled: true, app_id: "a", api_key: "k" },
      "u1",
      { title: "x", body: "y" },
    );
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(0);
    expect(res.message).toContain("401");
  });

  it("treats 503 as transient (ok=false so queue retries)", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream down", { status: 503 })
    ) as unknown as typeof fetch;

    const res = await sendOneSignal(
      { enabled: true, app_id: "a", api_key: "k" },
      "u1",
      { title: "x", body: "y" },
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("transient");
    expect(res.message).toContain("503");
  });
});

// ── FCM driver ───────────────────────────────────────────────────────────────

async function makeServiceAccountJson(): Promise<{ json: string; clientEmail: string; projectId: string }> {
  const { privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const pkcs8 = await jose.exportPKCS8(privateKey);
  const projectId = "test-project-123";
  const clientEmail = "vault-sa@test-project-123.iam.gserviceaccount.com";
  const json = JSON.stringify({
    type: "service_account",
    project_id: projectId,
    private_key_id: "abc",
    private_key: pkcs8,
    client_email: clientEmail,
    token_uri: "https://oauth2.googleapis.com/token",
  });
  return { json, clientEmail, projectId };
}

describe("sendFcm", () => {
  it("returns no-devices message when token list is empty without calling network", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
    const sa = await makeServiceAccountJson();
    const res = await sendFcm(
      { enabled: true, project_id: sa.projectId, service_account: sa.json },
      [],
      { title: "x", body: "y" },
    );
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(0);
    expect(res.message).toContain("no devices");
    expect(calls).toBe(0);
  });

  it("mints OAuth token, sends per-token, parses success", async () => {
    const sa = await makeServiceAccountJson();
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown, _init: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "ya29.fake-access-token", expires_in: 3600, token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ name: "projects/p/messages/abc" }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const tokens: FcmDeviceToken[] = [
      { id: "row-1", token: "fcm-token-aaa" },
      { id: "row-2", token: "fcm-token-bbb" },
    ];
    const res = await sendFcm(
      { enabled: true, project_id: sa.projectId, service_account: sa.json },
      tokens,
      { title: "T", body: "B", data: { kind: "msg" } },
    );
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(2);
    expect(res.invalidTokens).toEqual([]);
    expect(calls.length).toBe(3);
    expect(calls[0]).toBe("https://oauth2.googleapis.com/token");
    expect(calls[1]).toContain("/v1/projects/test-project-123/messages:send");
  });

  it("caches the OAuth access token across consecutive sends", async () => {
    const sa = await makeServiceAccountJson();
    let oauthMints = 0;
    let sends = 0;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u === "https://oauth2.googleapis.com/token") {
        oauthMints++;
        return new Response(
          JSON.stringify({ access_token: "cached-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      sends++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const cfg = { enabled: true, project_id: sa.projectId, service_account: sa.json };
    await sendFcm(cfg, [{ id: "r1", token: "t1" }], { title: "x", body: "y" });
    await sendFcm(cfg, [{ id: "r2", token: "t2" }], { title: "x", body: "y" });

    expect(oauthMints).toBe(1);
    expect(sends).toBe(2);
  });

  it("flags UNREGISTERED tokens as invalidTokens and still succeeds for others", async () => {
    const sa = await makeServiceAccountJson();
    let sendCount = 0;
    globalThis.fetch = (async (url: unknown, init: RequestInit | undefined) => {
      const u = String(url);
      if (u === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "x", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      sendCount++;
      const body = JSON.parse(String(init?.body));
      if (body.message.token === "dead-token") {
        return new Response(
          JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const res = await sendFcm(
      { enabled: true, project_id: sa.projectId, service_account: sa.json },
      [
        { id: "row-dead", token: "dead-token" },
        { id: "row-live", token: "live-token" },
      ],
      { title: "T", body: "B" },
    );
    expect(sendCount).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(1);
    expect(res.invalidTokens).toEqual(["row-dead"]);
  });

  it("ok=false (queue retries) when any token gets a 5xx", async () => {
    const sa = await makeServiceAccountJson();
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "x", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("upstream", { status: 503 });
    }) as unknown as typeof fetch;

    const res = await sendFcm(
      { enabled: true, project_id: sa.projectId, service_account: sa.json },
      [{ id: "r1", token: "t1" }],
      { title: "x", body: "y" },
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("transient=1");
  });
});

describe("sendFcm error propagation", () => {
  it("throws on malformed service account JSON", async () => {
    await expect(sendFcm(
      { enabled: true, project_id: "p", service_account: "not json" },
      [{ id: "r1", token: "t1" }],
      { title: "x", body: "y" },
    )).rejects.toThrow(/Invalid FCM service account JSON/);
  });

  it("throws when OAuth token mint fails", async () => {
    const sa = await makeServiceAccountJson();
    globalThis.fetch = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })
    ) as unknown as typeof fetch;

    await expect(sendFcm(
      { enabled: true, project_id: sa.projectId, service_account: sa.json },
      [{ id: "r1", token: "t1" }],
      { title: "x", body: "y" },
    )).rejects.toThrow(/FCM OAuth token mint failed/);
  });
});

// ── dispatchNotification ─────────────────────────────────────────────────────

describe("dispatchNotification", () => {
  beforeEach(() => {
    setSetting("notifications.providers.onesignal.enabled", "1");
    setSetting("notifications.providers.onesignal.app_id", "a");
    setSetting("notifications.providers.onesignal.api_key", "k");
  });

  it("skips inbox when vb_notifications doesn't exist (still enqueues push)", async () => {
    const res = await dispatchNotification("user-1", { title: "T", body: "B", data: { type: "test" } });
    expect(res.inboxRowId).toBeNull();
    expect(res.enqueued).toHaveLength(1);
    expect(res.enqueued[0]!.provider).toBe("onesignal");
  });

  it("inserts inbox row when vb_notifications exists", async () => {
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    client.exec(`
      CREATE TABLE vb_notifications (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, type TEXT, title TEXT, body TEXT,
        data TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`);

    const res = await dispatchNotification("user-1", { title: "T", body: "B", data: { type: "msg" } });
    expect(res.inboxRowId).not.toBeNull();
    const row = client
      .prepare(`SELECT * FROM vb_notifications WHERE id = ?`)
      .get(res.inboxRowId) as { user: string; title: string; type: string };
    expect(row.user).toBe("user-1");
    expect(row.title).toBe("T");
    expect(row.type).toBe("msg");
  });

  it("opts.inbox=false skips inbox even when table exists", async () => {
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    client.exec(`
      CREATE TABLE vb_notifications (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, type TEXT, title TEXT, body TEXT,
        data TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`);

    const res = await dispatchNotification("u1", { title: "T", body: "B" }, { inbox: false });
    expect(res.inboxRowId).toBeNull();
    expect(res.enqueued).toHaveLength(1);
  });

  it("opts.push=false skips queue jobs", async () => {
    const res = await dispatchNotification("u1", { title: "T", body: "B" }, { push: false });
    expect(res.enqueued).toEqual([]);
  });

  it("opts.providers restricts to a subset", async () => {
    setSetting("notifications.providers.fcm.enabled", "1");
    const sa = await makeServiceAccountJson();
    setSetting("notifications.providers.fcm.service_account", sa.json);

    const all = await dispatchNotification("u1", { title: "T", body: "B" });
    expect(all.enqueued.map((j) => j.provider).sort()).toEqual(["fcm", "onesignal"]);

    const onlyFcm = await dispatchNotification("u1", { title: "T", body: "B" }, { providers: ["fcm"] });
    expect(onlyFcm.enqueued.map((j) => j.provider)).toEqual(["fcm"]);
  });
});

// ── connection-test helpers ──────────────────────────────────────────────────

describe("testOneSignalConnection", () => {
  it("ok on 200", async () => {
    globalThis.fetch = (async () => new Response('{"name":"My App"}', { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const res = await testOneSignalConnection({ enabled: true, app_id: "abc", api_key: "k" });
    expect(res.ok).toBe(true);
  });
  it("not ok on 401", async () => {
    globalThis.fetch = (async () => new Response("invalid key", { status: 401 })) as unknown as typeof fetch;
    const res = await testOneSignalConnection({ enabled: true, app_id: "abc", api_key: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("401");
  });
  it("not ok when app_id or api_key missing", async () => {
    const res = await testOneSignalConnection({ enabled: true, app_id: "", api_key: "" });
    expect(res.ok).toBe(false);
  });
});

describe("testFcmConnection", () => {
  it("ok when token mint succeeds", async () => {
    const sa = await makeServiceAccountJson();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;
    const res = await testFcmConnection({ enabled: true, project_id: sa.projectId, service_account: sa.json });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("test-project-123");
  });
  it("fails on bad service account JSON", async () => {
    const res = await testFcmConnection({ enabled: true, project_id: "p", service_account: "not json" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("Invalid FCM service account JSON");
  });
});
