import Elysia from "elysia";
import { join } from "path";
import { embedAdminFiles } from "./embed.ts" with { type: "macro" };

// EMBEDDED is a literal object inlined by the macro at compile time.
// Maps "index.html" / "assets/index-XYZ.js" → base64 content.
const EMBEDDED: Record<string, string> = embedAdminFiles();
const HAS_EMBEDDED = Object.keys(EMBEDDED).length > 0;

const MIME_TYPES: Record<string, string> = {
  ".html":  "text/html; charset=utf-8",
  ".js":    "application/javascript; charset=utf-8",
  ".mjs":   "application/javascript; charset=utf-8",
  ".css":   "text/css; charset=utf-8",
  ".json":  "application/json; charset=utf-8",
  ".svg":   "image/svg+xml",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".gif":   "image/gif",
  ".ico":   "image/x-icon",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".ttf":   "font/ttf",
  ".map":   "application/json",
};

function mimeType(path: string): string {
  const ext = path.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function decodeFile(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function makeAdminPlugin() {
  const distDir = join(import.meta.dir, "../../admin/dist");

  return new Elysia({ name: "admin-ui" }).get("/_/*", async ({ request, set }) => {
    const url = new URL(request.url);
    let pathname = url.pathname.replace(/^\/_\//, "");
    if (pathname === "" || pathname.endsWith("/")) pathname += "index.html";

    // 1) Serve from embedded files (compiled binary)
    if (HAS_EMBEDDED) {
      const key = EMBEDDED[pathname] ? pathname : "index.html";
      const b64 = EMBEDDED[key];
      if (!b64) { set.status = 404; return "Not found"; }
      set.headers["Content-Type"] = mimeType(key);
      return new Response(decodeFile(b64));
    }

    // 2) Dev mode: serve from filesystem
    const filePath = join(distDir, pathname);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    const index = Bun.file(join(distDir, "index.html"));
    if (await index.exists()) {
      return new Response(index, { headers: { "Content-Type": "text/html" } });
    }

    set.status = 404;
    return "Admin UI not built. Run: bun run build:admin";
  });
}
