import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { isAuthFeatureEnabled, AUTH_FEATURE_DEFAULTS } from "../core/auth-features.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

describe("isAuthFeatureEnabled defaults", () => {
  it("OTP defaults to off (opt-in)", () => {
    expect(isAuthFeatureEnabled("otp")).toBe(false);
    expect(AUTH_FEATURE_DEFAULTS.otp).toBe(false);
  });

  it("MFA defaults to on", () => {
    expect(isAuthFeatureEnabled("mfa")).toBe(true);
  });

  it("anonymous defaults to off (opt-in)", () => {
    expect(isAuthFeatureEnabled("anonymous")).toBe(false);
  });

  it("impersonation defaults to on", () => {
    expect(isAuthFeatureEnabled("impersonation")).toBe(true);
  });
});

describe("isAuthFeatureEnabled respects settings overrides", () => {
  it("explicit '0' disables a default-on feature", () => {
    setSetting("auth.mfa.enabled", "0");
    expect(isAuthFeatureEnabled("mfa")).toBe(false);
  });

  it("explicit '1' enables a default-off feature", () => {
    setSetting("auth.otp.enabled", "1");
    expect(isAuthFeatureEnabled("otp")).toBe(true);
  });

  it("'true' is also accepted as enabled", () => {
    setSetting("auth.anonymous.enabled", "true");
    expect(isAuthFeatureEnabled("anonymous")).toBe(true);
  });

  it("any other value reads as disabled", () => {
    setSetting("auth.impersonation.enabled", "");
    expect(isAuthFeatureEnabled("impersonation")).toBe(false);
    setSetting("auth.impersonation.enabled", "yes");
    expect(isAuthFeatureEnabled("impersonation")).toBe(false);
  });
});
