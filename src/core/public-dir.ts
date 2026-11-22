/**
 * A public folder: static files (a built web app, a site) served from the
 * server's own root, so an app lives at `https://example.com/` instead of
 * under `/api/custom/...` and needs no proxy in front for it.
 *
 * Set up at deploy time, like the hooks folder: `vb_public/` next to the
 * data directory when it exists, or VAULTBASE_PUBLIC_DIR (`off` turns it
 * off). It is not a setting, so nothing written through the API can publish
 * a directory of the server.
 *
 * The folder answers only what no route answered: everything the server
 * serves itself (`/api/*`, the admin at `/_/*`, `/auth/*`, `/realtime`)
 * keeps priority, including paths under them that don't exist, which still
 * get the API's JSON 404.
 *
 * With VAULTBASE_PUBLIC_SPA=1, a page navigation (Accept: text/html) to a
 * path with no file and no extension gets the folder's `index.html`, so a
 * single-page app's client-side routes (`/contenders`) work on reload and as
 * links. Asset requests that miss still answer 404.
 *
 * Caching: file names with a content hash (`app.3f9c2b7e.js`,
 * `index-BkF3a9_x.css`, as bundlers write them) are immutable for a year;
 * everything else, HTML and the SPA fallback included, revalidates on every
 * use (Last-Modified / If-Modified-Since). A missed path is never cached.
 */
import { existsSync, realpathSync, statSync } from "fs";
import { dirname, extname, join, resolve, sep } from "path";

export interface PublicDirConfig {
  /** Absolute, resolved path of the folder. */
  dir: string;
  spa: boolean;
}

let current: PublicDirConfig | null = null;

/** Paths the server serves itself; a miss under them stays the API's 404. */
const RESERVED = ["/api", "/_", "/auth", "/realtime"];

export function isReservedPath(pathname: string): boolean {
  return RESERVED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Pick the public folder: VAULTBASE_PUBLIC_DIR ("off" disables; it must
 * exist), else `vb_public/` next to the data directory if it exists.
 * Throws when the folder is the data directory or holds it, or lies inside
 * the data directory or the hooks folder: serving it would publish the
 * database, the secrets or the server code.
 */
export function resolvePublicDir(
  dataDir: string,
  opts: { hooksDir?: string | null; env?: Record<string, string | undefined> } = {},
): PublicDirConfig | null {
  const env = opts.env ?? process.env;
  const set = env["VAULTBASE_PUBLIC_DIR"];
  if (set === "off") return null;
  let dir: string;
  if (set) {
    dir = resolve(set);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`VAULTBASE_PUBLIC_DIR ${dir} is not a folder`);
    }
  } else {
    dir = join(dirname(resolve(dataDir)), "vb_public");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  }
  const real = realpathSync(dir);
  const guard = (other: string | null | undefined, what: string) => {
    if (!other || !existsSync(other)) return;
    const o = realpathSync(other);
    if (real === o || o.startsWith(real + sep) || real.startsWith(o + sep)) {
      throw new Error(`the public folder ${real} overlaps the ${what} (${o}); pick a folder of its own`);
    }
  };
  guard(dataDir, "data directory");
  guard(opts.hooksDir, "hooks folder");
  return { dir: real, spa: env["VAULTBASE_PUBLIC_SPA"] === "1" || env["VAULTBASE_PUBLIC_SPA"] === "true" };
}

export function setPublicDir(cfg: PublicDirConfig | null): void {
  current = cfg;
}

export function publicDir(): PublicDirConfig | null {
  return current;
}

/** A bundler's content hash in the name: `name.<hash>.ext` or `name-<hash>.ext`. */
const HASHED = /[.-][A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$/;

function hasDigitAndLetter(s: string): boolean {
  return /\d/.test(s) && /[A-Za-z]/.test(s);
}

function isHashedName(name: string): boolean {
  const m = HASHED.exec(name);
  if (!m) return false;
  const hash = m[0].slice(1, m[0].lastIndexOf("."));
  return hasDigitAndLetter(hash);
}

/** The file for a request path inside `root`, or null. Refuses dotfiles, traversal and symlinks out. */
function fileFor(root: string, pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes(":")) return null;
  const parts = decoded.split("/").filter((p) => p !== "");
  // `..` and every dotfile (.env, .git, .htpasswd) are refused, not resolved.
  // `/.well-known/` at the top is the exception: it holds files meant to be
  // public (app links, security.txt).
  if (parts.some((p, i) => p.startsWith(".") && !(i === 0 && p === ".well-known" && parts.length > 1))) return null;
  let path = join(root, ...parts);
  let st;
  try { st = statSync(path); } catch { return null; }
  if (st.isDirectory()) {
    path = join(path, "index.html");
    try { st = statSync(path); } catch { return null; }
  }
  if (!st.isFile()) return null;
  // A symlink may point outside the folder: what it resolves to must be inside.
  let real: string;
  try { real = realpathSync(path); } catch { return null; }
  if (real !== root && !real.startsWith(root + sep)) return null;
  return real;
}

function respond(request: Request, path: string, cacheControl: string): Response {
  const file = Bun.file(path);
  const mtime = statSync(path).mtime;
  mtime.setMilliseconds(0);
  const headers = new Headers({
    "Cache-Control": cacheControl,
    "Last-Modified": mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
  });
  const since = request.headers.get("if-modified-since");
  if (since) {
    const t = Date.parse(since);
    if (Number.isFinite(t) && mtime.getTime() <= t) return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Type", file.type || "application/octet-stream");
  headers.set("Content-Length", String(file.size));
  return new Response(request.method === "HEAD" ? null : file, { status: 200, headers });
}

/**
 * The public folder's answer to a request no route matched, or null to
 * leave it to the 404.
 */
export function servePublic(request: Request): Response | null {
  const cfg = current;
  if (!cfg) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname } = new URL(request.url);
  if (isReservedPath(pathname)) return null;
  const path = fileFor(cfg.dir, pathname);
  if (path) {
    const name = path.slice(path.lastIndexOf(sep) + 1);
    const cache = !name.endsWith(".html") && isHashedName(name) ? "public, max-age=31536000, immutable" : "no-cache";
    return respond(request, path, cache);
  }
  if (cfg.spa && extname(pathname) === "" && (request.headers.get("accept") ?? "").includes("text/html")) {
    const index = fileFor(cfg.dir, "/index.html");
    if (index) return respond(request, index, "no-cache");
  }
  return null;
}
