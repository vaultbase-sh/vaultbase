import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord, getRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";

const SECRET = "test-secret-etag-concurrency";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

const FIELDS = [{ name: "title", type: "text" }];

async function withCollection() {
  await createCollection({ name: "posts", fields: JSON.stringify(FIELDS) });
}

describe("ETag emission", () => {
  it("GET /:collection/:id returns a weak ETag matching updated_at", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "x" }, null);
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`));
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^W\/"\d+"$/);
    const u = (await getRecord("posts", r.id))!["updated"];
    expect(etag).toBe(`W/"${u}"`);
  });

  it("PATCH echoes the new ETag on success", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "v1" }, null);
    const app = makeRecordsPlugin(SECRET);
    // Wait so updated_at advances (1-sec resolution).
    await new Promise((res) => setTimeout(res, 1100));
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "v2" }),
    }));
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^W\/"\d+"$/);
  });
});

describe("If-Match precondition", () => {
  it("PATCH with matching If-Match succeeds (200)", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "v1" }, null);
    const u = (await getRecord("posts", r.id))!["updated"];
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": `W/"${u}"` },
      body: JSON.stringify({ title: "v2" }),
    }));
    expect(res.status).toBe(200);
  });

  it("PATCH with stale If-Match returns 412 + current ETag", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "v1" }, null);
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": `W/"99999999"` },
      body: JSON.stringify({ title: "v2" }),
    }));
    expect(res.status).toBe(412);
    expect(res.headers.get("etag")).toMatch(/^W\/"\d+"$/);
  });

  it("If-Match: * matches any existing record", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "v1" }, null);
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": "*" },
      body: JSON.stringify({ title: "v2" }),
    }));
    expect(res.status).toBe(200);
  });

  it("DELETE with stale If-Match returns 412", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "v1" }, null);
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`, {
      method: "DELETE",
      headers: { "If-Match": `W/"42"` },
    }));
    expect(res.status).toBe(412);
  });

  it("Strong-form If-Match accepts server's weak ETag (RFC 7232 weak compare)", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "v1" }, null);
    const u = (await getRecord("posts", r.id))!["updated"];
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": `"${u}"` },
      body: JSON.stringify({ title: "v2" }),
    }));
    expect(res.status).toBe(200);
  });
});

describe("If-None-Match (cheap conditional GET)", () => {
  it("returns 304 when ETag matches", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "v1" }, null);
    const u = (await getRecord("posts", r.id))!["updated"];
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`, {
      headers: { "If-None-Match": `W/"${u}"` },
    }));
    expect(res.status).toBe(304);
  });

  it("returns 200 when ETag mismatches", async () => {
    await withCollection();
    const r = await createRecord("posts", { title: "v1" }, null);
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}`, {
      headers: { "If-None-Match": `W/"0"` },
    }));
    expect(res.status).toBe(200);
  });
});
