/** RFC 5321 caps a forward path at 254 characters. */
export const MAX_EMAIL_LENGTH = 254;

// Each part is a run of characters that can't appear in the next separator, so
// the engine never has two ways to split the input: matching stays linear.
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Loose email shape check: something@host.tld, no whitespace, one `@`.
 * The length cap runs first so an oversized value never reaches the regex.
 */
export function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE_RE.test(value);
}
