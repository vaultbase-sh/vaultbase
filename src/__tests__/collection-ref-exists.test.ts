/**
 * `@collection.members.user = @request.auth.id` compiled to
 * `(SELECT user FROM vb_members LIMIT 1) = ?`: it compared against one
 * arbitrary row, so only whichever member came first passed. A comparison
 * with an `@collection.*` operand now means "some row of that collection
 * (that the caller may view) matches".
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, getCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-collection-ref";
const ids: Record<string, string> = {};

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  for (const n of ["alice", "bob", "carol"]) ids[n] = await seedAuthUser({ collection: "users", email: `${n}@test.local` });
  await createCollection({
    name: "members", fields: JSON.stringify([{ name: "user", type: "text" }, { name: "role", type: "text" }]),
    list_rule: null, view_rule: null,
  });
  await createRecord("members", { user: ids["alice"], role: "editor" }, null);
  await createRecord("members", { user: ids["bob"], role: "viewer" }, null);
});

afterEach(() => closeDb());

async function count(rule: string, who: string): Promise<number> {
  await createCollection({ name: "docs", fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: rule, view_rule: rule });
  await createRecord("docs", { t: "x" }, null);
  const res = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/docs", {
    headers: { authorization: `Bearer ${await signUserJwt(ids[who]!, `${who}@test.local`, "users", SECRET)}` },
  }));
  return ((await res.json()) as { data: unknown[] }).data.length;
}

describe("@collection.* comparisons", () => {
  it("match any row, not just the first", async () => {
    expect(await count("@collection.members.user = @request.auth.id", "bob")).toBe(1);
  });

  it("still refuse a caller with no matching row", async () => {
    expect(await count("@collection.members.user = @request.auth.id", "carol")).toBe(0);
  });

  it("the first row's member keeps access (legitimate path)", async () => {
    expect(await count("@collection.members.user = @request.auth.id", "alice")).toBe(1);
  });

  it("the reference on the right works the same way", async () => {
    expect(await count("@request.auth.id = @collection.members.user", "bob")).toBe(1);
  });

  it("so does ~", async () => {
    expect(await count('@collection.members.role ~ "view"', "bob")).toBe(1);
  });
});

describe("@collection.* on the right of ~", () => {
  it("uses each row's value as the pattern", async () => {
    // bob's role "viewer" is contained in "viewers-only"; alice's isn't.
    expect(await count('"viewers-only" ~ @collection.members.role', "carol")).toBe(1);
  });
});

describe("@collection.* row binding (review 16)", () => {
  async function docsByGroup(rule: string, who: string): Promise<string[]> {
    await createCollection({ name: "gdocs", fields: JSON.stringify([{ name: "grp", type: "text" }]), list_rule: rule, view_rule: rule });
    await createRecord("gdocs", { grp: "A" }, null);
    await createRecord("gdocs", { grp: "B" }, null);
    const res = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/gdocs", {
      headers: { authorization: `Bearer ${await signUserJwt(ids[who]!, `${who}@test.local`, "users", SECRET)}` },
    }));
    return ((await res.json()) as { data: Array<{ grp: string }> }).data.map((d) => d.grp).sort();
  }

  beforeEach(async () => {
    await createCollection({
      name: "gm", fields: JSON.stringify([{ name: "user", type: "text" }, { name: "grp", type: "text" }]),
      list_rule: null, view_rule: null,
    });
    await createRecord("gm", { user: ids["alice"], grp: "A" }, null);
    await createRecord("gm", { user: ids["carol"], grp: "B" }, null);
  });

  it("two conditions on one collection must hold on the same row (F-1)", async () => {
    const rule = "@collection.gm.grp = grp && @collection.gm.user = @request.auth.id";
    expect(await docsByGroup(rule, "carol")).toEqual(["B"]);
  });

  it("the same rule still serves members their own group (legitimate path)", async () => {
    const rule = "@collection.gm.grp = grp && @collection.gm.user = @request.auth.id";
    expect(await docsByGroup(rule, "alice")).toEqual(["A"]);
  });

  it("an OR branch without the lookup still passes when nothing joins", async () => {
    expect(await docsByGroup('grp = "A" || @collection.gm.user = "nobody"', "bob")).toEqual(["A"]);
  });

  it("!= against @collection means no row matches: a two-entry ban list bans both (F-1b)", async () => {
    await createCollection({ name: "bans", fields: JSON.stringify([{ name: "user", type: "text" }]), list_rule: null, view_rule: null });
    await createRecord("bans", { user: ids["alice"] }, null);
    await createRecord("bans", { user: ids["bob"] }, null);
    const rule = "@collection.bans.user != @request.auth.id";
    expect(await docsByGroup(rule, "bob")).toEqual([]);
  });

  it("…and doesn't ban anyone else", async () => {
    await createCollection({ name: "bans", fields: JSON.stringify([{ name: "user", type: "text" }]), list_rule: null, view_rule: null });
    await createRecord("bans", { user: ids["alice"] }, null);
    await createRecord("bans", { user: ids["bob"] }, null);
    expect(await docsByGroup("@collection.bans.user != @request.auth.id", "carol")).toEqual(["A", "B"]);
  });
});

describe("@collection.* review 17 follow-ups", () => {
  async function docs(rule: string | null, who: string | null, filter?: string): Promise<{ status: number; n: number }> {
    await createCollection({ name: "rdocs", fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: rule, view_rule: rule });
    await createRecord("rdocs", { t: "x" }, null);
    const headers: Record<string, string> = who ? { authorization: `Bearer ${await signUserJwt(ids[who]!, `${who}@test.local`, "users", SECRET)}` } : {};
    const q = filter ? `?filter=${encodeURIComponent(filter)}` : "";
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/rdocs${q}`, { headers }));
    const body = await res.json() as { data?: unknown[] };
    return { status: res.status, n: body.data?.length ?? 0 };
  }

  it("a hidden (admin-only) ban list fails closed for != (F-2)", async () => {
    await createCollection({ name: "hbans", fields: JSON.stringify([{ name: "user", type: "text" }]), list_rule: "", view_rule: "" });
    await createRecord("hbans", { user: ids["bob"] }, null);
    expect((await docs("@collection.hbans.user != @request.auth.id", "bob")).n).toBe(0);
  });

  it("!= with a modifier still means no row matches (F-4)", async () => {
    await createCollection({ name: "ebans", fields: JSON.stringify([{ name: "email", type: "text" }]), list_rule: null, view_rule: null });
    await createRecord("ebans", { email: "ALICE@test.local" }, null);
    await createRecord("ebans", { email: "BOB@test.local" }, null);
    expect((await docs("@collection.ebans.email:lower != @request.auth.email", "bob")).n).toBe(0);
  });

  it("…and lets everyone else through (legitimate path)", async () => {
    await createCollection({ name: "ebans", fields: JSON.stringify([{ name: "email", type: "text" }]), list_rule: null, view_rule: null });
    await createRecord("ebans", { email: "ALICE@test.local" }, null);
    expect((await docs("@collection.ebans.email:lower != @request.auth.email", "carol")).n).toBe(1);
  });

  it("a client filter can't stack @collection aliases into a cross join (F-1)", async () => {
    const r = await docs(null, null, '@collection.members:a.role != "" && @collection.members:b.role != "" && @collection.members:c.role = @collection.members:d.role');
    expect(r.status).toBe(400);
  });

  it("a client filter may still use one @collection reference", async () => {
    const r = await docs(null, "bob", "@collection.members.user = @request.auth.id");
    expect(r).toEqual({ status: 200, n: 1 });
  });
});

describe("@collection.* review 18 follow-ups", () => {
  async function listWith(filter: string, who: string | null): Promise<{ status: number; n: number }> {
    if (!(await getCollection("fdocs"))) {
      await createCollection({ name: "fdocs", fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: null, view_rule: null });
      await createRecord("fdocs", { t: "x" }, null);
    }
    const headers: Record<string, string> = who ? { authorization: `Bearer ${await signUserJwt(ids[who]!, `${who}@test.local`, "users", SECRET)}` } : {};
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/fdocs?filter=${encodeURIComponent(filter)}`, { headers }));
    return { status: res.status, n: ((await res.json()) as { data?: unknown[] }).data?.length ?? 0 };
  }

  it("a client filter can't pair two cross-collection operands (F-1)", async () => {
    await createCollection({ name: "fposts", fields: JSON.stringify([{ name: "body", type: "text" }]), list_rule: null, view_rule: null });
    await createCollection({
      name: "fcomments",
      fields: JSON.stringify([{ name: "post", type: "relation", collection: "fposts" }, { name: "body", type: "text" }]),
      list_rule: null, view_rule: null,
    });
    expect((await listWith("@collection.members.role != fcomments_via_post.body", null)).status).toBe(400);
  });

  it("a hidden collection's contents don't show through a negation (F-2)", async () => {
    await createCollection({ name: "secrets", fields: JSON.stringify([{ name: "v", type: "text" }]), list_rule: "", view_rule: "" });
    const empty = await listWith('@collection.secrets.v != "x"', null);
    await createRecord("secrets", { v: "y" }, null);
    const filled = await listWith('@collection.secrets.v != "x"', null);
    expect(empty).toEqual(filled);
  });

  it("two negations over a collection whose view rule uses @collection still compile (F-4)", async () => {
    await createCollection({
      name: "gbans", fields: JSON.stringify([{ name: "user", type: "text" }]),
      list_rule: "@collection.members.user = @request.auth.id", view_rule: "@collection.members.user = @request.auth.id",
    });
    await createCollection({
      name: "g2docs", fields: JSON.stringify([{ name: "t", type: "text" }]),
      list_rule: "@collection.gbans.user != @request.auth.id && @collection.gbans.user != \"x\"",
      view_rule: null,
    });
    const res = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/g2docs", {
      headers: { authorization: `Bearer ${await signUserJwt(ids["bob"]!, "bob@test.local", "users", SECRET)}` },
    }));
    expect(res.status).toBe(200);
  });
});
