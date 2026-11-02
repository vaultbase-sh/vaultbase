import { createHmac } from "node:crypto";

/** Hex HMAC-SHA256 of `data` under `key`, both as UTF-8. */
export function hmacSha256Hex(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}
