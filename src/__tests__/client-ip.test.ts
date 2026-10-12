/**
 * Client IP (handoff #11): trustedClientIp() took the leftmost
 * X-Forwarded-For entry — the one the client writes — and several places
 * (lockout, audit log, request logs, custom routes) read X-Forwarded-For
 * directly with no check of who sent it. Now one rule: X-Forwarded-For only
 * counts when the socket peer is a trusted proxy, and it is walked from the
 * right, skipping trusted hops.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { clientIp, perClientLimitIp, rememberPeer, trustedClientIp } from "../core/sec.ts";

const req = (xff?: string) => new Request("http://localhost/", { headers: xff ? { "x-forwarded-for": xff } : {} });

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  setSetting("security.trusted_proxies", "10.0.0.0/8");
});

afterEach(() => closeDb());

describe("trustedClientIp", () => {
  it("a client-supplied first entry is not the answer: the rightmost untrusted hop is", () => {
    expect(trustedClientIp(req("6.6.6.6, 203.0.113.5"), "10.0.0.2")).toBe("203.0.113.5");
  });

  it("trusted hops are skipped from the right", () => {
    expect(trustedClientIp(req("6.6.6.6, 203.0.113.5, 10.0.0.3"), "10.0.0.2")).toBe("203.0.113.5");
  });

  it("from an untrusted peer, X-Forwarded-For is ignored", () => {
    expect(trustedClientIp(req("6.6.6.6"), "198.51.100.9")).toBe("198.51.100.9");
  });

  it("the Settings value is honoured, not only the env var", () => {
    setSetting("security.trusted_proxies", "192.0.2.1");
    expect(trustedClientIp(req("203.0.113.5"), "192.0.2.1")).toBe("203.0.113.5");
  });
});

describe("clientIp", () => {
  it("doesn't trust X-Forwarded-For when nothing recorded who sent it", () => {
    expect(clientIp(req("6.6.6.6"))).toBeNull();
  });

  it("uses the recorded peer (legitimate path)", () => {
    const r = req("6.6.6.6, 203.0.113.5");
    rememberPeer(r, "10.0.0.2");
    expect(clientIp(r)).toBe("203.0.113.5");
  });
});

describe("perClientLimitIp (realtime per-address caps)", () => {
  // Without trusted proxies, every client behind a local reverse proxy has
  // the proxy's address; a per-IP cap on it capped the whole site at 100
  // realtime connections.
  it("skips the per-address cap for a local peer when no proxies are trusted", () => {
    setSetting("security.trusted_proxies", "");
    expect(perClientLimitIp(req(), "127.0.0.1")).toBeNull();
    expect(perClientLimitIp(req(), "::1")).toBeNull();
    expect(perClientLimitIp(req(), "::ffff:127.0.0.1")).toBeNull();
    expect(perClientLimitIp(req(), "172.18.0.4")).toBeNull();
  });

  it("still caps a public peer by its own address", () => {
    setSetting("security.trusted_proxies", "");
    expect(perClientLimitIp(req("6.6.6.6"), "203.0.113.7")).toBe("203.0.113.7");
  });

  it("with trusted proxies, caps by the forwarded client address", () => {
    expect(perClientLimitIp(req("203.0.113.5"), "10.0.0.2")).toBe("203.0.113.5");
    expect(perClientLimitIp(req(), "198.51.100.9")).toBe("198.51.100.9");
  });
});
