/**
 * Configurable password policy. Driven by settings under `password.*`:
 *
 *   - `password.min_length`     (default 12)
 *   - `password.require_upper`  ("1"/"0", default "0")
 *   - `password.require_lower`  ("1"/"0", default "0")
 *   - `password.require_digit`  ("1"/"0", default "0")
 *   - `password.require_symbol` ("1"/"0", default "0")
 *   - `password.hibp_check`     ("1"/"0", default "0") — k-anonymity check
 *                               against api.pwnedpasswords.com (SHA-1 prefix).
 *
 * `validatePassword(pw)` returns null on pass, or an error message on fail.
 * The first failing check wins — we don't aggregate, since users typically
 * fix one rule at a time.
 *
 * The HIBP check fails open: if the lookup errors out (network down, API
 * blocked), the password is accepted rather than locking signups. This
 * matches the ergonomic of every other implementation that ships HIBP as
 * a soft signal — operators who want it hard-required should pin against
 * a self-hosted mirror.
 */
import { getSetting } from "../api/settings.ts";

export interface PasswordPolicy {
  min_length: number;
  require_upper: boolean;
  require_lower: boolean;
  require_digit: boolean;
  require_symbol: boolean;
  hibp_check: boolean;
}

export function getPasswordPolicy(): PasswordPolicy {
  return {
    min_length: Math.max(8, Number.parseInt(getSetting("password.min_length", "12"), 10) || 12),
    require_upper:  getSetting("password.require_upper", "0")  === "1",
    require_lower:  getSetting("password.require_lower", "0")  === "1",
    require_digit:  getSetting("password.require_digit", "0")  === "1",
    require_symbol: getSetting("password.require_symbol", "0") === "1",
    hibp_check:     getSetting("password.hibp_check", "0")     === "1",
  };
}

const SYMBOL_REGEX = /[^\p{L}\p{N}]/u;

export async function validatePassword(plaintext: string): Promise<string | null> {
  if (typeof plaintext !== "string") return "Password is required";
  const p = getPasswordPolicy();
  if (plaintext.length < p.min_length) {
    return `Password must be at least ${p.min_length} characters`;
  }
  if (p.require_upper && !/\p{Lu}/u.test(plaintext)) {
    return "Password must contain at least one uppercase letter";
  }
  if (p.require_lower && !/\p{Ll}/u.test(plaintext)) {
    return "Password must contain at least one lowercase letter";
  }
  if (p.require_digit && !/\p{N}/u.test(plaintext)) {
    return "Password must contain at least one digit";
  }
  if (p.require_symbol && !SYMBOL_REGEX.test(plaintext)) {
    return "Password must contain at least one symbol";
  }
  if (p.hibp_check) {
    const breached = await checkHibp(plaintext).catch(() => false);
    if (breached) {
      return "Password appears in a known data breach. Pick a different one.";
    }
  }
  return null;
}

/** SHA-1 hex of a UTF-8 string, uppercase. WebCrypto is available everywhere. */
async function sha1Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * k-anonymity HIBP lookup. Sends only the first 5 hex characters of the
 * SHA-1 hash; the API returns every suffix that begins with those 5
 * characters along with the breach count. We scan locally for the rest.
 */
async function checkHibp(plaintext: string): Promise<boolean> {
  const hash = await sha1Hex(plaintext);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return false;
  const body = await res.text();
  for (const line of body.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim() === suffix) return true;
  }
  return false;
}
