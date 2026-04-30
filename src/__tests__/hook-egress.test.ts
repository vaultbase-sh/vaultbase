/**
 * Regression test for N-2: helpers.http must refuse to issue requests
 * resolving to RFC1918 / link-local / loopback IPs unless an admin
 * explicitly relaxes the deny list via settings.
 *
 * Most cases drive the lower-level `assertEgressAllowed` directly so we
 * don't have to stand up a full server. The end-to-end test exercises
 * `helpers.http.request()` to confirm the wiring.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  EgressBlockedError,
  assertEgressAllowed,
  defaultDenyCidrs,
  invalidateEgressCache,
  ipInCidr,
  parseCidr,
} from "../core/hook-egress.ts";
import { makeExtraHelpers } from "../core/hook-helpers-extra.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  invalidateEgressCache();
});

afterEach(() => {
  closeDb();
  invalidateEgressCache();
});

describe("parseCidr + ipInCidr", () => {
  it("parses a /24 v4 CIDR", () => {
    const c = parseCidr("192.168.1.0/24");
    expect(c).not.toBeNull();
    expect(ipInCidr("192.168.1.42", c!)).toBe(true);
    expect(ipInCidr("192.168.2.1", c!)).toBe(false);
  });

  it("parses a /32 v4 CIDR", () => {
    const c = parseCidr("169.254.169.254/32");
    expect(c).not.toBeNull();
    expect(ipInCidr("169.254.169.254", c!)).toBe(true);
    expect(ipInCidr("169.254.169.255", c!)).toBe(false);
  });

  it("parses a v6 CIDR with embedded prefix", () => {
    const c = parseCidr("fc00::/7");
    expect(c).not.toBeNull();
    expect(ipInCidr("fd00::1", c!)).toBe(true);    // fd00 is fc00::/7
    expect(ipInCidr("::1", c!)).toBe(false);
  });

  it("parses a /128 IPv6 loopback", () => {
    const c = parseCidr("::1/128");
    expect(ipInCidr("::1", c!)).toBe(true);
    expect(ipInCidr("::2", c!)).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(parseCidr("not-an-ip")).toBeNull();
    expect(parseCidr("192.168.1.0/33")).toBeNull();
    expect(parseCidr("::1/200")).toBeNull();
  });

  it("v4 IP never matches v6 CIDR (no auto-mapping)", () => {
    const c = parseCidr("::ffff:0:0/96");
    expect(ipInCidr("127.0.0.1", c!)).toBe(false);
  });
});

describe("assertEgressAllowed (default deny)", () => {
  it("blocks the AWS / GCP metadata endpoint", async () => {
    await expect(assertEgressAllowed("http://169.254.169.254/latest/meta-data/"))
      .rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("blocks RFC1918 — 192.168/16", async () => {
    await expect(assertEgressAllowed("http://192.168.1.1/")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("blocks RFC1918 — 10/8", async () => {
    await expect(assertEgressAllowed("http://10.0.0.1/")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("blocks RFC1918 — 172.16/12", async () => {
    await expect(assertEgressAllowed("http://172.20.0.1/")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("blocks loopback 127/8", async () => {
    await expect(assertEgressAllowed("http://127.0.0.1:9999/")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("blocks IPv6 loopback (::1)", async () => {
    await expect(assertEgressAllowed("http://[::1]:9999/")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("blocks IPv6 ULA (fc00::/7)", async () => {
    await expect(assertEgressAllowed("http://[fd12:3456:789a::1]/")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("does NOT block a public IP literal", async () => {
    // 1.1.1.1 — public; egress allowed (test won't actually send the request).
    const r = await assertEgressAllowed("http://1.1.1.1/");
    expect(r).not.toBeNull();
    expect(r!.ip).toBe("1.1.1.1");
  });

  it("returns null for non-http(s) protocols (let fetch error)", async () => {
    expect(await assertEgressAllowed("file:///etc/passwd")).toBeNull();
  });

  it("default deny list contains the headline ranges", () => {
    const list = defaultDenyCidrs();
    expect(list).toContain("169.254.0.0/16");
    expect(list).toContain("10.0.0.0/8");
    expect(list).toContain("127.0.0.0/8");
    expect(list).toContain("::1/128");
    expect(list).toContain("fc00::/7");
  });
});

describe("operator overrides via settings", () => {
  async function setSetting(key: string, value: string): Promise<void> {
    const { getDb } = await import("../db/client.ts");
    const { sql } = await import("drizzle-orm");
    // The settings table is created lazily by the settings plugin; touch it
    // via raw SQL so this test doesn't depend on importing the plugin.
    await getDb().run(sql`CREATE TABLE IF NOT EXISTS vaultbase_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
    await getDb().run(sql.raw(`INSERT INTO vaultbase_settings (key, value) VALUES ('${key}', '${value.replace(/'/g, "''")}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`));
    invalidateEgressCache();
  }

  it("hooks.http.deny=off disables filtering entirely", async () => {
    await setSetting("hooks.http.deny", "off");
    const r = await assertEgressAllowed("http://169.254.169.254/");
    expect(r).toBeNull();
  });

  it("hooks.http.deny custom list replaces the default", async () => {
    // Custom list: only block 10/8. Public IPs and even 169.254/16 pass.
    await setSetting("hooks.http.deny", "10.0.0.0/8");
    expect(await assertEgressAllowed("http://169.254.169.254/")).not.toBeNull();
    await expect(assertEgressAllowed("http://10.0.0.1/")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("hooks.http.allow punches a hole in the default deny", async () => {
    // Allow exactly 127.0.0.1/32 — other loopback addresses still blocked.
    await setSetting("hooks.http.allow", "127.0.0.1/32");
    const r = await assertEgressAllowed("http://127.0.0.1:8091/");
    expect(r).not.toBeNull();
    await expect(assertEgressAllowed("http://127.0.0.2/")).rejects.toBeInstanceOf(EgressBlockedError);
  });
});

describe("end-to-end via helpers.http.request", () => {
  it("throws EgressBlockedError on default-deny URL — not retried, not swallowed", async () => {
    const h = makeExtraHelpers();
    await expect(
      h.http.request({ url: "http://169.254.169.254/latest/meta-data/", retries: 5 }),
    ).rejects.toThrow(/egress.*blocked/i);
  });
});
