import * as jose from "jose";
import { getAllSettings } from "../api/settings.ts";

// ── Provider definitions ─────────────────────────────────────────────────────

export interface ProviderDef {
  name: string;
  displayName: string;
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  /** Fetch profile from the provider given an access_token; return a normalized shape. */
  fetchProfile(accessToken: string): Promise<NormalizedProfile>;
  /** Twitter / Apple need PKCE auto-engaged regardless of caller request. */
  requiresPkce?: boolean;
  /**
   * Apple is the odd one — its `client_secret` is a JWT signed locally with the
   * Apple-issued private key. Implementations return a fresh client_secret per
   * exchange. Other providers omit this hook and use the literal setting value.
   */
  buildClientSecret?: () => Promise<string>;
  /**
   * Apple returns the user identity inside the `id_token` JWT, not via a
   * userinfo endpoint. When set, exchangeCodeForToken hands the token-endpoint
   * response straight to this hook to extract the profile, skipping the usual
   * Bearer-token userinfo fetch.
   */
  fetchProfileFromTokenResponse?: (tokenResponse: Record<string, unknown>) => Promise<NormalizedProfile>;
  /**
   * OIDC's authorize / token / userinfo URLs come from settings, not constants —
   * resolve them on-demand at call sites that need the live values.
   */
  resolveDynamic?: () => { authorizeUrl: string; tokenUrl: string; userinfoUrl?: string };
}

export interface NormalizedProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

async function googleProfile(token: string): Promise<NormalizedProfile> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google userinfo failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const profile: NormalizedProfile = {
    id: String(j["sub"] ?? ""),
    email: String(j["email"] ?? ""),
    emailVerified: j["email_verified"] === true,
  };
  if (typeof j["name"] === "string") profile.name = j["name"];
  return profile;
}

async function githubProfile(token: string): Promise<NormalizedProfile> {
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!userRes.ok) throw new Error(`GitHub /user failed: ${userRes.status}`);
  const u = (await userRes.json()) as Record<string, unknown>;

  // /user.email may be null when private — fetch /user/emails for the verified primary.
  let email = typeof u["email"] === "string" ? (u["email"] as string) : "";
  let emailVerified = false;
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      if (primary) {
        email = primary.email;
        emailVerified = true;
      }
    }
  } else {
    // /user.email is only populated for the primary verified address per GitHub docs.
    emailVerified = true;
  }

  const profile: NormalizedProfile = {
    id: String(u["id"] ?? ""),
    email,
    emailVerified,
  };
  const nameVal = typeof u["name"] === "string" ? (u["name"] as string)
    : typeof u["login"] === "string" ? (u["login"] as string)
    : undefined;
  if (nameVal) profile.name = nameVal;
  return profile;
}

// ── Generic profile helpers used by the simpler providers ──────────────────

/** GET a JSON userinfo endpoint with a Bearer token, then map fields by key path. */
async function jsonProfile(
  url: string,
  token: string,
  fields: { id: string; email: string; emailVerified?: string; name?: string },
  extraHeaders: Record<string, string> = {}
): Promise<NormalizedProfile> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extraHeaders },
  });
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  // Allow simple dot paths like "data.0.email" for endpoints that wrap results
  const get = (path: string): unknown => path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    if (Array.isArray(acc)) return acc[Number(key)];
    return (acc as Record<string, unknown>)[key];
  }, j);
  const profile: NormalizedProfile = {
    id: String(get(fields.id) ?? ""),
    email: String(get(fields.email) ?? ""),
    emailVerified: fields.emailVerified ? get(fields.emailVerified) === true : false,
  };
  if (fields.name) {
    const n = get(fields.name);
    if (typeof n === "string") profile.name = n;
  }
  return profile;
}

async function gitlabProfile(token: string): Promise<NormalizedProfile> {
  return jsonProfile("https://gitlab.com/api/v4/user", token, {
    id: "id", email: "email", name: "name",
  });
}

async function facebookProfile(token: string): Promise<NormalizedProfile> {
  // Facebook returns email only when the user grants the "email" scope; verified flag isn't exposed.
  const res = await fetch(`https://graph.facebook.com/me?fields=id,email,name&access_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`Facebook /me failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const profile: NormalizedProfile = {
    id: String(j["id"] ?? ""),
    email: typeof j["email"] === "string" ? (j["email"] as string) : "",
    // Facebook doesn't expose email_verified; treat as verified since they require email confirmation themselves.
    emailVerified: typeof j["email"] === "string" && j["email"] !== "",
  };
  if (typeof j["name"] === "string") profile.name = j["name"];
  return profile;
}

async function microsoftProfile(token: string): Promise<NormalizedProfile> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Microsoft /me failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const email = typeof j["mail"] === "string" ? (j["mail"] as string)
    : typeof j["userPrincipalName"] === "string" ? (j["userPrincipalName"] as string)
    : "";
  const profile: NormalizedProfile = {
    id: String(j["id"] ?? ""),
    email,
    // Azure AD email is operationally verified by tenant admin; treat as verified.
    emailVerified: email !== "",
  };
  if (typeof j["displayName"] === "string") profile.name = j["displayName"];
  return profile;
}

async function discordProfile(token: string): Promise<NormalizedProfile> {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Discord /users/@me failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const profile: NormalizedProfile = {
    id: String(j["id"] ?? ""),
    email: typeof j["email"] === "string" ? (j["email"] as string) : "",
    emailVerified: j["verified"] === true,
  };
  if (typeof j["global_name"] === "string") profile.name = j["global_name"];
  else if (typeof j["username"] === "string") profile.name = j["username"];
  return profile;
}

async function twitchProfile(token: string): Promise<NormalizedProfile> {
  // Twitch requires Client-Id header alongside Bearer.
  const cfg = getProviderConfig("twitch");
  const res = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-Id": cfg.client_id,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Twitch /users failed: ${res.status}`);
  const j = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const u = j.data?.[0];
  if (!u) throw new Error("Twitch returned an empty user list");
  const profile: NormalizedProfile = {
    id: String(u["id"] ?? ""),
    email: typeof u["email"] === "string" ? (u["email"] as string) : "",
    emailVerified: typeof u["email"] === "string" && u["email"] !== "",
  };
  if (typeof u["display_name"] === "string") profile.name = u["display_name"];
  return profile;
}

async function spotifyProfile(token: string): Promise<NormalizedProfile> {
  return jsonProfile("https://api.spotify.com/v1/me", token, {
    id: "id", email: "email", name: "display_name",
  }).then((p) => ({ ...p, emailVerified: p.email !== "" }));
}

async function linkedinProfile(token: string): Promise<NormalizedProfile> {
  // LinkedIn moved to OIDC userinfo at /v2/userinfo (matches OpenID Connect shape).
  return jsonProfile("https://api.linkedin.com/v2/userinfo", token, {
    id: "sub", email: "email", emailVerified: "email_verified", name: "name",
  });
}

async function slackProfile(token: string): Promise<NormalizedProfile> {
  return jsonProfile("https://slack.com/api/openid.connect.userInfo", token, {
    id: "sub", email: "email", emailVerified: "email_verified", name: "name",
  });
}

async function bitbucketProfile(token: string): Promise<NormalizedProfile> {
  // /user has no email; need /user/emails for the verified primary.
  const userRes = await fetch("https://api.bitbucket.org/2.0/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!userRes.ok) throw new Error(`Bitbucket /user failed: ${userRes.status}`);
  const u = (await userRes.json()) as Record<string, unknown>;

  let email = "";
  let emailVerified = false;
  const emailRes = await fetch("https://api.bitbucket.org/2.0/user/emails", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (emailRes.ok) {
    const ej = (await emailRes.json()) as { values?: Array<{ email: string; is_primary: boolean; is_confirmed: boolean }> };
    const primary = ej.values?.find((e) => e.is_primary && e.is_confirmed) ?? ej.values?.find((e) => e.is_confirmed);
    if (primary) {
      email = primary.email;
      emailVerified = true;
    }
  }
  const profile: NormalizedProfile = {
    id: String(u["uuid"] ?? u["account_id"] ?? ""),
    email,
    emailVerified,
  };
  if (typeof u["display_name"] === "string") profile.name = u["display_name"];
  return profile;
}

async function notionProfile(token: string): Promise<NormalizedProfile> {
  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Notion /users/me failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const bot = j["bot"] as Record<string, unknown> | undefined;
  const owner = bot?.["owner"] as Record<string, unknown> | undefined;
  const ownerUser = owner?.["user"] as Record<string, unknown> | undefined;
  const person = ownerUser?.["person"] as Record<string, unknown> | undefined;
  const email = typeof person?.["email"] === "string" ? (person["email"] as string) : "";
  const profile: NormalizedProfile = {
    id: String(j["id"] ?? ""),
    email,
    emailVerified: email !== "",
  };
  if (typeof j["name"] === "string") profile.name = j["name"];
  return profile;
}

async function twitterProfile(token: string): Promise<NormalizedProfile> {
  const res = await fetch(
    "https://api.twitter.com/2/users/me?user.fields=id,username,name,profile_image_url",
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`Twitter /users/me failed: ${res.status}`);
  const j = (await res.json()) as { data?: Record<string, unknown> };
  const d = j.data ?? {};
  // Twitter's email is gated behind Elevated access; for the common case we
  // synthesize a stable, unique placeholder so user creation can still proceed.
  // The placeholder lives at @twitter.invalid (RFC 2606 reserved TLD).
  const username = typeof d["username"] === "string" ? (d["username"] as string) : "";
  const id = String(d["id"] ?? "");
  const profile: NormalizedProfile = {
    id,
    email: username ? `${username}@twitter.invalid` : `${id}@twitter.invalid`,
    // We can't claim verified — Twitter doesn't give us the email at all.
    emailVerified: false,
  };
  if (typeof d["name"] === "string") profile.name = d["name"];
  else if (username) profile.name = username;
  return profile;
}

async function oidcProfile(token: string): Promise<NormalizedProfile> {
  const cfg = getOidcConfig();
  if (!cfg.userinfo_url) throw new Error("OIDC userinfo URL is not configured");
  const res = await fetch(cfg.userinfo_url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OIDC userinfo failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const profile: NormalizedProfile = {
    id: String(j["sub"] ?? ""),
    email: typeof j["email"] === "string" ? (j["email"] as string) : "",
    emailVerified: j["email_verified"] === true,
  };
  if (typeof j["name"] === "string") profile.name = j["name"];
  return profile;
}

/**
 * Decode an `id_token` (JWT) payload without verifying its signature.
 * v1 trade-off: Apple's signing keys rotate via JWKS; we accept the IdP-issued
 * JWT at face value because it arrives over a TLS-protected back-channel
 * directly from Apple. TODO: switch to jwtVerify against the JWKS endpoint
 * (`https://appleid.apple.com/auth/keys`) when we can afford the dependency
 * footprint of remote key fetching + caching.
 */
function decodeIdTokenUnverified(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length < 2) throw new Error("Invalid id_token");
  const payload = parts[1]!;
  // base64url → base64 → JSON
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(payload.length + ((4 - payload.length % 4) % 4), "=");
  const json = atob(padded);
  return JSON.parse(json) as Record<string, unknown>;
}

async function appleProfileFromTokenResponse(
  tokenResponse: Record<string, unknown>
): Promise<NormalizedProfile> {
  const idToken = tokenResponse["id_token"];
  if (typeof idToken !== "string" || !idToken) {
    throw new Error("Apple did not return an id_token");
  }
  const claims = decodeIdTokenUnverified(idToken);
  const profile: NormalizedProfile = {
    id: String(claims["sub"] ?? ""),
    email: typeof claims["email"] === "string" ? (claims["email"] as string) : "",
    emailVerified: claims["email_verified"] === true || claims["email_verified"] === "true",
  };
  return profile;
}

// ── Apple-specific helpers ──────────────────────────────────────────────────

interface AppleConfig {
  client_id: string;
  team_id: string;
  key_id: string;
  private_key: string;
}

function getAppleConfig(): AppleConfig {
  const s = getAllSettings();
  return {
    client_id: s["oauth2.apple.client_id"] ?? "",
    team_id: s["oauth2.apple.team_id"] ?? "",
    key_id: s["oauth2.apple.key_id"] ?? "",
    private_key: s["oauth2.apple.private_key"] ?? "",
  };
}

interface AppleSecretCacheEntry {
  cacheKey: string;
  jwt: string;
  expiresAt: number;
}

let appleSecretCache: AppleSecretCacheEntry | null = null;
const APPLE_SECRET_TTL_MS = 14 * 60 * 1000; // 14 minutes (Apple max is 6 months but we re-sign defensively)

/**
 * Build the JWT Apple expects as `client_secret` on the token endpoint.
 * Header: alg=ES256, kid=<key_id>. Claims: iss=team_id, sub=client_id,
 * aud=https://appleid.apple.com, iat=now, exp=now+15min.
 *
 * The signed JWT is cached by (team_id, key_id, client_id) for 14 minutes so we
 * don't re-sign for every concurrent token exchange.
 */
export async function buildAppleClientSecret(): Promise<string> {
  const cfg = getAppleConfig();
  if (!cfg.client_id || !cfg.team_id || !cfg.key_id || !cfg.private_key) {
    throw new Error("Apple OAuth2 is not fully configured (need client_id, team_id, key_id, private_key)");
  }
  const cacheKey = `${cfg.team_id}|${cfg.key_id}|${cfg.client_id}`;
  const now = Date.now();
  if (appleSecretCache && appleSecretCache.cacheKey === cacheKey && appleSecretCache.expiresAt > now) {
    return appleSecretCache.jwt;
  }
  const privateKey = await jose.importPKCS8(cfg.private_key, "ES256");
  const iat = Math.floor(now / 1000);
  const exp = iat + 15 * 60;
  const jwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: cfg.key_id })
    .setIssuer(cfg.team_id)
    .setSubject(cfg.client_id)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
  appleSecretCache = { cacheKey, jwt, expiresAt: now + APPLE_SECRET_TTL_MS };
  return jwt;
}

/** Test-only — clears the in-memory client_secret cache. */
export function _clearAppleSecretCache(): void {
  appleSecretCache = null;
}

// ── OIDC-specific helpers ───────────────────────────────────────────────────

export interface OidcConfig {
  display_name: string;
  authorization_url: string;
  token_url: string;
  userinfo_url: string;
  scopes: string;
}

export function getOidcConfig(): OidcConfig {
  const s = getAllSettings();
  return {
    display_name: s["oauth2.oidc.display_name"] || "OIDC",
    authorization_url: s["oauth2.oidc.authorization_url"] ?? "",
    token_url: s["oauth2.oidc.token_url"] ?? "",
    userinfo_url: s["oauth2.oidc.userinfo_url"] ?? "",
    scopes: s["oauth2.oidc.scopes"] || "openid profile email",
  };
}

async function patreonProfile(token: string): Promise<NormalizedProfile> {
  const res = await fetch("https://www.patreon.com/api/oauth2/v2/identity?fields%5Buser%5D=email,full_name,is_email_verified", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Patreon /identity failed: ${res.status}`);
  const j = (await res.json()) as { data?: { id?: string; attributes?: Record<string, unknown> } };
  const a = j.data?.attributes ?? {};
  const profile: NormalizedProfile = {
    id: String(j.data?.id ?? ""),
    email: typeof a["email"] === "string" ? (a["email"] as string) : "",
    emailVerified: a["is_email_verified"] === true,
  };
  if (typeof a["full_name"] === "string") profile.name = a["full_name"];
  return profile;
}

export const PROVIDERS: Record<string, ProviderDef> = {
  google: {
    name: "google", displayName: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: ["openid", "email", "profile"],
    fetchProfile: googleProfile,
  },
  github: {
    name: "github", displayName: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["read:user", "user:email"],
    fetchProfile: githubProfile,
  },
  gitlab: {
    name: "gitlab", displayName: "GitLab",
    authorizeUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    defaultScopes: ["read_user"],
    fetchProfile: gitlabProfile,
  },
  facebook: {
    name: "facebook", displayName: "Facebook",
    authorizeUrl: "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v18.0/oauth/access_token",
    defaultScopes: ["email", "public_profile"],
    fetchProfile: facebookProfile,
  },
  microsoft: {
    name: "microsoft", displayName: "Microsoft",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    defaultScopes: ["openid", "email", "profile", "User.Read"],
    fetchProfile: microsoftProfile,
  },
  discord: {
    name: "discord", displayName: "Discord",
    authorizeUrl: "https://discord.com/api/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    defaultScopes: ["identify", "email"],
    fetchProfile: discordProfile,
  },
  twitch: {
    name: "twitch", displayName: "Twitch",
    authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
    tokenUrl: "https://id.twitch.tv/oauth2/token",
    defaultScopes: ["user:read:email"],
    fetchProfile: twitchProfile,
  },
  spotify: {
    name: "spotify", displayName: "Spotify",
    authorizeUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    defaultScopes: ["user-read-email", "user-read-private"],
    fetchProfile: spotifyProfile,
  },
  linkedin: {
    name: "linkedin", displayName: "LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    defaultScopes: ["openid", "email", "profile"],
    fetchProfile: linkedinProfile,
  },
  slack: {
    name: "slack", displayName: "Slack",
    authorizeUrl: "https://slack.com/openid/connect/authorize",
    tokenUrl: "https://slack.com/api/openid.connect.token",
    defaultScopes: ["openid", "email", "profile"],
    fetchProfile: slackProfile,
  },
  bitbucket: {
    name: "bitbucket", displayName: "Bitbucket",
    authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
    tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
    defaultScopes: ["account", "email"],
    fetchProfile: bitbucketProfile,
  },
  notion: {
    name: "notion", displayName: "Notion",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    defaultScopes: [],
    fetchProfile: notionProfile,
  },
  patreon: {
    name: "patreon", displayName: "Patreon",
    authorizeUrl: "https://www.patreon.com/oauth2/authorize",
    tokenUrl: "https://www.patreon.com/api/oauth2/token",
    defaultScopes: ["identity", "identity[email]"],
    fetchProfile: patreonProfile,
  },
  apple: {
    name: "apple", displayName: "Apple",
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    defaultScopes: ["name", "email"],
    // Apple delivers identity via id_token, so the userinfo path is unused.
    fetchProfile: async () => { throw new Error("Apple profile is read from id_token, not userinfo"); },
    fetchProfileFromTokenResponse: appleProfileFromTokenResponse,
    buildClientSecret: buildAppleClientSecret,
  },
  twitter: {
    name: "twitter", displayName: "Twitter / X",
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    defaultScopes: ["users.read", "tweet.read", "offline.access"],
    fetchProfile: twitterProfile,
    requiresPkce: true,
  },
  oidc: {
    name: "oidc", displayName: "OIDC",
    // Placeholder strings — OIDC reads its real URLs from settings via
    // `resolveDynamic()` at runtime. Anything that bypasses that hook (we don't)
    // would clearly fail loud against these `oidc:not-configured` markers.
    authorizeUrl: "https://oidc:not-configured/authorize",
    tokenUrl: "https://oidc:not-configured/token",
    defaultScopes: ["openid", "profile", "email"],
    fetchProfile: oidcProfile,
    resolveDynamic: () => {
      const cfg = getOidcConfig();
      const out: { authorizeUrl: string; tokenUrl: string; userinfoUrl?: string } = {
        authorizeUrl: cfg.authorization_url,
        tokenUrl: cfg.token_url,
      };
      if (cfg.userinfo_url) out.userinfoUrl = cfg.userinfo_url;
      return out;
    },
  },
};

// ── Settings helpers ─────────────────────────────────────────────────────────

export interface ProviderConfig {
  enabled: boolean;
  client_id: string;
  client_secret: string;
}

export function getProviderConfig(name: string): ProviderConfig {
  const s = getAllSettings();
  return {
    enabled: s[`oauth2.${name}.enabled`] === "1" || s[`oauth2.${name}.enabled`] === "true",
    client_id: s[`oauth2.${name}.client_id`] ?? "",
    client_secret: s[`oauth2.${name}.client_secret`] ?? "",
  };
}

export function isProviderEnabled(name: string): boolean {
  if (!PROVIDERS[name]) return false;
  const s = getAllSettings();
  const enabled = s[`oauth2.${name}.enabled`] === "1" || s[`oauth2.${name}.enabled`] === "true";
  if (!enabled) return false;
  // Apple: client_id (Services ID), team_id, key_id, private_key all required.
  if (name === "apple") {
    const a = getAppleConfig();
    return a.client_id !== "" && a.team_id !== "" && a.key_id !== "" && a.private_key !== "";
  }
  // OIDC: authorize/token URLs + client_id/secret required (userinfo_url checked at fetch time).
  if (name === "oidc") {
    const o = getOidcConfig();
    const c = getProviderConfig("oidc");
    return c.client_id !== "" && c.client_secret !== "" && o.authorization_url !== "" && o.token_url !== "";
  }
  // Everyone else: client_id + client_secret pair from the standard settings keys.
  const c = getProviderConfig(name);
  return c.client_id !== "" && c.client_secret !== "";
}

export function listEnabledProviders(): Array<{ name: string; displayName: string }> {
  return Object.values(PROVIDERS)
    .filter((p) => isProviderEnabled(p.name))
    .map((p) => {
      // OIDC's display name is admin-configurable.
      if (p.name === "oidc") {
        const o = getOidcConfig();
        return { name: p.name, displayName: o.display_name || p.displayName };
      }
      return { name: p.name, displayName: p.displayName };
    });
}

// ── PKCE (RFC 7636) ──────────────────────────────────────────────────────────

/** RFC 7636 unreserved set: ALPHA / DIGIT / "-" / "." / "_" / "~". */
const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** base64url-encode a byte buffer (no padding, URL-safe alphabet). */
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a cryptographically random PKCE `code_verifier`.
 *
 * RFC 7636 §4.1: `code_verifier = high-entropy cryptographic random STRING using
 * the unreserved characters [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
 * with a minimum length of 43 characters and a maximum length of 128 characters.`
 *
 * We default to 32 random bytes → base64url, which yields 43 chars.
 */
export function generateCodeVerifier(byteLength: number = 32): string {
  // Clamp so the output stays within RFC bounds (43..128 chars).
  // base64url length ≈ ceil(bytes * 4 / 3) without padding.
  const n = Math.max(32, Math.min(96, byteLength));
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

/**
 * Compute the PKCE `code_challenge` from a `code_verifier`.
 * Only S256 is implemented — `plain` is discouraged by RFC 7636 and we don't expose it.
 */
export async function codeChallengeFromVerifier(
  verifier: string,
  method: "S256" = "S256"
): Promise<string> {
  if (method !== "S256") throw new Error(`Unsupported code_challenge_method: ${method}`);
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Verify a verifier matches a previously-issued challenge. Returns false on any
 * mismatch (including length mismatch, charset mismatch, or hash mismatch).
 */
export async function verifyChallenge(verifier: string, challenge: string): Promise<boolean> {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  for (let i = 0; i < verifier.length; i++) {
    if (PKCE_CHARS.indexOf(verifier[i]!) === -1) return false;
  }
  const expected = await codeChallengeFromVerifier(verifier);
  // Constant-time compare on the hex of equal-length strings.
  if (expected.length !== challenge.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ challenge.charCodeAt(i);
  }
  return diff === 0;
}

// ── Authorize URL ────────────────────────────────────────────────────────────

/** True for providers that require PKCE be auto-engaged (e.g. Twitter). */
export function providerRequiresPkce(name: string): boolean {
  return PROVIDERS[name]?.requiresPkce === true;
}

export function buildAuthorizeUrl(opts: {
  provider: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
  /** PKCE — when set, appended as `code_challenge` + `code_challenge_method` (defaults to S256). */
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
}): string {
  const def = PROVIDERS[opts.provider];
  if (!def) throw new Error(`Unknown OAuth2 provider: ${opts.provider}`);
  if (!isProviderEnabled(opts.provider)) {
    throw new Error(`Provider '${opts.provider}' is not enabled`);
  }
  // client_id source differs for Apple (Services ID) and OIDC (its own setting block);
  // for everyone else it comes straight from oauth2.<name>.client_id.
  let clientId = "";
  if (opts.provider === "apple") clientId = getAppleConfig().client_id;
  else clientId = getProviderConfig(opts.provider).client_id;
  if (!clientId) throw new Error(`Provider '${opts.provider}' has no client_id configured`);

  // Resolve URL + default scopes — OIDC pulls these from settings.
  let authorizeUrl = def.authorizeUrl;
  let defaultScopes = def.defaultScopes;
  if (def.resolveDynamic) {
    const dyn = def.resolveDynamic();
    authorizeUrl = dyn.authorizeUrl;
    if (opts.provider === "oidc") {
      const cfg = getOidcConfig();
      defaultScopes = cfg.scopes.split(/\s+/).filter(Boolean);
    }
  }

  const scopes = opts.scopes && opts.scopes.length > 0 ? opts.scopes : defaultScopes;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state: opts.state,
  });
  // Apple requires `response_mode=form_post` and the special response_type.
  if (opts.provider === "apple") {
    params.set("response_type", "code id_token");
    params.set("response_mode", "form_post");
  }
  if (opts.codeChallenge) {
    params.set("code_challenge", opts.codeChallenge);
    params.set("code_challenge_method", opts.codeChallengeMethod ?? "S256");
  }
  return `${authorizeUrl}?${params.toString()}`;
}

// ── Code exchange ────────────────────────────────────────────────────────────

export async function exchangeCodeForToken(opts: {
  provider: string;
  code: string;
  redirectUri: string;
  /** PKCE — when set, sent to the IdP's token endpoint as `code_verifier`. */
  codeVerifier?: string;
}): Promise<{ access_token: string; raw: Record<string, unknown> }> {
  const def = PROVIDERS[opts.provider];
  if (!def) throw new Error(`Unknown OAuth2 provider: ${opts.provider}`);
  if (!isProviderEnabled(opts.provider)) {
    throw new Error(`Provider '${opts.provider}' is not enabled`);
  }

  // Resolve client_id / client_secret per provider. Apple signs a fresh JWT;
  // OIDC reads from oauth2.oidc.* which IS the standard provider config block.
  let clientId: string;
  let clientSecret: string;
  if (opts.provider === "apple") {
    const a = getAppleConfig();
    clientId = a.client_id;
    clientSecret = await buildAppleClientSecret();
  } else {
    const cfg = getProviderConfig(opts.provider);
    clientId = cfg.client_id;
    clientSecret = cfg.client_secret;
  }

  const tokenUrl = def.resolveDynamic ? def.resolveDynamic().tokenUrl : def.tokenUrl;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  if (opts.codeVerifier) body.set("code_verifier", opts.codeVerifier);
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${def.displayName} token exchange failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  // Apple returns no usable `access_token` for our purposes — the identity
  // lives in `id_token` instead. Synthesize the field so the caller's contract
  // (always have access_token) holds; it isn't used for any subsequent call.
  let accessToken = json["access_token"];
  if ((typeof accessToken !== "string" || !accessToken) && def.fetchProfileFromTokenResponse) {
    accessToken = "";
  }
  if (typeof accessToken !== "string") {
    throw new Error(`${def.displayName} did not return an access_token`);
  }
  if (!accessToken && !def.fetchProfileFromTokenResponse) {
    throw new Error(`${def.displayName} did not return an access_token`);
  }
  return { access_token: accessToken, raw: json };
}

export async function fetchProviderProfile(provider: string, accessToken: string): Promise<NormalizedProfile> {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth2 provider: ${provider}`);
  return def.fetchProfile(accessToken);
}

/**
 * Some IdPs (Apple) put the user identity inside the token-endpoint response
 * itself rather than at a userinfo URL. Callers that want a single function
 * for both modes should use this — it picks the right path per provider.
 */
export async function fetchProviderProfileFromExchange(
  provider: string,
  exchangeResult: { access_token: string; raw: Record<string, unknown> }
): Promise<NormalizedProfile> {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth2 provider: ${provider}`);
  if (def.fetchProfileFromTokenResponse) {
    return def.fetchProfileFromTokenResponse(exchangeResult.raw);
  }
  return def.fetchProfile(exchangeResult.access_token);
}
