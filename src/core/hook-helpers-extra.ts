/**
 * Extra hook helper namespaces — phase 2 of PocketBase JSVM parity
 * (`docs/pocketbase-gap-analysis.md` §1.9).
 *
 * Wired into `makeHookHelpers` in `core/hooks.ts`. Hook authors are admins
 * (only admins can write hooks), so these run with admin trust — but each
 * namespace still validates inputs and applies sensible bounds (recursion,
 * timeouts, body sizes) to prevent footguns from typos.
 */
import * as jose from "jose";

// ── security ────────────────────────────────────────────────────────────────

export interface SecurityHelpers {
  /** Hex SHA-256/SHA-384/SHA-512 of UTF-8 string or bytes. */
  hash(alg: "sha256" | "sha384" | "sha512", data: string | Uint8Array): Promise<string>;
  /** Hex HMAC of `data` with `key` using SHA-256/384/512. */
  hmac(
    alg: "sha256" | "sha384" | "sha512",
    key: string | Uint8Array,
    data: string | Uint8Array
  ): Promise<string>;
  /** Random hex string of `byteLen` bytes (output is `byteLen*2` hex chars). */
  randomString(byteLen: number, alphabet?: "hex" | "base64url"): string;
  /** Random byte buffer. */
  randomBytes(len: number): Uint8Array;
  /** Sign a JWT (HS256). `expiresIn` accepts seconds or a string like "1h", "7d". */
  jwtSign(
    payload: Record<string, unknown>,
    secret: string,
    opts?: { expiresIn?: number | string; issuer?: string; audience?: string }
  ): Promise<string>;
  /** Verify a JWT (HS256). Throws on invalid/expired/bad-signature. */
  jwtVerify(
    token: string,
    secret: string,
    opts?: { issuer?: string; audience?: string }
  ): Promise<Record<string, unknown>>;
  /** Encrypt with the server-configured AES-GCM key (uses VAULTBASE_ENCRYPTION_KEY). */
  aesEncrypt(plaintext: string): Promise<string>;
  /** Decrypt a value previously produced by `aesEncrypt`. */
  aesDecrypt(ciphertext: string): Promise<string>;
  /** Length-safe constant-time string compare. */
  constantTimeEqual(a: string, b: string): boolean;
}

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? new TextEncoder().encode(v) : v;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function algToHash(alg: "sha256" | "sha384" | "sha512"): "SHA-256" | "SHA-384" | "SHA-512" {
  return alg === "sha256" ? "SHA-256" : alg === "sha384" ? "SHA-384" : "SHA-512";
}

function parseDuration(d: string | number): number {
  if (typeof d === "number") return d;
  const m = /^(\d+)\s*([smhdw])?$/.exec(d.trim());
  if (!m) throw new Error(`invalid duration: ${d}`);
  const n = parseInt(m[1]!, 10);
  const unit = m[2] ?? "s";
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 604800;
  return n * mult;
}

function makeSecurity(): SecurityHelpers {
  return {
    async hash(alg, data) {
      const buf = await crypto.subtle.digest(algToHash(alg), toBytes(data) as unknown as ArrayBuffer);
      return toHex(new Uint8Array(buf));
    },
    async hmac(alg, key, data) {
      const k = await crypto.subtle.importKey(
        "raw",
        toBytes(key) as unknown as ArrayBuffer,
        { name: "HMAC", hash: algToHash(alg) },
        false,
        ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", k, toBytes(data) as unknown as ArrayBuffer);
      return toHex(new Uint8Array(sig));
    },
    randomString(byteLen, alphabet = "hex") {
      if (byteLen <= 0 || byteLen > 1024) throw new Error("byteLen must be 1..1024");
      const buf = crypto.getRandomValues(new Uint8Array(byteLen));
      return alphabet === "base64url" ? toBase64Url(buf) : toHex(buf);
    },
    randomBytes(len) {
      if (len <= 0 || len > 4096) throw new Error("len must be 1..4096");
      return crypto.getRandomValues(new Uint8Array(len));
    },
    async jwtSign(payload, secret, opts = {}) {
      const key = new TextEncoder().encode(secret);
      let builder = new jose.SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
      if (opts.expiresIn !== undefined) {
        const exp = Math.floor(Date.now() / 1000) + parseDuration(opts.expiresIn);
        builder = builder.setExpirationTime(exp);
      }
      if (opts.issuer) builder = builder.setIssuer(opts.issuer);
      if (opts.audience) builder = builder.setAudience(opts.audience);
      return builder.sign(key);
    },
    async jwtVerify(token, secret, opts = {}) {
      const key = new TextEncoder().encode(secret);
      const verifyOpts: jose.JWTVerifyOptions = { algorithms: ["HS256"] };
      if (opts.issuer) verifyOpts.issuer = opts.issuer;
      if (opts.audience) verifyOpts.audience = opts.audience;
      const { payload } = await jose.jwtVerify(token, key, verifyOpts);
      return payload as Record<string, unknown>;
    },
    async aesEncrypt(plaintext) {
      const { encryptValue } = await import("./encryption.ts");
      return encryptValue(plaintext);
    },
    async aesDecrypt(ciphertext) {
      const { decryptValue } = await import("./encryption.ts");
      return decryptValue(ciphertext);
    },
    constantTimeEqual(a, b) {
      if (a.length !== b.length) return false;
      let r = 0;
      for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return r === 0;
    },
  };
}

// ── path ────────────────────────────────────────────────────────────────────

export interface PathHelpers {
  /** Join path segments using forward slashes; collapses redundant slashes. */
  join(...parts: string[]): string;
  /** Last segment of the path (without trailing slash). */
  basename(p: string, ext?: string): string;
  /** Directory portion of the path. */
  dirname(p: string): string;
  /** Extension including the leading dot, or "" if none. */
  ext(p: string): string;
  /** Normalize `.` and `..` segments. */
  normalize(p: string): string;
}

function makePath(): PathHelpers {
  const sep = "/";
  function normalize(p: string): string {
    const isAbs = p.startsWith("/");
    const parts = p.split(/[\\/]+/).filter(Boolean);
    const out: string[] = [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!isAbs) out.push(".."); continue; }
      out.push(part);
    }
    const joined = out.join(sep);
    return isAbs ? "/" + joined : joined || ".";
  }
  return {
    join(...parts) {
      return normalize(parts.filter((p) => typeof p === "string" && p.length).join(sep));
    },
    basename(p, ext) {
      const norm = normalize(p);
      const last = norm.split(sep).pop() ?? "";
      if (ext && last.endsWith(ext)) return last.slice(0, -ext.length);
      return last;
    },
    dirname(p) {
      const norm = normalize(p);
      const i = norm.lastIndexOf(sep);
      if (i === -1) return ".";
      if (i === 0) return "/";
      return norm.slice(0, i);
    },
    ext(p) {
      const base = p.split(/[\\/]/).pop() ?? "";
      const i = base.lastIndexOf(".");
      if (i <= 0) return "";
      return base.slice(i);
    },
    normalize,
  };
}

// ── template ────────────────────────────────────────────────────────────────

export interface TemplateHelpers {
  /**
   * Render a string with `{{var}}` substitution and `{{#if x}}…{{/if}}` blocks.
   * Variables resolve via dotted paths against `vars`. HTML is NOT escaped — use
   * `escapeHtml` explicitly if you're rendering into an HTML context.
   */
  render(template: string, vars: Record<string, unknown>): string;
  /** HTML-escape `&`, `<`, `>`, `"`, `'`. */
  escapeHtml(s: string): string;
}

function resolvePath(vars: Record<string, unknown>, path: string): unknown {
  let v: unknown = vars;
  for (const part of path.split(".")) {
    if (v == null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function makeTemplate(): TemplateHelpers {
  return {
    render(template, vars) {
      // First pass: handle {{#if path}}...{{/if}} (no nesting in v1).
      const ifBlock = /\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
      let out = template.replace(ifBlock, (_m, path: string, body: string) =>
        isTruthy(resolvePath(vars, path)) ? body : ""
      );
      // Second pass: handle {{path}} substitutions.
      out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
        const v = resolvePath(vars, path);
        return v === undefined || v === null ? "" : String(v);
      });
      return out;
    },
    escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },
  };
}

// ── http ────────────────────────────────────────────────────────────────────

export interface HttpRequestOpts {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
  body?: string | Uint8Array | Record<string, unknown> | null;
  /** Auto-set Content-Type: application/json and JSON-encode an object body. Default true. */
  json?: boolean;
  /** Total tries (incl. first). Default 1. Retries fire on network errors and 5xx/429. */
  retries?: number;
  /** Initial delay between retries in ms. Default 250. Doubles each attempt. */
  retryDelayMs?: number;
  /** Per-attempt timeout in ms. Default 30000. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** UTF-8 decoded body. */
  text: string;
  /** Parsed JSON, or undefined if body wasn't JSON. */
  json?: unknown;
}

export interface HttpHelpers {
  /** Outbound HTTP with retries + timeout + JSON convenience. */
  request(opts: HttpRequestOpts): Promise<HttpResponse>;
  /** Convenience: GET + JSON parse. */
  getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
  /** Convenience: POST JSON + parse JSON response. */
  postJson<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpOnce(opts: HttpRequestOpts, timeoutMs: number): Promise<Response> {
  // SSRF guard (N-2): refuse to issue the request when the resolved host
  // falls into a denylisted CIDR (default: RFC1918 + link-local +
  // loopback + IPv6 unique-local). Throws EgressBlockedError on deny so
  // the caller's retry loop in `request()` does not silently swallow the
  // block (we re-throw without retrying — see request() below). Settings
  // override via `hooks.http.deny` / `hooks.http.allow` /
  // `hooks.http.deny = "off"`. See core/hook-egress.ts.
  const { assertEgressAllowed } = await import("./hook-egress.ts");
  await assertEgressAllowed(opts.url);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: string | Uint8Array | undefined;
    if (opts.body != null) {
      if (typeof opts.body === "string" || opts.body instanceof Uint8Array) {
        body = opts.body;
      } else if (opts.json !== false) {
        body = JSON.stringify(opts.body);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      } else {
        body = String(opts.body);
      }
    }
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
      signal: ctrl.signal,
    };
    if (body !== undefined) init.body = body as unknown as RequestInit["body"];
    return await fetch(opts.url, init);
  } finally {
    clearTimeout(t);
  }
}

function makeHttp(): HttpHelpers {
  async function request(opts: HttpRequestOpts): Promise<HttpResponse> {
    const tries = Math.max(1, Math.min(10, opts.retries ?? 1));
    const initialDelay = Math.max(0, opts.retryDelayMs ?? 250);
    const timeoutMs = Math.max(100, opts.timeoutMs ?? 30000);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const res = await httpOnce(opts, timeoutMs);
        if (res.status >= 500 || res.status === 429) {
          if (attempt < tries) {
            await sleepMs(initialDelay * 2 ** (attempt - 1));
            continue;
          }
        }
        const text = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        const ct = res.headers.get("content-type") ?? "";
        let parsed: unknown;
        if (ct.includes("application/json") && text.length) {
          try { parsed = JSON.parse(text); } catch { /* leave undefined */ }
        }
        const out: HttpResponse = { status: res.status, ok: res.ok, headers, text };
        if (parsed !== undefined) out.json = parsed;
        return out;
      } catch (e) {
        // Egress block is a permanent decision — never retry.
        if (e instanceof Error && e.name === "EgressBlockedError") throw e;
        lastErr = e;
        if (attempt < tries) await sleepMs(initialDelay * 2 ** (attempt - 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  return {
    request,
    async getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
      const r = await request(headers ? { url, headers } : { url });
      if (!r.ok) throw new Error(`GET ${url} failed: ${r.status}`);
      if (r.json === undefined) throw new Error(`GET ${url} did not return JSON`);
      return r.json as T;
    },
    async postJson<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      const opts: HttpRequestOpts = {
        url,
        method: "POST",
        body: body as Record<string, unknown>,
      };
      if (headers) opts.headers = headers;
      const r = await request(opts);
      if (!r.ok) throw new Error(`POST ${url} failed: ${r.status}`);
      if (r.json === undefined) throw new Error(`POST ${url} did not return JSON`);
      return r.json as T;
    },
  };
}

// ── util ────────────────────────────────────────────────────────────────────

export interface UtilHelpers {
  /** Promise that resolves after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  /** Safe JSON.parse — returns `null` on invalid input rather than throwing. */
  unmarshal<T = unknown>(s: string): T | null;
  /** Read a `ReadableStream<Uint8Array>` to a UTF-8 string. */
  readerToString(reader: ReadableStream<Uint8Array> | Response): Promise<string>;
}

function makeUtil(): UtilHelpers {
  return {
    sleep(ms) {
      const clamped = Math.max(0, Math.min(60_000, ms));
      return sleepMs(clamped);
    },
    unmarshal<T>(s: string): T | null {
      try { return JSON.parse(s) as T; } catch { return null; }
    },
    async readerToString(input) {
      if (input instanceof Response) return input.text();
      const dec = new TextDecoder();
      const reader = input.getReader();
      let out = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
      }
      out += dec.decode();
      return out;
    },
  };
}

// ── db ──────────────────────────────────────────────────────────────────────

export interface DbHelpers {
  /**
   * Run a SELECT and return rows. `params` are bound positionally as `?` or
   * by name as `:name` / `$name` / `@name` per `bun:sqlite` semantics.
   */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** Single-row variant of {@link query}; returns `null` if no rows. */
  queryOne<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null;
  /** Run INSERT / UPDATE / DELETE. Returns rows-changed count + lastInsertRowid. */
  exec(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /** Run multiple statements at once (no parameters). For migrations only. */
  execMulti(sql: string): void;
}

function makeDb(): DbHelpers {
  function loadClient() {
    // Lazy-load to avoid breaking builds that import this module before DB init
    // (e.g. CLI scripts that build helpers in isolation).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../db/client.ts").getRawClient() as import("bun:sqlite").Database;
  }
  function flatten(params: unknown[]): unknown[] {
    if (params.length === 1 && params[0] !== null && typeof params[0] === "object" && !Array.isArray(params[0]) && !(params[0] instanceof Uint8Array)) {
      return [params[0]];
    }
    return params;
  }
  return {
    query<T>(sql: string, ...params: unknown[]): T[] {
      const stmt = loadClient().query(sql);
      return stmt.all(...(flatten(params) as never[])) as T[];
    },
    queryOne<T>(sql: string, ...params: unknown[]): T | null {
      const stmt = loadClient().query(sql);
      const row = stmt.get(...(flatten(params) as never[]));
      return (row ?? null) as T | null;
    },
    exec(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
      const stmt = loadClient().query(sql);
      const r = stmt.run(...(flatten(params) as never[]));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    execMulti(sql: string): void {
      loadClient().exec(sql);
    },
  };
}

// ── fs ──────────────────────────────────────────────────────────────────────

export interface FsStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  /** Last-modified time in unix seconds. */
  mtime: number;
}

export interface FsHelpers {
  /** Read a file as UTF-8 text. */
  read(path: string): Promise<string>;
  /** Read a file as raw bytes. */
  readBytes(path: string): Promise<Uint8Array>;
  /** Write a file (overwrites if exists). Creates parent dir if missing. */
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** Append to a file (creates if missing). */
  append(path: string, data: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  /** List directory entries (names only, sorted). */
  list(dir: string): Promise<string[]>;
  /** Make directory; recursive=true creates parents. */
  mkdir(dir: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Delete a file or empty directory. Use `recursive: true` for non-empty dirs. */
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Copy a file (not directories). */
  copy(src: string, dst: string): Promise<void>;
  /** Best-effort MIME type guess from extension; returns "application/octet-stream" if unknown. */
  mimeOf(path: string): string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function makeFs(): FsHelpers {
  async function loadFs() {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    return { fs, path };
  }
  return {
    async read(p) {
      const { fs } = await loadFs();
      return fs.readFile(p, "utf-8");
    },
    async readBytes(p) {
      const { fs } = await loadFs();
      const buf = await fs.readFile(p);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async write(p, data) {
      const { fs, path } = await loadFs();
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, data as Uint8Array | string);
    },
    async append(p, data) {
      const { fs, path } = await loadFs();
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.appendFile(p, data as Uint8Array | string);
    },
    async exists(p) {
      const { fs } = await loadFs();
      try { await fs.access(p); return true; } catch { return false; }
    },
    async stat(p) {
      const { fs } = await loadFs();
      const s = await fs.stat(p);
      return {
        size: s.size,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        mtime: Math.floor(s.mtimeMs / 1000),
      };
    },
    async list(dir) {
      const { fs } = await loadFs();
      const entries = await fs.readdir(dir);
      return entries.sort();
    },
    async mkdir(dir, opts = {}) {
      const { fs } = await loadFs();
      await fs.mkdir(dir, { recursive: opts.recursive ?? false });
    },
    async remove(p, opts = {}) {
      const { fs } = await loadFs();
      await fs.rm(p, { recursive: opts.recursive ?? false, force: true });
    },
    async copy(src, dst) {
      const { fs, path } = await loadFs();
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    },
    mimeOf(p) {
      const i = p.lastIndexOf(".");
      if (i < 0) return "application/octet-stream";
      const ext = p.slice(i).toLowerCase();
      return MIME_BY_EXT[ext] ?? "application/octet-stream";
    },
  };
}

// ── os ──────────────────────────────────────────────────────────────────────

export interface OsHelpers {
  /** Read an environment variable. Returns "" if unset. */
  env(name: string): string;
  /** Process current working directory. */
  cwd(): string;
  /** "linux" | "darwin" | "win32" | "freebsd" | … */
  platform(): string;
  /** "x64" | "arm64" | … */
  arch(): string;
  hostname(): string;
}

function makeOs(): OsHelpers {
  return {
    env(name) {
      return process.env[name] ?? "";
    },
    cwd() {
      return process.cwd();
    },
    platform() {
      return process.platform;
    },
    arch() {
      return process.arch;
    },
    hostname() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return (require("node:os") as { hostname: () => string }).hostname();
      } catch {
        return "";
      }
    },
  };
}

// ── mails ───────────────────────────────────────────────────────────────────

export interface MailAttachment {
  filename: string;
  /** UTF-8 string or raw bytes. */
  content: string | Uint8Array;
  contentType?: string;
}

export interface SendMailOpts {
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  /** Override the configured `smtp.from`. */
  from?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
}

export interface MailsHelpers {
  /** Compose + send an email. Either `text` or `html` must be provided. */
  send(opts: SendMailOpts): Promise<{ messageId: string }>;
}

function makeMails(): MailsHelpers {
  return {
    async send(opts) {
      if (!opts.text && !opts.html) throw new Error("mails.send requires `text` or `html`");
      const { sendMailRich } = await import("./email.ts");
      return sendMailRich(opts);
    },
  };
}

// ── cron ────────────────────────────────────────────────────────────────────

export interface CronAddOpts {
  /** Unique name; used by {@link CronHelpers.remove}. */
  name: string;
  /** Standard 5-field cron expression (UTC). */
  schedule: string;
  /** JS body executed inside `async (ctx) => { ... }`. Must `await` if needed. */
  code: string;
  /** Default true. */
  enabled?: boolean;
}

export interface CronHelpers {
  /** Add (or replace) a cron job by `name`. Returns the row id. */
  add(opts: CronAddOpts): Promise<{ id: string }>;
  /** Remove a cron job by name. Returns true if a row was deleted. */
  remove(name: string): Promise<boolean>;
  /** List currently-defined cron jobs (id, name, schedule, enabled). */
  list(): Promise<{ id: string; name: string; schedule: string; enabled: boolean }[]>;
}

function makeCron(): CronHelpers {
  return {
    async add(opts) {
      if (!opts.name?.trim()) throw new Error("cron.add: `name` is required");
      if (!opts.schedule?.trim()) throw new Error("cron.add: `schedule` is required");
      const { validateCron, nextRunFromCron, invalidateJobsCache } = await import("./jobs.ts");
      const err = validateCron(opts.schedule);
      if (err) throw new Error(`cron.add: invalid schedule — ${err}`);
      const { getDb } = await import("../db/client.ts");
      const { jobs } = await import("../db/schema.ts");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const next = nextRunFromCron(opts.schedule, now);
      const existing = await db.select().from(jobs).where(eq(jobs.name, opts.name)).limit(1);
      if (existing[0]) {
        const id = existing[0].id;
        await db.update(jobs).set({
          cron: opts.schedule,
          code: opts.code,
          enabled: opts.enabled === false ? 0 : 1,
          next_run_at: next,
          updated_at: now,
        }).where(eq(jobs.id, id));
        invalidateJobsCache();
        return { id };
      }
      const id = crypto.randomUUID();
      await db.insert(jobs).values({
        id,
        name: opts.name,
        cron: opts.schedule,
        code: opts.code,
        enabled: opts.enabled === false ? 0 : 1,
        mode: "inline",
        next_run_at: next,
        created_at: now,
        updated_at: now,
      });
      invalidateJobsCache();
      return { id };
    },
    async remove(name) {
      const { invalidateJobsCache } = await import("./jobs.ts");
      const { getDb } = await import("../db/client.ts");
      const { jobs } = await import("../db/schema.ts");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      const existing = await db.select().from(jobs).where(eq(jobs.name, name)).limit(1);
      if (!existing[0]) return false;
      await db.delete(jobs).where(eq(jobs.id, existing[0].id));
      invalidateJobsCache();
      return true;
    },
    async list() {
      const { getDb } = await import("../db/client.ts");
      const { jobs } = await import("../db/schema.ts");
      const db = getDb();
      const rows = await db.select().from(jobs);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        schedule: r.cron,
        enabled: r.enabled === 1,
      }));
    },
  };
}

// ── public factory ──────────────────────────────────────────────────────────

export interface FlagsHelpers {
  isEnabled(key: string, context?: Record<string, unknown>): Promise<boolean>;
  getString(key: string, fallback: string, context?: Record<string, unknown>): Promise<string>;
  getNumber(key: string, fallback: number, context?: Record<string, unknown>): Promise<number>;
  getJson<T = unknown>(key: string, fallback: T, context?: Record<string, unknown>): Promise<T>;
}

function makeFlags(): FlagsHelpers {
  return {
    async isEnabled(key, context) {
      const { evaluate } = await import("./flags.ts");
      const r = await evaluate(key, context ?? {}, false);
      return Boolean(r.value);
    },
    async getString(key, fallback, context) {
      const { evaluate } = await import("./flags.ts");
      const r = await evaluate(key, context ?? {}, fallback);
      return typeof r.value === "string" ? r.value : fallback;
    },
    async getNumber(key, fallback, context) {
      const { evaluate } = await import("./flags.ts");
      const r = await evaluate(key, context ?? {}, fallback);
      return typeof r.value === "number" ? r.value : fallback;
    },
    async getJson<T = unknown>(key: string, fallback: T, context?: Record<string, unknown>): Promise<T> {
      const { evaluate } = await import("./flags.ts");
      const r = await evaluate(key, context ?? {}, fallback as unknown as never);
      return (r.value as T) ?? fallback;
    },
  };
}

export interface ExtraHookHelpers {
  security: SecurityHelpers;
  path: PathHelpers;
  template: TemplateHelpers;
  http: HttpHelpers;
  util: UtilHelpers;
  db: DbHelpers;
  fs: FsHelpers;
  os: OsHelpers;
  mails: MailsHelpers;
  cron: CronHelpers;
  flags: FlagsHelpers;
  webhooks: WebhooksHelpers;
}

export interface WebhooksHelpers {
  dispatch(event: string, data?: unknown): Promise<{ enqueued: number }>;
}

function makeWebhooks(): WebhooksHelpers {
  return {
    async dispatch(event, data) {
      const { dispatchEvent } = await import("./webhooks.ts");
      return dispatchEvent({ event, data });
    },
  };
}

export function makeExtraHelpers(): ExtraHookHelpers {
  return {
    security: makeSecurity(),
    path: makePath(),
    template: makeTemplate(),
    http: makeHttp(),
    util: makeUtil(),
    db: makeDb(),
    fs: makeFs(),
    os: makeOs(),
    mails: makeMails(),
    cron: makeCron(),
    flags: makeFlags(),
    webhooks: makeWebhooks(),
  };
}
