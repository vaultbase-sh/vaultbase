/**
 * Egress denylist for hook-authored outbound HTTP — closes the N-2 SSRF
 * surface. Hooks / routes / cron jobs / queue workers may otherwise call
 * `helpers.http.request({url: "http://169.254.169.254/..."})` and exfiltrate
 * cloud-instance metadata, hit RFC1918 services, or reach link-local
 * addresses.
 *
 * Default-deny ranges (settings: `hooks.http.deny` empty or unset):
 *   - 0.0.0.0/8           "this network" / unspecified
 *   - 10.0.0.0/8          RFC1918 private
 *   - 100.64.0.0/10       CGNAT (RFC6598)
 *   - 127.0.0.0/8         loopback (extra layer over the systemd lock)
 *   - 169.254.0.0/16      link-local (incl. AWS / GCP / Azure metadata)
 *   - 172.16.0.0/12       RFC1918 private
 *   - 192.168.0.0/16      RFC1918 private
 *   - ::1/128             IPv6 loopback
 *   - fc00::/7            IPv6 unique-local (FC + FD)
 *   - fe80::/10           IPv6 link-local
 *
 * Operator overrides:
 *   - `hooks.http.deny` (settings) — comma-separated CIDR list. When set,
 *     REPLACES the default list (so admins who explicitly need access to a
 *     local development service can opt in to a thinner list). Set to the
 *     literal string `"off"` to disable egress filtering entirely.
 *   - `hooks.http.allow` (settings) — comma-separated CIDR list of
 *     exceptions evaluated after deny. Lets you punch a hole through
 *     `127.0.0.0/8` for a specific monitoring sidecar without disabling the
 *     rest of the loopback block.
 *
 * Trust model: this is a code-side defense in depth. Operators running
 * vaultbase under a Linux network namespace / nftables egress filter still
 * get hard kernel-level enforcement; this module is the soft layer that
 * works without root.
 *
 * Limitations (documented for honesty):
 *   - DNS rebinding race: we resolve the hostname, check the answer, then
 *     `fetch()` resolves the hostname again internally. An attacker who
 *     controls DNS for the host can return a public IP first, then a
 *     private IP on the second resolution. Substituting the resolved IP
 *     into the URL would close this but breaks TLS SNI. For now: hard
 *     callout in the docs; high-stakes operators should prefer kernel-level
 *     egress filtering.
 *   - IPv6 zone identifiers (`fe80::1%eth0`) are stripped before parsing.
 */

import { lookup } from "node:dns/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";

export class EgressBlockedError extends Error {
  readonly url: string;
  readonly resolvedIp: string;
  readonly cidr: string;
  constructor(url: string, resolvedIp: string, cidr: string) {
    super(
      cidr === "dns"
        ? `helpers.http: egress to ${url} blocked — the host name did not resolve, so its address can't be checked.`
        : cidr.startsWith("scheme ")
        ? `helpers.http: egress to ${url} blocked — only http and https URLs are allowed.`
        : `helpers.http: egress to ${url} blocked — resolved IP ${resolvedIp} is in denylist range ${cidr}. ` +
          (METADATA_CIDRS.includes(cidr)
            ? `Cloud metadata endpoints are always blocked.`
            : `Change the list in Settings → Hook egress (hooks.http.deny; "off" disables it, not recommended for public-internet deployments).`),
    );
    this.name = "EgressBlockedError";
    this.url = url;
    this.resolvedIp = resolvedIp;
    this.cidr = cidr;
  }
}

const DEFAULT_DENY: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  // IPv6 forms that carry an IPv4 address. The embedded address is also
  // checked against the IPv4 ranges above; these block the wrappers outright.
  "::/128",          // unspecified
  "::ffff:0:0/96",   // IPv4-mapped
  "64:ff9b::/96",    // NAT64 well-known prefix
  "64:ff9b:1::/48",  // NAT64 local-use
  "2002::/16",       // 6to4
];

/**
 * Cloud instance-metadata endpoints. Blocked no matter what `hooks.http.allow`
 * or `hooks.http.deny = off` say: an allow-list entry meant for a private
 * subnet must not also hand hook code the host's cloud credentials.
 */
const METADATA_CIDRS: readonly string[] = [
  "169.254.169.254/32", // AWS, GCP, Azure, Oracle, DigitalOcean, …
  "169.254.170.2/32",   // AWS ECS task metadata
  "169.254.170.23/32",  // AWS EKS pod identity
  "fd00:ec2::254/128",  // AWS IMDS over IPv6
  "fd00:ec2::23/128",   // AWS EKS pod identity over IPv6
  "100.100.100.200/32", // Alibaba Cloud
  "168.63.129.16/32",   // Azure wire server
];

// ── CIDR parsing ────────────────────────────────────────────────────────────

export interface ParsedCidr {
  /** "v4" or "v6" */
  family: "v4" | "v6";
  /** Network bytes — 4 for v4, 16 for v6. */
  network: Uint8Array;
  /** Number of leading bits to compare. */
  prefix: number;
  /** Original string for error messages. */
  src: string;
}

function ipv4ToBytes(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

function ipv6ToBytes(s: string): Uint8Array | null {
  // Strip zone id (e.g. `fe80::1%eth0`)
  const stripped = s.split("%")[0] ?? s;
  // Split on "::" for the compressed form.
  const parts = stripped.split("::");
  if (parts.length > 2) return null;
  const headStr = parts[0] ?? "";
  const tailStr = parts[1] ?? "";
  const head = headStr ? headStr.split(":") : [];
  const tail = tailStr ? tailStr.split(":") : [];
  // Expand any embedded IPv4 in the last segment.
  const expandTail: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const seg = tail[i]!;
    if (seg.includes(".") && i === tail.length - 1) {
      const v4 = ipv4ToBytes(seg);
      if (!v4) return null;
      expandTail.push(((v4[0]! << 8) | v4[1]!).toString(16));
      expandTail.push(((v4[2]! << 8) | v4[3]!).toString(16));
    } else {
      expandTail.push(seg);
    }
  }
  const total = head.length + expandTail.length;
  if (parts.length === 1 && total !== 8) return null;
  if (parts.length === 2 && total > 8) return null;
  const fill = parts.length === 2 ? 8 - total : 0;
  const groups: number[] = [];
  for (const g of head) groups.push(parseInt(g, 16));
  for (let i = 0; i < fill; i++) groups.push(0);
  for (const g of expandTail) groups.push(parseInt(g, 16));
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (typeof g !== "number" || !Number.isInteger(g) || g < 0 || g > 0xffff) return null;
    out[i * 2] = (g >>> 8) & 0xff;
    out[i * 2 + 1] = g & 0xff;
  }
  return out;
}

export function parseCidr(s: string): ParsedCidr | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  const ip = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixStr = slash === -1 ? null : trimmed.slice(slash + 1);
  if (isIPv4(ip)) {
    const bytes = ipv4ToBytes(ip);
    if (!bytes) return null;
    const prefix = prefixStr === null ? 32 : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { family: "v4", network: bytes, prefix, src: trimmed };
  }
  if (isIPv6(ip)) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return null;
    const prefix = prefixStr === null ? 128 : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    return { family: "v6", network: bytes, prefix, src: trimmed };
  }
  return null;
}

function ipBytes(ip: string): Uint8Array | null {
  if (isIPv4(ip)) return ipv4ToBytes(ip);
  if (isIPv6(ip)) return ipv6ToBytes(ip);
  return null;
}

/**
 * The IPv4 address carried inside an IPv6 one, or null: IPv4-mapped
 * (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`), NAT64 (`64:ff9b::/96`,
 * `64:ff9b:1::/48`) and 6to4 (`2002:AABB:CCDD::/16`). Each reaches the IPv4
 * host, so it must be judged as that host: `[::ffff:169.254.169.254]` passed
 * the IPv4 deny list because a v6 address never matched a v4 range.
 */
export function embeddedIPv4(ip: string): string | null {
  if (!isIPv6(ip)) return null;
  const b = ipv6ToBytes(ip);
  if (!b) return null;
  const v4 = (o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12);            // ::ffff:0:0/96
  if (zero(0, 12) && !zero(12, 16) && !(zero(12, 15) && b[15] === 1)) return v4(12); // ::a.b.c.d (not :: or ::1)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return v4(12); // 64:ff9b::/96, 64:ff9b:1::/48
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);                                   // 2002::/16
  return null;
}

/** Returns true when `ip` falls inside the CIDR range. */
export function ipInCidr(ip: string, cidr: ParsedCidr): boolean {
  const bytes = ipBytes(ip);
  if (!bytes) return false;
  // v4-in-v6: when checking a v4 IP against a v6 CIDR (or vice versa) we treat
  // them as never-matching. Operators must list both forms explicitly if they
  // care about IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`).
  if (cidr.family === "v4" && bytes.length !== 4) return false;
  if (cidr.family === "v6" && bytes.length !== 16) return false;

  let bitsLeft = cidr.prefix;
  for (let i = 0; bitsLeft > 0 && i < bytes.length; i++) {
    if (bitsLeft >= 8) {
      if (bytes[i] !== cidr.network[i]) return false;
      bitsLeft -= 8;
    } else {
      const mask = 0xff << (8 - bitsLeft) & 0xff;
      if ((bytes[i]! & mask) !== (cidr.network[i]! & mask)) return false;
      bitsLeft = 0;
    }
  }
  return true;
}

// ── Settings glue ───────────────────────────────────────────────────────────

interface DenyConfig {
  /** When true, deny check is fully disabled. */
  disabled: boolean;
  deny: ParsedCidr[];
  /** Allowlist exceptions evaluated *after* the deny match. */
  allow: ParsedCidr[];
}

let cachedConfig: { value: DenyConfig; expires: number } | null = null;
const CACHE_TTL_MS = 5_000;

function parseList(raw: string): ParsedCidr[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseCidr(s))
    .filter((c): c is ParsedCidr => c !== null);
}

async function loadDenyConfig(): Promise<DenyConfig> {
  // Cache the parsed config — settings table is hot but the parse + array
  // build is wasted work if we do it per request.
  const now = Date.now();
  if (cachedConfig && cachedConfig.expires > now) return cachedConfig.value;

  // Lazy-import to avoid dragging the settings module into core test paths
  // that don't run a full server. If the DB is not initialised or the
  // settings table is missing, fall back to the default deny list —
  // fail-closed.
  let s: Record<string, string> = {};
  try {
    const { getAllSettings } = await import("../api/settings.ts");
    s = getAllSettings();
  } catch {
    s = {};
  }

  const rawDeny = (s["hooks.http.deny"] ?? "").trim();
  const rawAllow = (s["hooks.http.allow"] ?? "").trim();

  let cfg: DenyConfig;
  if (rawDeny.toLowerCase() === "off") {
    cfg = { disabled: true, deny: [], allow: [] };
  } else if (rawDeny === "") {
    cfg = {
      disabled: false,
      deny: parseList(DEFAULT_DENY.join(",")),
      allow: parseList(rawAllow),
    };
  } else {
    cfg = {
      disabled: false,
      deny: parseList(rawDeny),
      allow: parseList(rawAllow),
    };
  }

  cachedConfig = { value: cfg, expires: now + CACHE_TTL_MS };
  return cfg;
}

/** Test-only: drop the cache so subsequent calls re-read settings. */
export function invalidateEgressCache(): void {
  cachedConfig = null;
}

// ── Public API ──────────────────────────────────────────────────────────────

const METADATA = parseList(METADATA_CIDRS.join(","));

/** Judge one address (and the IPv4 address it carries, if any). */
function checkAddress(url: string, ip: string, cfg: DenyConfig): void {
  const candidates = [ip];
  const inner = embeddedIPv4(ip);
  if (inner) candidates.push(inner);
  for (const c of candidates) {
    for (const m of METADATA) if (ipInCidr(c, m)) throw new EgressBlockedError(url, ip, m.src);
  }
  if (cfg.disabled) return;
  if (candidates.some((c) => cfg.allow.some((a) => ipInCidr(c, a)))) return;
  for (const c of candidates) {
    for (const d of cfg.deny) if (ipInCidr(c, d)) throw new EgressBlockedError(url, ip, d.src);
  }
}

/**
 * Throw {@link EgressBlockedError} if `url`'s host resolves to an IP inside
 * the deny list (and not rescued by the allow list). Every address the name
 * resolves to is checked — `fetch` may connect to any of them — and a name
 * that doesn't resolve is blocked rather than waved through. Returns the
 * first resolved address, for logging.
 */
export async function assertEgressAllowed(url: string): Promise<{ ip: string; family: 4 | 6 } | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; /* let fetch fail naturally */ }

  // Don't enforce on non-network protocols — let fetch error out.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const cfg = await loadDenyConfig();

  // Resolve hostname → IPs. Literal-IP hostnames hit the same code path.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ ip: string; family: 4 | 6 }>;
  if (isIP(host)) {
    addresses = [{ ip: host, family: isIPv4(host) ? 4 : 6 }];
  } else {
    try {
      const all = await lookup(host, { all: true, verbatim: true });
      addresses = all.map((r) => ({ ip: r.address, family: r.family === 4 ? 4 : 6 }));
    } catch {
      // Fail closed: an unresolvable name can't be checked, and fetch may
      // resolve it differently a moment later.
      if (cfg.disabled) return null;
      throw new EgressBlockedError(url, "(unresolved)", "dns");
    }
  }
  if (addresses.length === 0) throw new EgressBlockedError(url, "(unresolved)", "dns");

  for (const a of addresses) checkAddress(url, a.ip, cfg);
  return addresses[0]!;
}

const MAX_REDIRECTS = 5;

/**
 * `fetch` with the egress check applied to the URL *and to every redirect
 * hop*. Following redirects inside `fetch` checked only the first URL, so a
 * public host could bounce the request to a private one. Redirects are
 * followed here by hand (up to 5) unless the caller asked for
 * `redirect: "manual"` / `"error"`.
 */
export async function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const first = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const follow = (init?.redirect ?? first.redirect) === "follow";
  let url = first.url;
  let method = first.method;
  let body: ArrayBuffer | null = first.body ? await first.arrayBuffer() : null;
  const headers = new Headers(first.headers);
  for (let hop = 0; ; hop++) {
    // HTTP(S) only. Bun's fetch also reads file:// URLs; a redirect from a
    // remote server to file:///… must never turn into a local file read.
    const proto = new URL(url).protocol;
    if (proto !== "http:" && proto !== "https:") {
      throw new EgressBlockedError(url, "(non-http)", `scheme ${proto}`);
    }
    await assertEgressAllowed(url);
    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: first.signal,
    });
    const location = res.headers.get("location");
    if (!follow || res.status < 300 || res.status > 399 || !location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error(`egress: too many redirects from ${first.url}`);
    const next = new URL(location, url);
    // Credentials don't follow a redirect to another origin (as in fetch's
    // own redirect handling).
    if (next.origin !== new URL(url).origin) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
    }
    url = next.toString();
    // 303 (and a POST answered 301/302) continues as a body-less GET.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = null;
      headers.delete("content-type");
      headers.delete("content-length");
    }
  }
}

/** Default-deny CIDR list — exposed for tests + docs. */
export function defaultDenyCidrs(): readonly string[] {
  return DEFAULT_DENY;
}
