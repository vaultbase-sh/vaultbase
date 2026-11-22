/**
 * The public folder (vb_public/ or VAULTBASE_PUBLIC_DIR): static files at
 * the server's root, behind every built-in route, with an opt-in fallback to
 * index.html for a single-page app's client-side routes.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createServer } from "../server.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { invalidateRateLimitCache } from "../api/ratelimit.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { resolvePublicDir, setPublicDir } from "../core/public-dir.ts";

const SECRET = "test-secret-public-dir";
let root: string;
let pub: string;
let app: ReturnType<typeof createServer>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "vb-public-"));
  pub = join(root, "vb_public");
  mkdirSync(join(pub, "assets"), { recursive: true });
  mkdirSync(join(pub, "docs"), { recursive: true });
  mkdirSync(join(pub, ".well-known"), { recursive: true });
  writeFileSync(join(pub, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(pub, "docs", "index.html"), "<p>docs</p>");
  writeFileSync(join(pub, "assets", "index-BkF3a9x2.js"), "console.log(1)");
  writeFileSync(join(pub, "logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(pub, ".env"), "SECRET=1");
  writeFileSync(join(pub, ".well-known", "security.txt"), "Contact: x");
  writeFileSync(join(root, "outside.txt"), "outside");
  symlinkSync(join(root, "outside.txt"), join(pub, "link.txt"));
  await initDb(":memory:");
  await runMigrations();
  invalidateRateLimitCache();
  app = createServer({ port: 0, dataDir: join(root, "data"), dbPath: ":memory:", uploadDir: join(root, "u"), logsDir: join(root, "l"), jwtSecret: SECRET, encryptionKey: undefined });
});

afterEach(() => setPublicDir(null));

afterAll(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  invalidateRateLimitCache();
  _resetCollectionCache();
  await closeDb();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows */ }
});

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  app.handle(new Request(`http://localhost${path}`, { method, headers }));
const page = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

describe("resolvePublicDir", () => {
  it("uses vb_public/ next to the data directory when it exists", () => {
    expect(resolvePublicDir(join(root, "data"), { env: {} })?.dir).toContain("vb_public");
    expect(resolvePublicDir(join(root, "nowhere", "data"), { env: {} })).toBeNull();
  });

  it("follows VAULTBASE_PUBLIC_DIR, off, and VAULTBASE_PUBLIC_SPA", () => {
    expect(resolvePublicDir(join(root, "data"), { env: { VAULTBASE_PUBLIC_DIR: "off" } })).toBeNull();
    const cfg = resolvePublicDir("/elsewhere/data", { env: { VAULTBASE_PUBLIC_DIR: pub, VAULTBASE_PUBLIC_SPA: "1" } });
    expect(cfg?.spa).toBe(true);
    expect(() => resolvePublicDir("/x/data", { env: { VAULTBASE_PUBLIC_DIR: join(root, "missing") } })).toThrow("is not a folder");
  });

  it("refuses a folder that overlaps the data directory or the hooks folder", () => {
    const data = join(root, "data2");
    mkdirSync(join(data, "inner"), { recursive: true });
    expect(() => resolvePublicDir(data, { env: { VAULTBASE_PUBLIC_DIR: data } })).toThrow("overlaps the data directory");
    expect(() => resolvePublicDir(data, { env: { VAULTBASE_PUBLIC_DIR: join(data, "inner") } })).toThrow("overlaps");
    // A folder holding the data directory.
    expect(() => resolvePublicDir(data, { env: { VAULTBASE_PUBLIC_DIR: root } })).toThrow("overlaps");
    expect(() => resolvePublicDir("/x/data", { env: { VAULTBASE_PUBLIC_DIR: pub }, hooksDir: pub })).toThrow("hooks folder");
  });
});

describe("serving the public folder", () => {
  it("answers nothing new while there is no public folder", async () => {
    const res = await get("/index.html");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("serves files, the root's index.html and a folder's index.html", async () => {
    setPublicDir(resolvePublicDir("/x/data", { env: { VAULTBASE_PUBLIC_DIR: pub } }));
    const home = await get("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(home.headers.get("cache-control")).toBe("no-cache");
    expect(await home.text()).toContain("<title>app</title>");
    expect(await (await get("/docs")).text()).toBe("<p>docs</p>");
    expect(await (await get("/docs/")).text()).toBe("<p>docs</p>");
    const png = await get("/logo.png");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    expect(png.headers.get("cache-control")).toBe("no-cache");
    expect((await get("/.well-known/security.txt")).status).toBe(200);
  });

  it("marks hashed asset names immutable and answers 304 when unchanged", async () => {
    setPublicDir(resolvePublicDir("/x/data", { env: { VAULTBASE_PUBLIC_DIR: pub } }));
    const js = await get("/assets/index-BkF3a9x2.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(pub, "logo.png"), old, old);
    const lm = (await get("/logo.png")).headers.get("last-modified")!;
    expect((await get("/logo.png", { "if-modified-since": lm })).status).toBe(304);
    expect((await get("/logo.png", { "if-modified-since": new Date("2025-01-01").toUTCString() })).status).toBe(200);
    const head = await get("/logo.png", {}, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("refuses dotfiles, traversal and symlinks out of the folder", async () => {
    setPublicDir(resolvePublicDir("/x/data", { env: { VAULTBASE_PUBLIC_DIR: pub } }));
    for (const p of ["/.env", "/../outside.txt", "/%2e%2e/outside.txt", "/assets/..%2f..%2foutside.txt", "/link.txt", "/x%00.html", "/a%5c..%5coutside.txt", "/.well-known"]) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).not.toContain("outside");
    }
  });

  it("never shadows the server's own routes", async () => {
    setPublicDir(resolvePublicDir("/x/data", { env: { VAULTBASE_PUBLIC_DIR: pub, VAULTBASE_PUBLIC_SPA: "1" } }));
    const health = await get("/api/health");
    expect(health.status).toBe(200);
    expect(((await health.json()) as { data: { status: string } }).data.status).toBe("ok");
    // A miss under a reserved prefix stays the API's JSON 404, SPA or not.
    for (const p of ["/api/nope", "/api/v1/nope/x/y", "/auth/nope", "/realtime/x"]) {
      const res = await get(p, page);
      expect(res.status, p).toBe(404);
      expect(res.headers.get("content-type"), p).toContain("application/json");
    }
    // Only GET and HEAD.
    expect((await get("/index.html", {}, "POST")).status).toBe(404);
  });

  it("falls back to index.html for page navigations only, with the SPA switch on", async () => {
    setPublicDir(resolvePublicDir("/x/data", { env: { VAULTBASE_PUBLIC_DIR: pub } }));
    expect((await get("/contenders", page)).status).toBe(404);
    setPublicDir(resolvePublicDir("/x/data", { env: { VAULTBASE_PUBLIC_DIR: pub, VAULTBASE_PUBLIC_SPA: "1" } }));
    const route = await get("/contenders/42", page);
    expect(route.status).toBe(200);
    expect(route.headers.get("cache-control")).toBe("no-cache");
    expect(await route.text()).toContain("<title>app</title>");
    // A missing asset, or a request that isn't a page load, still misses.
    expect((await get("/assets/missing.js", page)).status).toBe(404);
    expect((await get("/contenders", { accept: "application/json" })).status).toBe(404);
    expect((await get("/.env", page)).status).toBe(200); // the app shell, never the dotfile
    expect(await (await get("/.env", page)).text()).not.toContain("SECRET");
  });
});
