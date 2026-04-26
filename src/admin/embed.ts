/**
 * Bun macro: scans admin/dist at compile time and returns
 * a base64-encoded map of all files. Result is inlined into the binary.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

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
      out[rel] = buf.toString("base64");
    }
  }
}
