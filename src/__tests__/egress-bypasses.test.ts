/**
 * SSRF egress guard bypasses (handoff #10, plus helpers.fetch and the
 * metadata allow-list lead):
 *  - IPv6 forms carrying an IPv4 address (mapped, compatible, NAT64, 6to4)
 *    weren't judged as that IPv4 address;
 *  - only the first DNS answer was checked, and a DNS error was let through;
 *  - helpers.http followed redirects after checking only the first URL;
 *  - helpers.fetch was raw fetch, with no check at all;
 *  - hooks.http.allow / deny=off could re-open cloud metadata endpoints.
 */
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { assertEgressAllowed, embeddedIPv4, EgressBlockedError, guardedFetch, invalidateEgressCache } from "../core/hook-egress.ts";
import { makeHookHelpers } from "../core/hooks.ts";

let stub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  stub = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/to-private") return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/secret" } });
      if (u.pathname === "/to-metadata") return new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      return new Response("ok");
    },
  });
});
afterAll(() => stub.stop(true));

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  invalidateEgressCache();
});
afterEach(() => { invalidateEgressCache(); closeDb(); });

const blocked = (url: string) => expect(assertEgressAllowed(url)).rejects.toBeInstanceOf(EgressBlockedError);

describe("IPv6 wrappers around IPv4", () => {
  it("are judged as the IPv4 address they carry", async () => {
    await blocked("http://[::ffff:169.254.169.254]/");
    await blocked("http://[::ffff:127.0.0.1]/");
    await blocked("http://[::ffff:a9fe:a9fe]/");
    await blocked("http://[::127.0.0.1]/");
    await blocked("http://[64:ff9b::10.0.0.1]/");
    await blocked("http://[2002:a9fe:a9fe::1]/");
    await blocked("http://[::]/");
  });

  it("unwraps correctly", () => {
    expect(embeddedIPv4("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(embeddedIPv4("64:ff9b::7f00:1")).toBe("127.0.0.1");
    expect(embeddedIPv4("2002:c000:0201::")).toBe("192.0.2.1");
    expect(embeddedIPv4("2001:db8::1")).toBeNull();
  });

  it("public addresses still pass (legitimate path)", async () => {
    expect(await assertEgressAllowed("http://93.184.216.34/")).not.toBeNull();
    expect(await assertEgressAllowed("http://[2606:2800:220:1:248:1893:25c8:1946]/")).not.toBeNull();
  });
});

describe("DNS", () => {
  it("a name that doesn't resolve is blocked, not waved through", async () => {
    await blocked("http://does-not-exist.invalid/");
  });

  it("every answer is checked (localhost → 127.0.0.1 and ::1)", async () => {
    await blocked("http://localhost/");
  });
});

describe("redirects", () => {
  it("every hop is checked", async () => {
    setSetting("hooks.http.allow", "127.0.0.1/32");
    invalidateEgressCache();
    const base = `http://127.0.0.1:${stub.port}`;
    expect((await guardedFetch(`${base}/ok`)).status).toBe(200);
    await expect(guardedFetch(`${base}/to-private`)).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(guardedFetch(`${base}/to-metadata`)).rejects.toBeInstanceOf(EgressBlockedError);
  });
});

describe("helpers.fetch", () => {
  it("goes through the same check as helpers.http", async () => {
    const h = makeHookHelpers();
    await expect(h.fetch("http://10.0.0.1/")).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(h.fetch("http://[::ffff:169.254.169.254]/")).rejects.toBeInstanceOf(EgressBlockedError);
  });
});

describe("cloud metadata", () => {
  it("stays blocked whatever the allow-list or deny=off say", async () => {
    setSetting("hooks.http.allow", "169.254.0.0/16");
    invalidateEgressCache();
    await blocked("http://169.254.169.254/");
    expect(await assertEgressAllowed("http://169.254.1.1/")).not.toBeNull();
    setSetting("hooks.http.deny", "off");
    invalidateEgressCache();
    await blocked("http://169.254.169.254/");
    await blocked("http://[fd00:ec2::254]/");
  });
});
