import { getSetting } from "../api/settings.ts";

/**
 * Centralizes JWT lifetime resolution for every token kind Vaultbase issues.
 * Each site calls `tokenWindowSeconds(kind, fallback)` instead of hardcoding
 * a `setExpirationTime("7d")` literal — operators can tune any kind from
 * Settings without redeploying.
 *
 * Resolution order: settings value → fallback. Invalid / missing values
 * (non-integer, NaN, < 60s) silently fall back so a malformed admin entry
 * never breaks auth.
 *
 * Caps:
 *   - Soft minimum: 60s (one minute). Anything shorter is almost always a
 *     misconfiguration.
 *   - Hard maximum: 365 days. Tokens longer than a year are a privacy /
 *     security footgun without revocation infrastructure (see Redis
 *     brainstorm for revocation lists).
 */

export type TokenKind =
  | "admin"
  | "user"
  | "anonymous"
  | "impersonate"
  | "refresh"
  | "file";

const MIN_SECONDS = 60;                       // 1 minute
const MAX_SECONDS = 365 * 24 * 60 * 60;       // 365 days

/** Default lifetime per kind, in seconds. */
export const DEFAULT_WINDOWS: Record<TokenKind, number> = {
  admin:       7 * 24 * 60 * 60,    // 7d
  user:        7 * 24 * 60 * 60,    // 7d
  anonymous:  30 * 24 * 60 * 60,    // 30d
  impersonate:     60 * 60,         // 1h
  refresh:     7 * 24 * 60 * 60,    // 7d
  file:            60 * 60,         // 1h
};

function settingsKey(kind: TokenKind): string {
  return `auth.${kind}.window_seconds`;
}

/**
 * Resolve the configured window for `kind`. Falls back to `DEFAULT_WINDOWS`
 * when unset or malformed; clamps to [MIN, MAX].
 */
export function tokenWindowSeconds(kind: TokenKind): number {
  const fallback = DEFAULT_WINDOWS[kind];
  const raw = getSetting(settingsKey(kind), String(fallback));
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_SECONDS) return fallback;
  return Math.min(n, MAX_SECONDS);
}

/**
 * Validate a window value before persisting via the settings PATCH path.
 * Returns null on success or an error message on failure.
 */
export function validateWindowSeconds(value: unknown): string | null {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return "Window must be an integer number of seconds";
  if (n < MIN_SECONDS) return `Window must be at least ${MIN_SECONDS}s (1 minute)`;
  if (n > MAX_SECONDS) return `Window must be at most ${MAX_SECONDS}s (365 days)`;
  return null;
}

/** True if the given settings key is one of the auth window knobs we manage. */
export function isAuthWindowKey(key: string): boolean {
  if (!key.startsWith("auth.") || !key.endsWith(".window_seconds")) return false;
  const middle = key.slice("auth.".length, -".window_seconds".length);
  return middle in DEFAULT_WINDOWS;
}

/** Return all known auth-window settings keys. Useful for the admin UI. */
export function listAuthWindowKinds(): TokenKind[] {
  return Object.keys(DEFAULT_WINDOWS) as TokenKind[];
}

export const AUTH_WINDOW_BOUNDS = { MIN_SECONDS, MAX_SECONDS };
