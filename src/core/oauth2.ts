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
  const c = getProviderConfig(name);
  return c.enabled && c.client_id !== "" && c.client_secret !== "";
}

export function listEnabledProviders(): Array<{ name: string; displayName: string }> {
  return Object.values(PROVIDERS)
    .filter((p) => isProviderEnabled(p.name))
    .map((p) => ({ name: p.name, displayName: p.displayName }));
}

// ── Authorize URL ────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(opts: {
  provider: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const def = PROVIDERS[opts.provider];
  if (!def) throw new Error(`Unknown OAuth2 provider: ${opts.provider}`);
  const cfg = getProviderConfig(opts.provider);
  if (!cfg.enabled) throw new Error(`Provider '${opts.provider}' is not enabled`);
  if (!cfg.client_id) throw new Error(`Provider '${opts.provider}' has no client_id configured`);
  const scopes = opts.scopes && opts.scopes.length > 0 ? opts.scopes : def.defaultScopes;
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state: opts.state,
  });
  return `${def.authorizeUrl}?${params.toString()}`;
}

// ── Code exchange ────────────────────────────────────────────────────────────

export async function exchangeCodeForToken(opts: {
  provider: string;
  code: string;
  redirectUri: string;
}): Promise<{ access_token: string }> {
  const def = PROVIDERS[opts.provider];
  if (!def) throw new Error(`Unknown OAuth2 provider: ${opts.provider}`);
  const cfg = getProviderConfig(opts.provider);
  if (!cfg.enabled) throw new Error(`Provider '${opts.provider}' is not enabled`);
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(def.tokenUrl, {
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
  const accessToken = json["access_token"];
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error(`${def.displayName} did not return an access_token`);
  }
  return { access_token: accessToken };
}

export async function fetchProviderProfile(provider: string, accessToken: string): Promise<NormalizedProfile> {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth2 provider: ${provider}`);
  return def.fetchProfile(accessToken);
}
