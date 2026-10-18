/**
 * Upgrade path: databases created by earlier releases boot on this one.
 *
 * Each fixture in fixtures/upgrade/ is the data.db of a real old release,
 * filled through that release's own API (scripts/make-upgrade-fixture.ts),
 * with a manifest of what was created. This opens each one with today's
 * code — migrations twice, since they run at every start — and checks over
 * HTTP that the admin, the users and their passwords, the collections, every
 * record and its values, the rules, a setting and a hook all survived, and
 * that the data can still be written.
 *
 * Nothing guarded this before: a migration that broke existing installs
 * would have passed CI. To add a release, build its fixture:
 *   bun scripts/make-upgrade-fixture.ts vX.Y.Z <that release's binary>
 */
import { describe, expect, it, afterEach } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createServer } from "../server.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { onSqlite } from "./_helpers.ts";

interface Manifest {
  version: string;
  jwtSecret: string;
  admin: { email: string; password: string };
  steps: Record<string, string>;
  users?: Array<{ id: string; email: string; password: string; name: string }>;
  posts?: Array<{ id: string; title: string; views: number; published: boolean; status: string; author: string | null }>;
  hook?: { name: string; collection: string; event: string };
  setting?: { key: string; value: string };
}

const FIXTURES = join(import.meta.dir, "fixtures", "upgrade");
const versions = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

let dir = "";
afterEach(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  _resetCollectionCache();
  invalidateHookCache();
  await closeDb();
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ } dir = ""; }
});

describe.skipIf(!onSqlite)("upgrade path", () => {
  it("has fixtures to check", () => {
    expect(versions.length).toBeGreaterThanOrEqual(6);
  });

  for (const version of versions) {
    it(`a ${version} database works on this release`, async () => {
      const m = JSON.parse(await Bun.file(join(FIXTURES, `${version}.json`)).text()) as Manifest;
      dir = mkdtempSync(join(tmpdir(), `vb-upgrade-${version}-`));
      setLogsDir(join(dir, "logs"));
      const dbPath = join(dir, "data.db");
      copyFileSync(join(FIXTURES, `${version}.db`), dbPath);

      await initDb(`file:${dbPath}`);
      await runMigrations();
      await runMigrations(); // runs at every start: must be repeatable

      const app = createServer({ port: 0, dataDir: dir, dbPath, uploadDir: join(dir, "uploads"), logsDir: join(dir, "logs"), jwtSecret: m.jwtSecret, encryptionKey: undefined });
      const call = async (method: string, path: string, body?: unknown, token?: string) => {
        const r = await app.handle(new Request(`http://localhost/api/v1${path}`, {
          method,
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        }));
        const text = await r.text();
        let json: any; try { json = JSON.parse(text); } catch { json = text; }
        return { status: r.status, json };
      };

      // The admin made by the old release signs in with its password.
      const login = await call("POST", "/admin/auth/login", m.admin);
      expect(login.status).toBe(200);
      const admin = login.json.data.token as string;

      // Collections, with their rules.
      const cols = (await call("GET", "/collections", undefined, admin)).json.data as Array<{ name: string; type: string; update_rule: string | null; list_rule: string | null }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      if (m.steps.auth_collection === "ok") expect(byName["members"]?.type).toBe("auth");
      if (m.steps.posts_collection === "ok") {
        expect(byName["posts"]?.list_rule).toBeNull();
        expect(byName["posts"]?.update_rule).toBe("author = @request.auth.id");
      }

      // Every record, with its values.
      if (m.posts?.length) {
        const list = await call("GET", "/posts?perPage=50");
        expect(list.status).toBe(200);
        expect(list.json.totalItems).toBe(m.posts.length);
        for (const p of m.posts) {
          const got = await call("GET", `/posts/${p.id}`);
          expect(got.status).toBe(200);
          expect(got.json.data).toMatchObject({ id: p.id, title: p.title, views: p.views, published: p.published, status: p.status });
          if (p.author) expect(got.json.data.author).toBe(p.author);
        }
      }

      // Users sign in with the passwords the old release hashed, and can write.
      for (const u of m.users ?? []) {
        const ul = await call("POST", "/auth/members/login", { email: u.email, password: u.password });
        expect(ul.status).toBe(200);
        expect(ul.json.data.record.id).toBe(u.id);
        // Their record, custom field included (sign-in returns only id and email).
        const me = await call("GET", `/members/${u.id}`, undefined, ul.json.data.token);
        expect(me.status).toBe(200);
        expect(me.json.data).toMatchObject({ id: u.id, email: u.email, name: u.name });
      }
      if (m.users?.length && m.posts?.length) {
        const [ada, linus] = m.users;
        const token = (await call("POST", "/auth/members/login", { email: ada!.email, password: ada!.password })).json.data.token as string;
        const created = await call("POST", "/posts", { title: `New on ${version}`, author: ada!.id, status: "draft" }, token);
        expect(created.status).toBe(200);
        expect((await call("PATCH", `/posts/${created.json.data.id}`, { views: 5 }, token)).status).toBe(200);
        // Someone else's post: the update rule still holds.
        const theirs = m.posts.find((p) => p.author && p.author === linus?.id);
        if (theirs) expect([403, 404]).toContain((await call("PATCH", `/posts/${theirs.id}`, { views: 999 }, token)).status);
        expect((await call("GET", "/posts?perPage=50")).json.totalItems).toBe(m.posts.length + 1);
      }

      // The newest fixed tables work too: a queued job with a unique key, and
      // the lease-based recovery sweep (columns added in 0.24.0).
      {
        const { enqueue, recoverInterruptedJobs } = await import("../core/queues.ts");
        const first = await enqueue("upgrade-check", { v: version }, { uniqueKey: "upgrade-check" });
        expect((await enqueue("upgrade-check", {}, { uniqueKey: "upgrade-check" })).jobId).toBe(first.jobId);
        expect(await recoverInterruptedJobs(0)).toBe(0);
      }

      // Settings and hooks carried over.
      if (m.setting) {
        const settings = (await call("GET", "/admin/settings", undefined, admin)).json.data as Record<string, string>;
        expect(settings[m.setting.key]).toBe(m.setting.value);
      }
      if (m.hook) {
        const hooks = (await call("GET", "/admin/hooks", undefined, admin)).json.data as Array<{ name: string; collection_name: string; event: string }>;
        expect(hooks.some((h) => h.name === m.hook!.name && h.collection_name === m.hook!.collection && h.event === m.hook!.event)).toBe(true);
      }
    }, 30_000);
  }
});
