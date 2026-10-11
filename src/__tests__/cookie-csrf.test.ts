/**
 * The admin cookie is ambient authority and must not act cross-site.
 *
 * `extractBearer` accepted `vaultbase_admin_token` on every API route —
 * including `/admin/sql/run`, `/admin/api-tokens` and `/admin/mcp`. The
 * browser attaches that cookie to any request aimed at this host, whoever
 * caused it. `SameSite=Lax` stops a cross-site form post but still rides along
 * on a top-level GET navigation, so the cookie alone is not a sufficient
 * guard. A cookie-authenticated request now has to prove it came from here.
 *
 * `Authorization` is unaffected: a third-party page cannot set that header
 * without a CORS preflight this server never approves.
 */
import { describe, expect, it } from "bun:test";
import { extractBearer, isSameOriginRequest } from "../core/sec.ts";

const TOKEN = "a.jwt.value";
const COOKIE = `vaultbase_admin_token=${TOKEN}`;

function req(headers: Record<string, string>): Request {
  return new Request("https://vault.example.com/api/v1/admin/sql/run", {
    method: "POST",
    headers,
  });
}

describe("cookie auth is same-origin only", () => {
  it("honours the cookie on a same-origin request", () => {
    expect(extractBearer(req({ cookie: COOKIE, "sec-fetch-site": "same-origin" }))).toBe(TOKEN);
  });

  it("honours it on a user-initiated navigation", () => {
    // Sec-Fetch-Site: none is a typed URL or a bookmark, not an attack.
    expect(extractBearer(req({ cookie: COOKIE, "sec-fetch-site": "none" }))).toBe(TOKEN);
  });

  it("ignores it on a cross-site request", () => {
    expect(extractBearer(req({ cookie: COOKIE, "sec-fetch-site": "cross-site" }))).toBeNull();
  });

  it("ignores it from a sibling subdomain", () => {
    // The cookie is host-only, so a subdomain never legitimately has it;
    // trusting same-site would turn any XSS there into admin access here.
    expect(extractBearer(req({ cookie: COOKIE, "sec-fetch-site": "same-site" }))).toBeNull();
  });

  it("ignores it when a foreign Origin is present and Sec-Fetch-Site is not", () => {
    expect(extractBearer(req({ cookie: COOKIE, origin: "https://evil.example" }))).toBeNull();
  });

  it("honours it when the Origin matches and Sec-Fetch-Site is absent", () => {
    expect(extractBearer(req({ cookie: COOKIE, origin: "https://vault.example.com" }))).toBe(TOKEN);
  });

  it("honours it for a non-browser client that sends neither header", () => {
    // curl and friends don't attach cookies by accident; refusing here would
    // break scripted use without closing an attack path.
    expect(extractBearer(req({ cookie: COOKIE }))).toBe(TOKEN);
  });
});

describe("the Authorization header is never origin-checked", () => {
  it("works cross-site", () => {
    expect(extractBearer(req({
      authorization: `Bearer ${TOKEN}`,
      "sec-fetch-site": "cross-site",
    }))).toBe(TOKEN);
  });

  it("still strips the vbat_ prefix", () => {
    expect(extractBearer(req({
      authorization: `Bearer vbat_${TOKEN}`,
      "sec-fetch-site": "cross-site",
    }))).toBe(TOKEN);
  });

  it("takes precedence over a cookie that would be refused", () => {
    expect(extractBearer(req({
      authorization: `Bearer ${TOKEN}`,
      cookie: "vaultbase_admin_token=other",
      "sec-fetch-site": "cross-site",
    }))).toBe(TOKEN);
  });
});

describe("isSameOriginRequest", () => {
  it("rejects a malformed Origin rather than trusting it", () => {
    expect(isSameOriginRequest(req({ origin: "not a url" }))).toBe(false);
  });

  it("compares host, so a port mismatch is cross-origin", () => {
    expect(isSameOriginRequest(req({ origin: "https://vault.example.com:8443" }))).toBe(false);
  });
});
