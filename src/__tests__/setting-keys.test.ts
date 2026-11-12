/**
 * `PATCH /admin/settings` stores any key, so a typo answered 200 and changed
 * nothing: `auth.password.min_length` left the minimum at 12. An unknown key
 * is still stored, with a `Vaultbase-Warning`; a later release refuses it.
 * The list of known keys (core/setting-keys.ts) is text, so the first tests
 * tie it to the code that reads settings.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { makeSettingsPlugin, getSetting, setSetting, SECRET_SETTING_MASK } from "../api/settings.ts";
import { signAuthToken } from "../core/sec.ts";
import { isKnownSettingKey, registerSettingKeys, _SETTING_KEY_LISTS } from "../core/setting-keys.ts";
import { AUTH_FEATURE_DEFAULTS } from "../core/auth-features.ts";
import { DEFAULT_WINDOWS } from "../core/auth-tokens.ts";
import { DEFAULT_TEMPLATES } from "../core/email.ts";
import { SCRIPT_TIMEOUT_KEYS } from "../core/script-limits.ts";

const ROOT = join(import.meta.dir, "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules" && name !== "dist") sourceFiles(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("the list of known settings keys", () => {
  it("matches the lists the server keeps elsewhere", () => {
    expect(_SETTING_KEY_LISTS.AUTH_FEATURES.sort()).toEqual(Object.keys(AUTH_FEATURE_DEFAULTS).sort());
    expect(_SETTING_KEY_LISTS.TOKEN_KINDS.sort()).toEqual(Object.keys(DEFAULT_WINDOWS).sort());
    expect(_SETTING_KEY_LISTS.EMAIL_KINDS.sort()).toEqual(Object.keys(DEFAULT_TEMPLATES).sort());
    for (const key of Object.values(SCRIPT_TIMEOUT_KEYS)) expect([key, isKnownSettingKey(key)]).toEqual([key, true]);
  });

  it("has every settings key the server and the admin read or send", () => {
    // Namespaces settings live in: a literal `ns.something` key in these is a setting unless listed below.
    const namespaces = new Set([..._SETTING_KEY_LISTS.EXACT].map((k) => k.split(".")[0]!));
    const notSettings = new Set([
      "auth.signup",                         // an event name
      "security.trusted_proxies_env_view",   // the admin reads it; the server never sets it
    ]);
    const patterns = [
      /getSetting\(\s*["'`]([^"'`$]+)["'`]/g,
      /\b(?:settings|s|all|data|config|d|prev|cfg|patch|payload|values|body)\[\s*["'`]([a-z_][a-z0-9_]*\.[^"'`$]+)["'`]\s*\]/g,
      /^\s*["']([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+)["']\s*:/gm,
      /KEY\s*=\s*["']([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+)["']/g,
    ];
    const unknown: string[] = [];
    let seen = 0;
    for (const file of [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "admin/src"))]) {
      const text = readFileSync(file, "utf8");
      for (const re of patterns) {
        for (const m of text.matchAll(re)) {
          const key = m[1]!;
          if (!namespaces.has(key.split(".")[0]!) || notSettings.has(key)) continue;
          seen++;
          if (!isKnownSettingKey(key)) unknown.push(`${key} (${file.slice(ROOT.length + 1)})`);
        }
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("knows keys with a name in them, and the ones an extension declares", () => {
    for (const k of ["oauth2.google.client_secret", "oauth2.okta.tenant", "notifications.providers.fcm.project_id",
      "theme.accent", "admin.favorites.a1", "_migrations.v0_18_auth_create_rule", "storage.gcs.bucket"]) {
      expect([k, isKnownSettingKey(k)]).toEqual([k, true]);
    }
    for (const k of ["auth.password.min_length", "smtp.hots", "password.minlength", "app.name", "oauth2.enabled"]) {
      expect([k, isKnownSettingKey(k)]).toEqual([k, false]);
    }
    const undo = registerSettingKeys("resend.api_key", /^resend\.tags\./);
    expect(isKnownSettingKey("resend.api_key")).toBe(true);
    expect(isKnownSettingKey("resend.tags.env")).toBe(true);
    undo();
    expect(isKnownSettingKey("resend.api_key")).toBe(false);
  });
});

describe("PATCH /admin/settings with a key nothing reads", () => {
  const SECRET = "test-secret-setting-keys";
  let token: string;

  beforeEach(async () => {
    await initDb(":memory:");
    await runMigrations();
    await getDb().insert(admin).values({ id: "a1", email: "a1@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    token = (await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;
  });
  afterEach(() => closeDb());

  const patch = (body: unknown) => makeSettingsPlugin(SECRET).handle(new Request("http://localhost/admin/settings", {
    method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }));

  it("stores it, as before, and names it in Vaultbase-Warning", async () => {
    const res = await patch({ "auth.password.min_length": "8", "password.require_digit": "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("vaultbase-warning")).toBe("unknown settings key 'auth.password.min_length': stored, but nothing reads it");
    expect(getSetting("auth.password.min_length", "")).toBe("8");
    expect(getSetting("password.require_digit", "")).toBe("1");
  });

  it("names each unknown key", async () => {
    const res = await patch({ "smtp.hots": "mail.example.com", "app.name": "Shop" });
    expect(res.headers.get("vaultbase-warning")).toBe(
      "unknown settings key 'smtp.hots': stored, but nothing reads it | unknown settings key 'app.name': stored, but nothing reads it");
  });

  it("doesn't warn about known keys", async () => {
    const res = await patch({ "password.min_length": "14", "theme.accent": "#e85a4f", "oauth2.google.enabled": "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("vaultbase-warning")).toBeNull();
  });

  it("doesn't warn about a stored key sent back unchanged (settings read, edited and saved whole)", async () => {
    await setSetting("legacy.flag", "on");
    await setSetting("legacy.api_key", "s3cr3t");
    const same = await patch({ "legacy.flag": "on", "legacy.api_key": SECRET_SETTING_MASK, "smtp.host": "h" });
    expect(same.headers.get("vaultbase-warning")).toBeNull();
    const changed = await patch({ "legacy.flag": "off" });
    expect(changed.headers.get("vaultbase-warning")).toContain("'legacy.flag'");
  });
});
