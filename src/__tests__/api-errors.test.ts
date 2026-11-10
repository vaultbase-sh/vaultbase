/**
 * How the records, files and batch APIs answer a caller's mistakes (DX audit
 * F-02, F-05, F-06, F-15):
 * - a 403 says which operation was refused and why, never the rule;
 * - a Bearer token the server doesn't accept answers 401 (0.44; 0.42 and
 *   0.43 ran the request as anonymous and said `token_invalid` on the 403);
 * - unknown sort/expand/fields/body keys answer 400 (0.44; a
 *   `Vaultbase-Warning` header in 0.42 and 0.43);
 * - registering a taken email answers 409.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { mintApiToken } from "../core/api-tokens.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-api-errors";
let tmpDir: string;
let userId = "";
let userToken = "";

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-api-errors-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  await createCollection({ name: "users", type: "auth", create_rule: null, list_rule: null, view_rule: null, update_rule: null, fields: JSON.stringify([{ name: "nick", type: "text" }]) });
  userId = await seedAuthUser({ collection: "users", email: "u@test.local", passwordHash: await Bun.password.hash("pw-123456789012") });
  userToken = await signUserJwt(userId, "u@test.local", "users", SECRET);
  await createCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "author", type: "relation", collection: "users" },
    ]),
    list_rule: null,
    view_rule: null,
    create_rule: "@request.auth.id != \"\"",
    update_rule: "\"a\" = \"b\"",
    delete_rule: "",
  });
  // Open to everyone, so a refusal here can only be about the token or the keys.
  await createCollection({
    name: "notes",
    fields: JSON.stringify([{ name: "title", type: "text" }, { name: "author", type: "relation", collection: "users" }]),
    list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
  });
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const records = (path: string, init: RequestInit = {}) =>
  makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, init));
const json = (method: string, body: unknown, token?: string): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

async function expiredToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({ id: userId, email: "u@test.local", collection: "users" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("user")
    .setIssuedAt(now - 7200).setExpirationTime(now - 3600).setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
}
const apiToken = async (scopes: string[]) =>
  (await mintApiToken({ name: `t-${scopes.join("-")}`, scopes, createdBy: "a1", createdByEmail: "ops@test.local" }, SECRET)).token;

const INVALID = { error: "Token expired or invalid", code: 401, reason: "token_invalid" };

describe("403 body", () => {
  it("not signed in", async () => {
    const res = await records("/posts", json("POST", { title: "x" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden", code: 403, operation: "create", reason: "not_signed_in" });
  });

  it("signed in, rule says no", async () => {
    const created = await records("/posts", json("POST", { title: "x" }, userToken));
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const res = await records(`/posts/${id}`, json("PATCH", { title: "y" }, userToken));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ operation: "update", reason: "rule_denied" });
    const del = await records(`/posts/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${userToken}` } });
    expect(await del.json()).toMatchObject({ operation: "delete", reason: "admin_only" });
  });

  it("never includes the rule expression", async () => {
    const res = await records("/posts", json("POST", { title: "x" }));
    expect(await res.text()).not.toContain("@request");
  });
});

describe("a token the server doesn't accept answers 401", () => {
  it("a malformed token, on a write and on a public read", async () => {
    const write = await records("/posts", json("POST", { title: "x" }, "not-a-real-token"));
    expect(write.status).toBe(401);
    expect(await write.json()).toEqual(INVALID);
    // The list is public: until 0.44 this answered 200 as anonymous.
    const read = await records("/notes", bearer("not-a-real-token"));
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual(INVALID);
  });

  it("an expired token", async () => {
    const res = await records("/notes", bearer(await expiredToken()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID);
  });

  it("an API token without the scope for the request", async () => {
    const readOnly = await apiToken(["read"]);
    expect((await records("/notes", bearer(readOnly))).status).toBe(200);
    const write = await records("/notes", json("POST", { title: "x" }, readOnly));
    expect(write.status).toBe(401);
    expect(await write.json()).toEqual({ error: "This API token doesn't have the scope for this request", code: 401, reason: "insufficient_scope" });

    const writeOnly = await apiToken(["write"]);
    expect((await records("/notes", json("POST", { title: "x" }, writeOnly))).status).toBe(200);
    expect((await records("/notes", bearer(writeOnly))).status).toBe(401);
    // A token for MCP only is no token for the records API.
    expect((await records("/notes", bearer(await apiToken(["mcp:read"])))).status).toBe(401);
  });

  it("says the same for a collection that is missing, hidden or open", async () => {
    await createCollection({ name: "vault", fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: "", view_rule: "", create_rule: "", update_rule: "", delete_rule: "" });
    for (const name of ["nope", "vault", "notes"]) {
      const res = await records(`/${name}`, bearer("not-a-real-token"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(INVALID);
    }
  });

  it("no token and a good token are unchanged (legitimate paths)", async () => {
    expect((await records("/notes")).status).toBe(200);
    expect((await records("/notes", bearer(userToken))).status).toBe(200);
    expect((await records("/posts", json("POST", { title: "x" }, userToken))).status).toBe(200);
  });

  it("the batch API", async () => {
    const batch = (token?: string) => makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", json("POST", {
      requests: [{ method: "GET", url: "/api/v1/notes" }],
    }, token)));
    const bad = await batch("not-a-real-token");
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual(INVALID);
    expect((await batch()).status).toBe(200);
    expect((await batch(userToken)).status).toBe(200);
  });

  it("the batch API: an API token without the scope for one op, and nothing runs", async () => {
    const run = (token: string, requests: unknown[]) =>
      makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", json("POST", { requests }, token)));
    const create = { method: "POST", url: "/api/v1/notes", body: { title: "from a batch" } };
    const list = { method: "GET", url: "/api/v1/notes" };
    const SCOPE = { error: "This API token doesn't have the scope for this request", code: 401, reason: "insufficient_scope" };

    // Anyone may create notes, so until 0.44 this write ran as anonymous.
    const readOnly = await run(await apiToken(["read"]), [create]);
    expect(readOnly.status).toBe(401);
    expect(await readOnly.json()).toEqual(SCOPE);
    const writeOnly = await run(await apiToken(["write"]), [list]);
    expect(writeOnly.status).toBe(401);
    const after = (await (await records("/notes")).json()) as { totalItems: number };
    expect(after.totalItems).toBe(0);

    // With the scope for every op, the batch runs (legitimate path).
    expect((await run(await apiToken(["write"]), [create])).status).toBe(200);
    expect((await run(await apiToken(["read"]), [list])).status).toBe(200);
    expect((await run(await apiToken(["admin"]), [create])).status).toBe(200);
  });

  it("the files API, before the file is looked up", async () => {
    const files = (path: string, init: RequestInit = {}) =>
      makeFilesPlugin(join(tmpDir, "uploads"), SECRET).handle(new Request(`http://localhost${path}`, init));
    const name = "0123456789abcdef0123456789abcdef.png";
    const bad = await files(`/files/${name}`, bearer("not-a-real-token"));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual(INVALID);
    // Without a token the same request reaches the lookup.
    expect((await files(`/files/${name}`)).status).toBe(404);
    const upload = await files("/files/notes/some-id/cover", { method: "POST", headers: { authorization: "Bearer not-a-real-token" } });
    expect(upload.status).toBe(401);
    expect(await upload.json()).toEqual(INVALID);
  });
});

describe("unknown keys answer 400", () => {
  it("names unknown sort, expand and fields keys", async () => {
    const res = await records("/posts?sort=-titel&expand=autor&fields=id,titel");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Unknown sort field 'titel'; unknown expand 'autor' (not a relation field); unknown field 'titel' in fields",
      code: 400,
      details: {
        sort: "unknown sort field 'titel'",
        expand: "unknown expand 'autor' (not a relation field)",
        fields: "unknown field 'titel' in fields",
      },
    });
    // No Vaultbase-Warning any more: the request is refused instead.
    expect(res.headers.get("vaultbase-warning")).toBeNull();
  });

  it("known keys pass (legitimate path)", async () => {
    const res = await records("/posts?sort=-created,title&expand=author&fields=id,title,expand");
    expect(res.status).toBe(200);
    expect((await records("/users?sort=email&fields=id,email,nick", bearer(userToken))).status).toBe(200);
  });

  it("a body key that isn't a field, on create and update", async () => {
    const create = await records("/notes", json("POST", { title: "x", colour: "red" }));
    expect(create.status).toBe(400);
    expect(await create.json()).toEqual({ error: "Unknown field 'colour' in body", code: 400, details: { colour: "unknown field 'colour' in body" } });
    const rec = await createRecord("notes", { title: "x" }, null);
    const update = await records(`/notes/${rec.id}`, json("PATCH", { titel: "y" }));
    expect(update.status).toBe(400);
    // Nothing was written.
    expect(((await (await records(`/notes/${rec.id}`)).json()) as { data: { title: string } }).data.title).toBe("x");
  });

  it("a private field looks like an unknown one, and valid names aren't listed", async () => {
    const res = await records("/users?sort=password_hash", bearer(userToken));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("unknown sort field 'password_hash'");
    expect(body).not.toContain("nick");
  });

  it("a refused write says 403, not which keys are unknown", async () => {
    const res = await records("/posts", json("POST", { title: "x", colour: "red" }));
    expect(res.status).toBe(403);
  });

  it("a fetched record can be sent back as it came (legitimate path)", async () => {
    // A record as the API returns it carries id, created, updated,
    // collectionId, collectionName and, when expanded, expand.
    const rec = await createRecord("notes", { title: "x", author: userId }, null);
    const fetched = ((await (await records(`/notes/${rec.id}?expand=author`)).json()) as { data: Record<string, unknown> }).data;
    expect(fetched["expand"]).toBeDefined();
    const saved = await records(`/notes/${rec.id}`, json("PATCH", { ...fetched, title: "y" }));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { data: { title: string } }).data.title).toBe("y");

    // The same for a user's own record in an auth collection.
    const me = ((await (await records(`/users/${userId}`, bearer(userToken))).json()) as { data: Record<string, unknown> }).data;
    const savedMe = await records(`/users/${userId}`, json("PATCH", { ...me, nick: "kay" }, userToken));
    expect(savedMe.status).toBe(200);
    expect(((await savedMe.json()) as { data: { nick: string } }).data.nick).toBe("kay");
  });

  it("whatever a read returns can be named in `fields` and saved back (search, vector search, users)", async () => {
    await createCollection({
      name: "docs",
      fields: JSON.stringify([
        { name: "title", type: "text", options: { searchable: true } },
        { name: "emb", type: "vector", options: { dimensions: 2 } },
        { name: "author", type: "relation", collection: "users" },
      ]),
      list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    });
    await createRecord("docs", { title: "apple pie", emb: [1, 0], author: userId }, null);
    type Row = Record<string, unknown> & { id: string };
    const rows = async (path: string, token?: string): Promise<Row[]> => {
      const res = await records(path, token ? bearer(token) : {});
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: Row[] }).data;
    };
    const reads: Array<[string, string, string?]> = [
      ["docs", "/docs?expand=author"],
      // The documented relevance sort for a search.
      ["docs", "/docs?search=apple&sort=@rank"],
      // A vector search adds `_score` to each record.
      ["docs", `/docs?nearVectorField=emb&nearVector=${encodeURIComponent("[1,0]")}`],
      ["users", "/users", userToken],
    ];
    for (const [name, path, token] of reads) {
      const [row] = await rows(path, token);
      expect(row).toBeDefined();
      const keys = Object.keys(row!);
      // Every key of the record is a valid `fields` name on the same read...
      const again = await records(`${path}${path.includes("?") ? "&" : "?"}fields=${encodeURIComponent(keys.join(","))}`, token ? bearer(token) : {});
      expect({ path, status: again.status }).toEqual({ path, status: 200 });
      // ...and the record saves back as it came.
      const saved = await records(`/${name}/${row!.id}`, json("PATCH", row, token));
      expect({ path, status: saved.status }).toEqual({ path, status: 200 });
    }
    expect((await rows(`/docs?nearVectorField=emb&nearVector=${encodeURIComponent("[1,0]")}`))[0]).toHaveProperty("_score");
    // `@rank` is the whole sort value, not a field among others.
    expect((await records("/docs?search=apple&sort=@rank,title")).status).toBe(400);
  });

  it("views aren't checked: their columns come from their query", async () => {
    await createCollection({ name: "titles", type: "view", view_query: "SELECT id, title FROM vb_notes", fields: JSON.stringify([]), list_rule: null, view_rule: null });
    expect((await records("/titles?sort=whatever")).status).toBe(200);
  });
});

describe("register", () => {
  it("a taken email answers 409", async () => {
    const res = await makeAuthPlugin(SECRET).handle(new Request("http://localhost/auth/users/register", json("POST", { email: "u@test.local", password: "another-password-1" })));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Email already registered", code: 409 });
  });
});
