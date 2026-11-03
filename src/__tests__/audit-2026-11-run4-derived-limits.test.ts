/**
 * Security audit run 4, "derived limits" findings:
 *
 *   1. A view saved before its source table had private columns kept
 *      publishing them after the table gained one (a whole-row value on
 *      Postgres): schema changes now re-check the dependent views.
 *   2. Postgres-only literals (E'…', $tag$…$tag$) desynchronised the view
 *      query scanner, hiding private column names; the created view's
 *      query tree is now checked for private columns too.
 *   3. Writes outside the write gate (auth stamps, revocations, ...) joined
 *      the open group-commit transaction and were lost with its rollback.
 *   4. The rate limiter charged `/api/<col>/` and relative batch op URLs to
 *      the catch-all rule instead of the create rule.
 *   5. Thumbnail requests buffered the whole source before joining the
 *      in-flight job or a decode slot, with an unbounded queue.
 *   6. File routes told hidden collections and records apart from missing
 *      ones, and file tokens outlived the session that minted them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import Elysia from "elysia";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Image } from "imagescript";
import { closeDb, getDb, getRawClient, initDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { tokenRevocations } from "../db/schema.ts";
import { withSharedWrite } from "../core/write-gate.ts";
import { groupCommitOpen } from "../core/group-commit.ts";
import { revokeToken } from "../core/sec.ts";
import { scanSql } from "../core/sql-scan.ts";
import {
  createCollection, getCollection, loadSensitiveSchema, updateCollection, viewTreePrivateUse,
  _resetCollectionCache, CollectionInUseError,
} from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateRateLimitCache, makeRateLimitPlugin } from "../api/ratelimit.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { _thumbJobStats, MAX_THUMB_JOBS, MAX_THUMB_JOBS_WAITING, MAX_THUMB_SOURCE_BYTES } from "../core/image.ts";
import { clearThumbCache, invalidateStorageCache, registerStorageDriver, setUploadDir } from "../core/storage.ts";
import { createPublicCollection, onSqlite, seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-run4-derived-limits";

// ── 3. Ungated writes and the open write group ──────────────────────────────

describe.skipIf(!onSqlite)("writes outside the gate never join the open group", () => {
  let dir = "";
  let file = "";
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vb-run4-gc-"));
    file = join(dir, "data.db");
    await initDb(file);
    await runMigrations();
    getRawClient().exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    // Stands in for anything that ends the whole transaction (an I/O error, a failed COMMIT).
    getRawClient().exec(`CREATE TRIGGER no_boom BEFORE INSERT ON t WHEN NEW.v = 'boom' BEGIN SELECT RAISE(ROLLBACK, 'boom'); END`);
  });
  afterEach(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const outside = <T>(fn: (d: Database) => T): T => {
    const d = new Database(file, { readonly: true });
    try { return fn(d); } finally { d.close(); }
  };
  const gated = (v: string) => withSharedWrite(async () => { getRawClient().query("INSERT INTO t (v) VALUES (?)").run(v); });

  it("a revocation (driver) and a drizzle write survive a later rollback of the group", async () => {
    const first = gated("plain");
    expect(groupCommitOpen()).toBe(true);
    // As a sign-out or password reset would, while the group is open.
    await revokeToken("jti-driver", 9_999_999_999);
    await getDb().insert(tokenRevocations).values({ jti: "jti-drizzle", expires_at: 9_999_999_999 });
    await db.run("UPDATE t SET v = v WHERE 0");
    const second = gated("boom");
    const results = await Promise.allSettled([first, second]);
    // The ungated writes committed the group they found open, then ran on their own.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const jtis = outside((d) => d.query("SELECT jti FROM vaultbase_token_revocations ORDER BY jti").all().map((r) => (r as { jti: string }).jti));
    expect(jtis).toEqual(["jti-driver", "jti-drizzle"]);
    expect(outside((d) => d.query("SELECT v FROM t").all().map((r) => (r as { v: string }).v))).toEqual(["plain"]);
  });

  it("an ungated transaction doesn't become a savepoint inside the group", async () => {
    const first = gated("plain");
    expect(groupCommitOpen()).toBe(true);
    await db.transaction(async () => { await db.run("INSERT INTO vaultbase_token_revocations (jti, expires_at) VALUES ('jti-tx', 1)"); });
    const results = await Promise.allSettled([first, gated("boom")]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(outside((d) => d.query("SELECT count(*) AS n FROM vaultbase_token_revocations WHERE jti = 'jti-tx'").get() as { n: number }).n).toBe(1);
  });

  it("gated writes still share one group", async () => {
    const writes = [gated("a"), gated("b"), gated("c")];
    expect(groupCommitOpen()).toBe(true);
    await Promise.all(writes);
    expect(outside((d) => (d.query("SELECT count(*) AS n FROM t").get() as { n: number }).n)).toBe(3);
  });
});

// ── 4. Rate limiter path classification ─────────────────────────────────────

describe("rate limiter charges a create however its URL is spelled", () => {
  beforeEach(async () => {
    await initDb(":memory:");
    await runMigrations();
    setSetting("rate_limit.enabled", "1");
    setSetting("rate_limit.rules", JSON.stringify([
      { label: "*:create", max: 3, windowMs: 60_000, audience: "all" },
      { label: "/api/*", max: 1000, windowMs: 60_000, audience: "all" },
    ]));
    invalidateRateLimitCache();
  });
  afterEach(async () => { invalidateRateLimitCache(); await closeDb(); });

  const app = () => new Elysia().use(makeRateLimitPlugin(SECRET))
    .post("/api/v1/notes", () => "ok")
    .post("/api/v1/notes/", () => "ok")
    .post("/api/v1/batch", () => "ok")
    .post("/api/v1/batch/", () => "ok");
  const post = (a: ReturnType<typeof app>, path: string, body?: unknown) => a.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  }));

  it("POST /api/v1/notes/ takes the create bucket", async () => {
    const a = app();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(a, "/api/v1/notes/")).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  for (const url of ["/api/v1/notes/", "api/v1/notes"]) {
    it(`batch ops to '${url}' take the create bucket`, async () => {
      const a = app();
      const ops = Array.from({ length: 3 }, () => ({ method: "POST", url, body: {} }));
      expect((await post(a, "/api/v1/batch", { requests: ops })).status).toBe(200);
      expect((await post(a, "/api/v1/batch", { requests: ops })).status).toBe(429);
    });
  }

  it("a batch sent to /api/v1/batch/ still charges its ops", async () => {
    const a = app();
    const ops = Array.from({ length: 3 }, () => ({ method: "POST", url: "/api/v1/notes", body: {} }));
    expect((await post(a, "/api/v1/batch/", { requests: ops })).status).toBe(200);
    expect((await post(a, "/api/v1/batch/", { requests: ops })).status).toBe(429);
  });
});

// ── 5. Thumbnails: dedupe before reading, bounded queue, capped source ─────

describe("thumbnail source reads", () => {
  let dir = "";
  let off: () => void = () => {};
  const objects = new Map<string, Uint8Array>();
  let reads = 0;
  /** The most bytes any one read of a source took. */
  let pulled = 0;
  let gate: Promise<void> | null = null;
  /** Keys served as an endless-looking stream of the given length. */
  const huge = new Map<string, number>();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vb-run4-thumb-"));
    await initDb(":memory:");
    await runMigrations();
    objects.clear(); huge.clear();
    reads = 0; pulled = 0; gate = null;
    off = registerStorageDriver({
      name: "run4mem",
      create: () => ({
        async write(key, data) { objects.set(key, new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)); },
        async read(key) {
          reads++;
          if (gate) await gate;
          const size = huge.get(key);
          if (size !== undefined) { pulled = Math.max(pulled, size); const b = new Uint8Array(size); b.set(objects.get(key)!); return b.buffer; }
          const b = objects.get(key);
          return b ? b.slice().buffer : null;
        },
        async exists(key) { return objects.has(key); },
        async delete(key) { objects.delete(key); },
        async response(key) {
          reads++;
          if (gate) await gate;
          const size = huge.get(key);
          if (size !== undefined) {
            const head = objects.get(key)!;
            const chunk = new Uint8Array(1024 * 1024);
            let sent = 0;
            return new Response(new ReadableStream<Uint8Array>({
              pull(c) {
                if (sent >= size) { c.close(); return; }
                const out = sent === 0 ? (() => { const x = chunk.slice(); x.set(head); return x; })() : chunk;
                sent += out.length; pulled = Math.max(pulled, sent);
                c.enqueue(out);
              },
            }));
          }
          const b = objects.get(key);
          return b ? new Response(b.slice()) : null;
        },
      }),
    });
    setSetting("storage.driver", "run4mem");
    setUploadDir(dir);
    invalidateStorageCache();
    clearThumbCache();
  });
  afterEach(async () => {
    gate = null;
    off();
    setSetting("storage.driver", "local");
    invalidateStorageCache();
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  async function upload(): Promise<{ app: ReturnType<typeof makeFilesPlugin>; filename: string }> {
    await createPublicCollection({ name: "pics", fields: JSON.stringify([{ name: "img", type: "file" }]) });
    const recordId = (await createRecord("pics", {})).id;
    const uid = await seedAuthUser({ collection: "users", email: "t@test.local" });
    const token = await signUserJwt(uid, "t@test.local", "users", SECRET);
    const app = makeFilesPlugin(dir, SECRET);
    const png = await new Image(64, 48).fill(0x3366ffff).encode();
    const form = new FormData();
    form.append("file", new File([png], "a.png", { type: "image/png" }));
    const up = await app.handle(new Request(`http://localhost/files/pics/${recordId}/img`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
    }));
    const { data } = (await up.json()) as { data: { filename: string } };
    return { app, filename: data.filename };
  }

  it("concurrent misses for one variant read the source once", async () => {
    const { app, filename } = await upload();
    reads = 0;
    const get = () => app.handle(new Request(`http://localhost/files/${filename}?thumb=20x20`));
    const responses = await Promise.all(Array.from({ length: 10 }, get));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(reads).toBe(1);
  });

  it("past a bounded queue, a thumbnail request is refused with 503", async () => {
    const { app, filename } = await upload();
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    const total = MAX_THUMB_JOBS + MAX_THUMB_JOBS_WAITING + 4;
    // Distinct variants: each is its own job.
    const pending = Array.from({ length: total }, (_, i) =>
      app.handle(new Request(`http://localhost/files/${filename}?thumb=${10 + (i % 30)}x${10 + Math.floor(i / 30) + (i % 30)}`)));
    for (let i = 0; i < 50 && _thumbJobStats().waiting < MAX_THUMB_JOBS_WAITING; i++) await Bun.sleep(5);
    expect(_thumbJobStats()).toEqual({ running: MAX_THUMB_JOBS, waiting: MAX_THUMB_JOBS_WAITING });
    // Only the jobs holding a slot have started reading.
    expect(reads).toBe(MAX_THUMB_JOBS);
    open();
    const statuses = (await Promise.all(pending)).map((r) => r.status);
    expect(statuses.filter((s) => s === 503).length).toBe(total - MAX_THUMB_JOBS - MAX_THUMB_JOBS_WAITING);
    expect(statuses.filter((s) => s === 200).length).toBe(MAX_THUMB_JOBS + MAX_THUMB_JOBS_WAITING);
  });

  it("a file with no files row is read only up to the source cap", async () => {
    await upload();
    // An orphan (admin-only) whose head says PNG and whose body runs past the cap.
    const name = `${crypto.randomUUID()}.png`;
    const png = await new Image(8, 8).fill(0xff0000ff).encode();
    objects.set(name, png);
    huge.set(name, MAX_THUMB_SOURCE_BYTES + 8 * 1024 * 1024);
    const { signAuthToken } = await import("../core/sec.ts");
    const app = makeFilesPlugin(dir, SECRET);
    // An admin session: seed the row the principal recheck reads.
    const adminId = crypto.randomUUID();
    await db.run("INSERT INTO vaultbase_admin (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)", [adminId, "adm@test.local", "x", 0]);
    const admin = (await signAuthToken({ payload: { id: adminId, email: "adm@test.local" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
    pulled = 0;
    const res = await app.handle(new Request(`http://localhost/files/${name}?thumb=4x4`, { headers: { authorization: `Bearer ${admin}` } }));
    expect(res.status).toBe(200);
    await res.body?.cancel().catch(() => {});
    // No read of it went much past the cap (a chunk or two read ahead).
    expect(pulled).toBeLessThan(MAX_THUMB_SOURCE_BYTES + 3 * 1024 * 1024);
  });
});

// ── 6. File routes: hidden collections/records, session-bound tokens ───────

describe("file routes and hidden collections", () => {
  let dir = "";
  beforeEach(async () => {
    _resetCollectionCache();
    dir = mkdtempSync(join(tmpdir(), "vb-run4-files-"));
    await initDb(":memory:");
    await runMigrations();
    setUploadDir(dir);
    invalidateStorageCache();
  });
  afterEach(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  async function user(email = "u@test.local") {
    const id = await seedAuthUser({ collection: "users", email });
    return { id, token: await signUserJwt(id, email, "users", SECRET) };
  }
  const json = async (r: Response) => ({ status: r.status, body: await r.json() });

  it("a hidden collection answers as a missing one on mint, upload and delete", async () => {
    await createCollection({
      name: "vault", type: "base",
      fields: JSON.stringify([{ name: "doc", type: "file" }]),
      list_rule: "", view_rule: "", create_rule: "", update_rule: "", delete_rule: "",
    });
    const rec = await createRecord("vault", {});
    const { token } = await user();
    const app = makeFilesPlugin(dir, SECRET);
    const h = { authorization: `Bearer ${token}` };
    const mint = (c: string) => app.handle(new Request(`http://localhost/files/${c}/${rec.id}/doc/x.png/token`, { method: "POST", headers: h }));
    const form = () => { const f = new FormData(); f.append("file", new File([new Uint8Array([1, 2])], "a.txt", { type: "text/plain" })); return f; };
    const up = (c: string) => app.handle(new Request(`http://localhost/files/${c}/${rec.id}/doc`, { method: "POST", headers: h, body: form() }));
    const del = (c: string) => app.handle(new Request(`http://localhost/files/${c}/${rec.id}/doc`, { method: "DELETE", headers: h }));
    for (const call of [mint, del]) {
      const hidden = await json(await call("vault"));
      const missing = await json(await call("nope"));
      expect(hidden).toEqual(missing);
      expect(hidden.status).toBe(404);
    }
    const hiddenUp = await json(await up("vault"));
    expect(hiddenUp.status).toBe(404);
    expect((hiddenUp.body as { error: string }).error).toBe("Collection 'vault' not found");
  });

  it("a record the caller can't view says nothing about its fields or files", async () => {
    await createCollection({
      name: "notes", type: "base",
      fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "doc", type: "file" }]),
      list_rule: "owner = @request.auth.id", view_rule: "owner = @request.auth.id", create_rule: null,
    });
    const rec = await createRecord("notes", { owner: "someone-else" });
    const { token } = await user();
    const app = makeFilesPlugin(dir, SECRET);
    const mint = (field: string, file: string) => app.handle(new Request(`http://localhost/files/notes/${rec.id}/${field}/${file}/token`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));
    // A missing file and a missing field answer as the rule refusal does.
    expect((await mint("doc", "missing.png")).status).toBe(403);
    expect((await mint("nofield", "missing.png")).status).toBe(403);
  });

  it("a file token ends with the session that minted it (password reset)", async () => {
    await createPublicCollection({ name: "docs", fields: JSON.stringify([{ name: "doc", type: "file", options: { protected: true } }]) });
    const rec = await createRecord("docs", {});
    const { id, token } = await user();
    const app = makeFilesPlugin(dir, SECRET);
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("hello")], "a.txt", { type: "text/plain" }));
    const up = await app.handle(new Request(`http://localhost/files/docs/${rec.id}/doc`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }));
    expect(up.status).toBe(200);
    const filename = ((await up.json()) as { data: { filename: string } }).data.filename;
    const minted = await app.handle(new Request(`http://localhost/files/docs/${rec.id}/doc/${filename}/token`, { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    expect(minted.status).toBe(200);
    const fileToken = ((await minted.json()) as { data: { token: string } }).data.token;
    const download = () => app.handle(new Request(`http://localhost/files/${filename}?token=${encodeURIComponent(fileToken)}`));
    expect((await download()).status).toBe(200);
    await db.run("UPDATE vb_users SET password_reset_at = ? WHERE id = ?", [Date.now(), id]);
    expect((await download()).status).toBe(401);
  });
});

// ── 2. Postgres literal forms and the view query check ─────────────────────

describe("view query scanner reads Postgres literals", () => {
  it("E'…' and $tag$…$tag$ don't hide the words after them", () => {
    for (const q of [
      "SELECT $q$'$q$ AS pad, id, password_hash AS s FROM vb_users WHERE $q$'$q$ <> ''",
      "SELECT E'x\\'' AS pad, id, password_hash AS s FROM vb_users WHERE E'x\\'' <> ''",
      "SELECT $$'$$ AS pad, ARRAY[password_hash, password_hash] AS s FROM vb_users",
    ]) {
      const { words } = scanSql(q, { pg: true });
      expect(words).toContain("PASSWORD_HASH");
      expect(words).toContain("VB_USERS");
    }
    // SQLite has none of these forms: its reading is unchanged.
    expect(scanSql("SELECT [password_hash] FROM t").identifiers).toContain("PASSWORD_HASH");
  });
});

describe.skipIf(onSqlite)("Postgres view checks", () => {
  beforeEach(async () => {
    _resetCollectionCache();
    await initDb(":memory:");
    await runMigrations();
    await seedAuthUser({ collection: "users", email: "a@test.local", passwordHash: "$argon2id$RUN4-DUMMY-HASH" });
  });
  afterEach(() => closeDb());

  const list = (name: string) => makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/${name}`));

  it("Postgres-only literals don't get a password hash into a view", async () => {
    for (const [i, q] of [
      "SELECT $q$'$q$ AS pad, id, password_hash AS secretcol FROM vb_users WHERE $q$'$q$ <> ''",
      "SELECT E'x\\'' AS pad, id, password_hash AS secretcol FROM vb_users WHERE E'x\\'' <> ''",
    ].entries()) {
      await expect(createCollection({ name: `leak${i}`, type: "view", view_query: q, list_rule: null, view_rule: null })).rejects.toThrow();
      expect(await getCollection(`leak${i}`)).toBeNull();
    }
  });

  it("the created view's query tree is checked for private columns", async () => {
    await loadSensitiveSchema();
    const tree = async (body: string) => {
      await db.exec(`CREATE VIEW run4_probe AS ${body}`);
      try {
        const r = await db.get<{ tree: string; rel: string }>(
          "SELECT r.ev_action::text AS tree FROM pg_rewrite r WHERE r.ev_class = to_regclass('run4_probe') AND r.rulename = '_RETURN'");
        return r!.tree;
      } finally { await db.exec("DROP VIEW run4_probe"); }
    };
    const rel = await db.get<{ oid: string }>("SELECT to_regclass('vb_users')::oid::text AS oid");
    const cols = await db.all<{ num: number; name: string }>(
      "SELECT attnum AS num, attname AS name FROM pg_attribute WHERE attrelid = to_regclass('vb_users') AND attnum > 0 AND attname IN ('password_hash', 'totp_secret')");
    const priv = new Map([[rel!.oid, new Map(cols.map((c) => [Number(c.num), c.name]))]]);
    // Kept under its own name (stripped from rows): allowed.
    expect(viewTreePrivateUse(await tree("SELECT * FROM vb_users"), priv)).toBeNull();
    expect(viewTreePrivateUse(await tree("SELECT * FROM (SELECT * FROM vb_users) s"), priv)).toBeNull();
    expect(viewTreePrivateUse(await tree("SELECT id, email FROM vb_users"), priv)).toBeNull();
    // Renamed, computed, used in a filter, in a scalar subquery, in a UNION arm: refused.
    for (const body of [
      "SELECT id, password_hash AS x FROM vb_users",
      "SELECT id, upper(password_hash) AS password_hash FROM vb_users",
      "SELECT id FROM vb_users WHERE password_hash LIKE '$argon2id$%'",
      "SELECT (SELECT password_hash FROM vb_users LIMIT 1) AS x",
      "SELECT id, email FROM vb_users UNION SELECT id, password_hash FROM vb_users",
      "SELECT s.x FROM (SELECT password_hash AS x FROM vb_users) s",
      "SELECT id, ARRAY[password_hash, password_hash] AS s FROM vb_users",
    ]) expect(viewTreePrivateUse(await tree(body), priv)).not.toBeNull();
  });

  it("adding a password field under a whole-row view is refused, naming the view", async () => {
    await createCollection({ name: "members", type: "base", fields: JSON.stringify([{ name: "handle", type: "text" }]), list_rule: null, view_rule: null });
    await createCollection({ name: "memberfeed", type: "view", view_query: "SELECT id, to_jsonb(m)::text AS doc FROM vb_members m", list_rule: null, view_rule: null });
    const members = (await getCollection("members"))!;
    const fields = [{ name: "handle", type: "text" }, { name: "passcode", type: "password" }];
    const attempt = updateCollection(members.id, { fields: JSON.stringify(fields) });
    await expect(attempt).rejects.toBeInstanceOf(CollectionInUseError);
    await expect(updateCollection(members.id, { fields: JSON.stringify(fields) })).rejects.toThrow(/memberfeed/);
    // Rolled back: no column, no schema change.
    const cols = await db.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'vb_members' AND table_schema = current_schema()");
    expect(cols.map((c) => c.name)).not.toContain("passcode");
    expect((await getCollection("members"))!.fields).not.toContain("passcode");
    expect((await list("memberfeed")).status).toBe(200);
  });

  it("a view that keeps only plain columns doesn't block the change", async () => {
    await createCollection({ name: "members", type: "base", fields: JSON.stringify([{ name: "handle", type: "text" }]), list_rule: null, view_rule: null });
    await createCollection({ name: "handles", type: "view", view_query: "SELECT id, handle FROM vb_members", list_rule: null, view_rule: null });
    const members = (await getCollection("members"))!;
    await updateCollection(members.id, { fields: JSON.stringify([{ name: "handle", type: "text" }, { name: "passcode", type: "password" }]) });
    expect((await getCollection("members"))!.fields).toContain("passcode");
  });
});

// ── 1. Dependent views on SQLite ────────────────────────────────────────────

describe.skipIf(!onSqlite)("dependent views are re-checked on SQLite too", () => {
  beforeEach(async () => {
    _resetCollectionCache();
    await initDb(":memory:");
    await runMigrations();
  });
  afterEach(() => closeDb());

  it("a UNION view over a table that gains a password field refuses the change", async () => {
    await createCollection({ name: "members", type: "base", fields: JSON.stringify([{ name: "handle", type: "text" }]), list_rule: null, view_rule: null });
    await createCollection({ name: "mixed", type: "view", view_query: "SELECT id, handle FROM vb_members UNION SELECT 'x', 'y'", list_rule: null, view_rule: null });
    const members = (await getCollection("members"))!;
    const fields = JSON.stringify([{ name: "handle", type: "text" }, { name: "passcode", type: "password" }]);
    await expect(updateCollection(members.id, { fields })).rejects.toThrow(/view 'mixed'/);
    const cols = await db.all<{ name: string }>("SELECT name FROM pragma_table_info('vb_members')");
    expect(cols.map((c) => c.name)).not.toContain("passcode");
  });

  it("an unrelated view doesn't block it", async () => {
    await createCollection({ name: "members", type: "base", fields: JSON.stringify([{ name: "handle", type: "text" }]), list_rule: null, view_rule: null });
    await createCollection({ name: "others", type: "base", fields: JSON.stringify([{ name: "x", type: "text" }]), list_rule: null, view_rule: null });
    await createCollection({ name: "ov", type: "view", view_query: "SELECT id, x FROM vb_others UNION SELECT 'a', 'b'", list_rule: null, view_rule: null });
    const members = (await getCollection("members"))!;
    await updateCollection(members.id, { fields: JSON.stringify([{ name: "handle", type: "text" }, { name: "passcode", type: "password" }]) });
    expect((await getCollection("members"))!.fields).toContain("passcode");
  });
});
