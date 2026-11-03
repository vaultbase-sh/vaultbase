/**
 * Regressions for the third November 2026 security audit pass (run-3):
 * records, batch, filter and OpenAPI findings. Each block reproduces the
 * reported path and expects the fixed behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { makeOpenApiPlugin } from "../api/openapi.ts";
import { createCollection, updateCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, updateRecord } from "../core/records.ts";
import { signAuthToken } from "../core/sec.ts";
import { admin } from "../db/schema.ts";
import { createPublicCollection, seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-audit-run3-records";
const UUID = "00000000-0000-0000-0000-000000000000";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

function req(path: string, init: { method?: string; token?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers["authorization"] = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}
const rec = (path: string, init?: Parameters<typeof req>[1]) => makeRecordsPlugin(SECRET).handle(req(path, init));
const batch = (requests: unknown[], token: string | null = null) =>
  makeBatchPlugin(SECRET).handle(req("/batch", { method: "POST", token, body: { requests } }));

async function adminToken(): Promise<string> {
  await getDb().insert(admin).values({ id: "a1", email: "a@x.io", password_hash: "x", password_reset_at: 0, created_at: 1 });
  return (await signAuthToken({ payload: { id: "a1", email: "a@x.io" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
}

async function userToken(id: string): Promise<string> {
  await seedAuthUser({ collection: "users", id, email: `${id}@x.io` });
  return signUserJwt(id, `${id}@x.io`, "users", SECRET);
}

/** Status and body, with the probed name swapped for a placeholder. */
async function answer(res: Response, name: string): Promise<{ status: number; body: string }> {
  return { status: res.status, body: (await res.text()).split(name).join("<name>") };
}

// ── Expand depth ────────────────────────────────────────────────────────────

describe("expand depth and path caps", () => {
  async function selfLoop(): Promise<string> {
    const c = await createPublicCollection({ name: "nodes", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await updateCollection(c.id, { fields: JSON.stringify([{ name: "title", type: "text" }, { name: "parent", type: "relation", collection: "nodes" }]) });
    const x = await createRecord("nodes", { title: "x" }, null);
    await updateRecord("nodes", x.id, { parent: x.id }, null);
    for (let i = 0; i < 3; i++) await createRecord("nodes", { title: `c${i}`, parent: x.id }, null);
    return x.id;
  }
  const path = (n: number) => Array(n).fill("parent").join(".");

  it("answers 400 to an over-deep expand on list, get-one and batch get", async () => {
    const id = await selfLoop();
    const list = await rec(`/nodes?expand=${path(50)}`);
    expect(list.status).toBe(400);
    const one = await rec(`/nodes/${id}?expand=${path(50)}`);
    expect(one.status).toBe(400);
    const b = await batch([{ method: "GET", url: `/api/v1/nodes/${id}?expand=${path(1000)}` }]);
    expect(b.status).toBe(400);
  });

  it("refuses too many paths, and keeps a six-level expand working", async () => {
    const id = await selfLoop();
    const many = Array(21).fill("parent").join(",");
    expect((await rec(`/nodes?expand=${many}`)).status).toBe(400);
    const ok = await rec(`/nodes/${id}?expand=${path(6)}`);
    expect(ok.status).toBe(200);
    let node = ((await ok.json()) as { data: { expand?: { parent?: unknown } } }).data;
    for (let i = 0; i < 6; i++) node = node.expand!.parent as typeof node;
    expect(node).toBeTruthy();
    expect((await rec(`/nodes/${id}?expand=${path(7)}`)).status).toBe(400);
  });
});

// ── Write responses vs view_rule ────────────────────────────────────────────

describe("write responses respect the view rule", () => {
  async function tickets() {
    await createCollection({
      name: "tickets",
      fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "status", type: "text" }, { name: "private_note", type: "text" }]),
      list_rule: "owner = @request.auth.id",
      view_rule: "owner = @request.auth.id",
      create_rule: `@request.auth.id != ""`,
      update_rule: `@request.auth.id != "" && @request.body.owner:isset = false && @request.body.private_note:isset = false`,
      delete_rule: "",
    });
    const ownerTok = await userToken("u-owner");
    const otherTok = await userToken("u-other");
    const t = await createRecord("tickets", { owner: "u-owner", status: "open", private_note: "V3-DUMMY-NOTE" }, null);
    return { ownerTok, otherTok, id: t.id };
  }

  it("PATCH by an update-permitted, view-denied caller returns no record and no ETag", async () => {
    const { otherTok, id } = await tickets();
    expect((await rec(`/tickets/${id}`, { token: otherTok })).status).toBe(403);
    const res = await rec(`/tickets/${id}`, { method: "PATCH", token: otherTok, body: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ data: null });
    expect(text).not.toContain("V3-DUMMY-NOTE");
  });

  it("the owner and admins still get the record and its ETag", async () => {
    const { ownerTok, id } = await tickets();
    const res = await rec(`/tickets/${id}`, { method: "PATCH", token: ownerTok, body: { status: "closed" } });
    expect(res.headers.get("etag")).toBeTruthy();
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe("closed");
    const adm = await rec(`/tickets/${id}`, { method: "PATCH", token: await adminToken(), body: {} });
    expect(((await adm.json()) as { data: { private_note: string } }).data.private_note).toBe("V3-DUMMY-NOTE");
  });

  it("412 leaves out the ETag for a caller who can't view the record", async () => {
    const { ownerTok, otherTok, id } = await tickets();
    const other = await rec(`/tickets/${id}`, { method: "PATCH", token: otherTok, body: {}, headers: { "if-match": `W/"stale"` } });
    expect(other.status).toBe(412);
    expect(other.headers.get("etag")).toBeNull();
    const owner = await rec(`/tickets/${id}`, { method: "PATCH", token: ownerTok, body: {}, headers: { "if-match": `W/"stale"` } });
    expect(owner.status).toBe(412);
    expect(owner.headers.get("etag")).toBeTruthy();
  });

  it("batch update and create ops return a null body to a view-denied caller", async () => {
    const { otherTok, id } = await tickets();
    const up = await batch([{ method: "PATCH", url: `/api/v1/tickets/${id}`, body: {} }], otherTok);
    expect(up.status).toBe(200);
    const upText = await up.text();
    expect(upText).not.toContain("V3-DUMMY-NOTE");
    expect((JSON.parse(upText) as { data: Array<{ body: unknown }> }).data[0]!.body).toBeNull();
    const cr = await batch([{ method: "POST", url: "/api/v1/tickets", body: { owner: "u-owner", private_note: "planted" } }], otherTok);
    expect(cr.status).toBe(200);
    const crBody = (await cr.json()) as { data: Array<{ status: number; body: unknown }> };
    expect(crBody.data[0]!.status).toBe(201);
    expect(crBody.data[0]!.body).toBeNull();
  });

  it("POST create returns null for a record its creator can't view, and the record for one they can", async () => {
    const { otherTok } = await tickets();
    const hidden = await rec("/tickets", { method: "POST", token: otherTok, body: { owner: "u-owner" } });
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toEqual({ data: null });
    const mine = await rec("/tickets", { method: "POST", token: otherTok, body: { owner: "u-other", status: "new" } });
    expect(((await mine.json()) as { data: { status: string } }).data.status).toBe("new");
  });

  it("the singleton PATCH returns null to a view-denied caller", async () => {
    await createCollection({
      name: "site", type: "singleton",
      fields: JSON.stringify([{ name: "motto", type: "text" }]),
      view_rule: "", update_rule: `@request.auth.id != ""`,
    });
    const tok = await userToken("u1");
    const res = await rec("/site", { method: "PATCH", token: tok, body: { motto: "hi" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect(await res.json()).toEqual({ data: null });
  });
});

// ── Collection-name oracles on records and batch ────────────────────────────

describe("admin-only collections answer like missing ones", () => {
  async function setup() {
    await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createCollection({ name: "hr_salaries", fields: JSON.stringify([{ name: "amount", type: "number" }, { name: "employee", type: "text" }]) });
    await createCollection({
      name: "hr_report", type: "view",
      view_query: "SELECT id, amount FROM vb_hr_salaries WHERE employee = :emp_code",
      view_params: JSON.stringify([{ name: "emp_code", type: "text", required: true }]),
    });
    await createCollection({ name: "hr_settings", type: "singleton", fields: JSON.stringify([{ name: "k", type: "text" }]) });
    await createRecord("hr_salaries", { amount: 1, employee: "e1" }, null);
  }

  const probes: Array<[string, (n: string) => Parameters<typeof req>]> = [
    ["list", (n) => [`/${n}`]],
    ["get", (n) => [`/${n}/${UUID}`]],
    ["get with params", (n) => [`/${n}/${UUID}?params[x]=1`]],
    ["aggregate", (n) => [`/${n}/_aggregate`]],
    ["create", (n) => [`/${n}`, { method: "POST", body: {} }]],
    ["update", (n) => [`/${n}/${UUID}`, { method: "PATCH", body: {} }]],
    ["singleton-path update", (n) => [`/${n}`, { method: "PATCH", body: {} }]],
    ["delete", (n) => [`/${n}/${UUID}`, { method: "DELETE" }]],
    ["history", (n) => [`/${n}/${UUID}/history`]],
    ["restore", (n) => [`/${n}/${UUID}/restore?at=1`, { method: "POST" }]],
  ];

  for (const [label, make] of probes) {
    it(`${label}: same answer for hidden base, view and singleton collections as for none`, async () => {
      await setup();
      const absent = await answer(await rec(...make("hr_nothing")), "hr_nothing");
      expect(absent.status).toBe(404);
      for (const n of ["hr_salaries", "hr_report", "hr_settings"]) {
        expect(await answer(await rec(...make(n)), n)).toEqual(absent);
      }
    });
  }

  it("a collection the caller can read keeps its 403 and 405 answers", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: null, view_rule: null });
    await createCollection({ name: "site", type: "singleton", fields: JSON.stringify([{ name: "t", type: "text" }]), view_rule: null });
    expect((await rec("/posts", { method: "POST", body: {} })).status).toBe(403);
    expect((await rec("/site", { method: "POST", body: {} })).status).toBe(405);
  });

  it("a signed-in user gets the same answer too; admins still reach the collection", async () => {
    await setup();
    const tok = await userToken("u1");
    expect(await answer(await rec("/hr_salaries", { token: tok }), "hr_salaries"))
      .toEqual(await answer(await rec("/hr_nothing", { token: tok }), "hr_nothing"));
    expect((await rec("/hr_salaries", { token: await adminToken() })).status).toBe(200);
  });

  it("batch ops answer hidden collections like missing ones", async () => {
    await setup();
    const ops = (n: string) => [
      { method: "GET", url: `/api/v1/${n}` },
      { method: "GET", url: `/api/v1/${n}/${UUID}` },
    ];
    const absent = await answer(await batch(ops("hr_nothing")), "hr_nothing");
    expect(absent.status).toBe(200);
    for (const n of ["hr_salaries", "hr_report", "hr_settings"]) {
      expect(await answer(await batch(ops(n)), n)).toEqual(absent);
    }
    const write = (n: string) => batch([{ method: "POST", url: `/api/v1/${n}`, body: {} }]);
    const absentW = await answer(await write("hr_nothing"), "hr_nothing");
    expect(absentW.status).toBe(404);
    for (const n of ["hr_salaries", "hr_report", "hr_settings"]) {
      expect(await answer(await write(n), n)).toEqual(absentW);
    }
  });
});

// ── @collection / _via_ name and field oracles ──────────────────────────────

describe("cross-collection filter operands don't confirm hidden names or fields", () => {
  async function setup() {
    await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("notes", { title: "n" }, null);
    await createCollection({ name: "hr_salaries", fields: JSON.stringify([{ name: "amount", type: "number" }, { name: "employee", type: "text" }, { name: "note", type: "text" }]) });
    await createRecord("hr_salaries", { amount: 1, employee: "e1" }, null);
    await createPublicCollection({
      name: "comments",
      fields: JSON.stringify([{ name: "note", type: "text" }, { name: "pin", type: "password" }, { name: "body", type: "text" }]),
    });
  }
  const list = async (filter: string, token: string | null = null) =>
    rec(`/notes?filter=${encodeURIComponent(filter)}`, { token });
  const agg = async (filter: string) => rec(`/notes/_aggregate?agg=count&filter=${encodeURIComponent(filter)}`);

  const shapes: Array<[string, (n: string, f: string) => string]> = [
    ["@collection joined", (n, f) => `@collection.${n}.${f} = "x"`],
    ["@collection negated", (n, f) => `@collection.${n}.${f} != "x"`],
    ["_via_ path", (n, f) => `${n}_via_${f}.id ?= "x"`],
    ["_via_ length", (n, f) => `${n}_via_${f}:length > 0`],
  ];

  for (const [label, shape] of shapes) {
    it(`${label}: hidden collection = missing collection, real field = fake field`, async () => {
      await setup();
      const absent = await answer(await list(shape("hr_nothing", "employee")), "hr_nothing");
      expect(absent.status).toBe(400);
      const n = "hr_salaries";
      expect(await answer(await list(shape(n, "employee")), n)).toEqual(absent);
      expect(await answer(await list(shape(n, "no_field_q")), n)).toEqual(absent);
      expect(await answer(await agg(shape(n, "employee")), n)).toEqual(await answer(await agg(shape("hr_nothing", "employee")), "hr_nothing"));
    });
  }

  it("a _via_ ref field that is private answers like one that doesn't exist", async () => {
    await setup();
    const fake = await list(`comments_via_nope.id ?= "x"`);
    const priv = await list(`comments_via_pin.id ?= "x"`);
    expect(fake.status).toBe(400);
    expect(await answer(priv, "pin")).toEqual(await answer(fake, "nope"));
  });

  it("admins keep the specific errors and can join hidden collections", async () => {
    await setup();
    const tok = await adminToken();
    const absent = await list(`@collection.hr_nothing.id != ""`, tok);
    expect(absent.status).toBe(400);
    expect(await absent.text()).toContain("unknown collection");
    expect((await list(`@collection.hr_salaries.employee = "e1"`, tok)).status).toBe(200);
    const ref = await list(`comments_via_nope.id ?= "x"`, tok);
    expect(await ref.text()).toContain("back-relation ref field");
  });
});

// ── OpenAPI ─────────────────────────────────────────────────────────────────

describe("public OpenAPI document", () => {
  const spec = async () => {
    setSetting("api.openapi_public", "1");
    const res = await makeOpenApiPlugin(SECRET).handle(new Request("http://localhost/openapi.json"));
    expect(res.status).toBe(200);
    return res.text();
  };

  it("leaves out collections whose rules are blank but not empty", async () => {
    const c = await createCollection({ name: "vault_notes", fields: JSON.stringify([{ name: "acct_no", type: "text" }]) });
    await updateCollection(c.id, { list_rule: "\t", view_rule: "\n", create_rule: "  " });
    expect(await spec()).not.toContain("vault_notes");
  });

  it("doesn't name a hidden collection a relation points at", async () => {
    await createCollection({ name: "staff_private", fields: JSON.stringify([{ name: "n", type: "text" }]) });
    await createPublicCollection({ name: "articles", fields: JSON.stringify([{ name: "ref", type: "relation", collection: "staff_private" }, { name: "next", type: "relation", collection: "articles" }]) });
    const text = await spec();
    expect(text).not.toContain("staff_private");
    expect(text).toContain("Record id in 'articles'");
  });
});
