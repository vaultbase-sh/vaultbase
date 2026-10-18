// Builds one upgrade-path fixture: runs an old release's binary on an empty
// data folder, fills it through that release's own API, stops it, and keeps
// its data.db plus a manifest of what was created. The upgrade-path test
// (src/__tests__/upgrade-path.test.ts) opens every fixture with today's code.
//
//   bun scripts/make-upgrade-fixture.ts <version> <path to that release's binary>
//   bun scripts/make-upgrade-fixture.ts v0.18.0 /tmp/bin/v0.18.0/vaultbase
//
// Writes src/__tests__/fixtures/upgrade/<version>.db and <version>.json.
// Each step is tried and recorded; a step an old release doesn't support is
// left out of the manifest, and the test only checks what the manifest lists.
import { mkdtempSync, rmSync, copyFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const [version, binary] = process.argv.slice(2);
if (!version || !binary) throw new Error("usage: bun scripts/make-upgrade-fixture.ts <version> <binary>");
const OUT_DIR = join(import.meta.dir, "..", "src", "__tests__", "fixtures", "upgrade");
const PORT = 8190 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_KEY = "upgrade-fixture-setup-key-0123456789";
// Fixed so the test can verify tokens and passwords the old release made.
const JWT_SECRET = "upgrade-fixture-jwt-secret-0123456789abcdef0123456789";
const ADMIN = { email: "admin@fixture.test", password: "fixture-admin-password-1" };
const USERS = [
  { email: "ada@fixture.test", password: "fixture-user-password-1", name: "Ada" },
  { email: "linus@fixture.test", password: "fixture-user-password-2", name: "Linus" },
];

const dir = mkdtempSync(join(tmpdir(), `vb-fixture-${version}-`));
const proc = Bun.spawn([binary], {
  env: { ...process.env, VAULTBASE_DATA_DIR: dir, VAULTBASE_PORT: String(PORT), VAULTBASE_SETUP_KEY: SETUP_KEY, VAULTBASE_JWT_SECRET: JWT_SECRET, VAULTBASE_READ_WORKERS: "0" },
  stdout: "pipe", stderr: "pipe",
});

async function api(method: string, path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const ok = (s: number) => s >= 200 && s < 300;

const manifest: Record<string, any> = { version, made: new Date().toISOString(), jwtSecret: JWT_SECRET, admin: ADMIN, steps: {} as Record<string, string> };
const step = (name: string, status: number, detail?: unknown) => {
  manifest.steps[name] = ok(status) ? "ok" : `failed ${status}`;
  if (!ok(status)) console.warn(`  ${name}: ${status} ${JSON.stringify(detail).slice(0, 160)}`);
  return ok(status);
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await Bun.sleep(250);
  }
  const health = await (await fetch(`${BASE}/api/health`)).json() as any;
  manifest.reportedVersion = health?.data?.version ?? null;

  const setup = await api("POST", "/admin/setup", ADMIN, undefined, { "x-setup-key": SETUP_KEY });
  if (!step("admin", setup.status, setup.json)) throw new Error("setup failed");
  await Bun.sleep(1100); // a token from the setup second predates password_reset_at
  const login = await api("POST", "/admin/auth/login", ADMIN);
  const admin = login.json?.data?.token;
  if (!admin) throw new Error(`admin login failed: ${login.status}`);
  await api("PATCH", "/admin/settings", { "rate_limit.enabled": "0" }, admin);

  // Auth collection with a custom field, open sign-up.
  const usersCol = await api("POST", "/collections", {
    name: "members", type: "auth",
    fields: [{ name: "name", type: "text" }],
    list_rule: "@request.auth.id != \"\"", view_rule: "@request.auth.id != \"\"", create_rule: null, update_rule: "id = @request.auth.id", delete_rule: "",
  }, admin);
  if (step("auth_collection", usersCol.status, usersCol.json)) {
    manifest.users = [];
    for (const u of USERS) {
      const r = await api("POST", "/auth/members/register", { email: u.email, password: u.password, passwordConfirm: u.password, name: u.name });
      const id = r.json?.data?.record?.id ?? r.json?.data?.id;
      if (step(`register_${u.name.toLowerCase()}`, r.status, r.json) && id) manifest.users.push({ ...u, id });
    }
  }

  // A collection with the common field types and owner rules.
  const posts = await api("POST", "/collections", {
    name: "posts", type: "base",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "views", type: "number" },
      { name: "published", type: "bool" },
      { name: "published_at", type: "date" },
      { name: "status", type: "select", options: { values: ["draft", "live"] } },
      { name: "meta", type: "json" },
      { name: "body", type: "editor" },
      { name: "site", type: "url" },
      { name: "author", type: "relation", collection: "members" },
    ],
    list_rule: null, view_rule: null, create_rule: "@request.auth.id != \"\"", update_rule: "author = @request.auth.id", delete_rule: "author = @request.auth.id",
  }, admin);
  if (step("posts_collection", posts.status, posts.json)) {
    manifest.posts = [];
    const samples = [
      { title: "Hello, world", views: 10, published: true, published_at: "2026-01-15 10:00:00", status: "live", meta: { tags: ["a", "b"] }, body: "<p>First</p>", site: "https://example.com" },
      { title: "Draft post", views: 0, published: false, status: "draft", meta: { tags: [] }, body: "<p>Second</p>" },
      { title: "Unicode — 数据 ✓", views: 3, published: true, published_at: "2026-02-01 08:30:00", status: "live", meta: { n: 1 } },
    ];
    for (const [k, p] of samples.entries()) {
      let author = manifest.users?.[k % 2]?.id;
      let r = await api("POST", "/posts", { ...p, ...(author ? { author } : {}) }, admin);
      // Before 0.11, auth users lived in one shared table and a relation to
      // an auth collection couldn't find them: keep the post, without author.
      if (r.status === 422 && author && JSON.stringify(r.json).includes("author")) {
        author = undefined;
        r = await api("POST", "/posts", p, admin);
      }
      const id = r.json?.data?.id;
      if (step(`post_${k}`, r.status, r.json) && id) manifest.posts.push({ id, title: p.title, views: p.views, published: p.published, status: p.status, author: author ?? null });
    }
  }

  // A hook, a setting, an index.
  const hook = await api("POST", "/admin/hooks", { name: "stamp", collection_name: "posts", event: "beforeCreate", code: "ctx.record.views = ctx.record.views ?? 0;", enabled: true }, admin);
  if (step("hook", hook.status, hook.json)) manifest.hook = { name: "stamp", collection: "posts", event: "beforeCreate" };
  const setting = await api("PATCH", "/admin/settings", { "app.name": `Fixture ${version}` }, admin);
  if (step("setting", setting.status, setting.json)) manifest.setting = { key: "app.name", value: `Fixture ${version}` };
} finally {
  proc.kill("SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(10_000)]);
}

// The database file, after a clean shutdown (WAL checkpointed into it).
const db = join(dir, "data.db");
if (!existsSync(db)) throw new Error(`no data.db in ${dir}`);
for (const sfx of ["-wal", "-shm"]) if (existsSync(db + sfx)) console.warn(`  note: ${sfx} left behind; checkpointing it into the copy`);
{
  const { Database } = await import("bun:sqlite");
  const d = new Database(db);
  d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  d.close();
}
copyFileSync(db, join(OUT_DIR, `${version}.db`));
await Bun.write(join(OUT_DIR, `${version}.json`), JSON.stringify(manifest, null, 2) + "\n");
rmSync(dir, { recursive: true, force: true });
console.log(`${version}: ${Object.entries(manifest.steps).map(([k, v]) => `${k}=${v}`).join(" ")}`);
