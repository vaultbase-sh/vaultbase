/**
 * Bun macro: scans admin/dist at compile time, gzip-compresses each file,
 * and returns a base64-encoded map. Result is inlined into the binary.
 *
 * Saves ~70% on text assets (HTML/JS/CSS) vs raw base64.
 *
 * Path resolution: tries `<source-relative>/../../admin/dist` first, then
 * `<cwd>/admin/dist` as a fallback. Either should work — the fallback covers
 * any quirk where Bun macros resolve `import.meta.dir` differently than
 * runtime expects.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { gzipSync } from "zlib";

export function embedAdminFiles(): Record<string, string> {
  const candidates = [
    join(import.meta.dir, "../../admin/dist"),
    resolve(process.cwd(), "admin/dist"),
  ];

  let distDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(c) && existsSync(join(c, "index.html"))) {
      distDir = c;
      break;
    }
  }

  if (!distDir) {
    process.stderr.write(
      `[embed-admin] WARNING: admin/dist not found. Tried:\n` +
      candidates.map((c) => `  - ${c}\n`).join("") +
      `Binary will serve "Admin UI not built" at /_/.\n` +
      `Run \`bun run build:admin\` before \`bun build --compile\`.\n`,
    );
    return {};
  }

  const files: Record<string, string> = {};
  walk(distDir, "", files);
  process.stderr.write(`[embed-admin] embedded ${Object.keys(files).length} files from ${distDir}\n`);
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
