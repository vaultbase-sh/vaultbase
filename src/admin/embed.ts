/**
 * Bun macro: scans admin/dist at compile time, gzip-compresses each file,
 * and returns a base64-encoded map. Result is inlined into the binary.
 *
 * Saves ~70% on text assets (HTML/JS/CSS) vs raw base64.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { gzipSync } from "zlib";

export function embedAdminFiles(): Record<string, string> {
  const distDir = join(import.meta.dir, "../../admin/dist");
  if (!existsSync(distDir)) return {};

  const files: Record<string, string> = {};
  walk(distDir, "", files);
  return files;
}

function walk(dir: string, prefix: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = prefix + entry.name;
    if (entry.isDirectory()) {
      walk(full, rel + "/", out);
    } else {
      const buf = readFileSync(full);
      const compressed = gzipSync(buf, { level: 9 });
      out[rel] = compressed.toString("base64");
    }
  }
}
