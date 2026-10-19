/**
 * Settings the server would ignore, clamp or silently drop are refused at
 * save: a deny list of typos replaced the default list with nothing, and a
 * lockout of 30s or a CORS max-age of -5 saved as typed.
 */
import { describe, expect, it } from "bun:test";
import { validateSettingsPatch } from "../api/settings.ts";

describe("validateSettingsPatch", () => {
  it("refuses an entry that isn't a CIDR in the hook egress lists", () => {
    expect(validateSettingsPatch({ "hooks.http.deny": "10.0.0.0/8, not-a-cidr" })).toContain("'not-a-cidr'");
    expect(validateSettingsPatch({ "hooks.http.allow": "nope" })).toContain("'nope'");
    expect(validateSettingsPatch({ "hooks.http.deny": "10.0.0.0/8, 192.168.0.0/16" })).toBeNull();
    expect(validateSettingsPatch({ "hooks.http.deny": "off" })).toBeNull();
    expect(validateSettingsPatch({ "hooks.http.deny": "" })).toBeNull();
  });

  it("takes IPs and CIDRs as trusted proxies, nothing else", () => {
    expect(validateSettingsPatch({ "security.trusted_proxies": "127.0.0.1, 10.0.0.0/8, ::1" })).toBeNull();
    expect(validateSettingsPatch({ "security.trusted_proxies": "garbage" })).toContain("'garbage'");
  });

  it("refuses a lockout under 60s and a negative CORS max-age", () => {
    expect(validateSettingsPatch({ "auth.lockout.duration_seconds": "30" })).toContain("at least 60");
    expect(validateSettingsPatch({ "auth.lockout.duration_seconds": "900" })).toBeNull();
    expect(validateSettingsPatch({ "cors.max_age": "-5" })).toContain("at least 0");
    expect(validateSettingsPatch({ "cors.max_age": "600" })).toBeNull();
  });

  it("takes an address or Name <address> as the SMTP From", () => {
    expect(validateSettingsPatch({ "smtp.from": "bad from" })).toContain("smtp.from");
    expect(validateSettingsPatch({ "smtp.from": "ops@example.com" })).toBeNull();
    expect(validateSettingsPatch({ "smtp.from": "Ops Team <ops@example.com>" })).toBeNull();
    expect(validateSettingsPatch({ "smtp.from": "" })).toBeNull();
  });
});
