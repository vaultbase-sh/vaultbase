/**
 * `POST /flags/evaluate` takes a caller-supplied targeting context, so a
 * caller could claim to be any user (`{ auth: { id: "<someone>" } }`) and
 * read the treatment meant for them. The server now sets `auth` itself from
 * the caller's session (absent for anonymous callers), so rules targeting
 * `auth.*` can be trusted; and `flags.public_evaluate = 0` requires a
 * signed-in caller altogether.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { upsertFlag } from "../core/flags.ts";
import { makeFlagsPlugin } from "../api/flags.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-flags-eval";
let vip: string;

beforeEach(async () => {
  _resetCollectionCache();
  await initDb(":memory:");
  await runMigrations();
  vip = await seedAuthUser({ collection: "users", email: "vip@test.local" });
  await upsertFlag({
    key: "vip_feature", type: "bool", enabled: true, default_value: false,
    rules: [{ id: "r1", when: { attr: "auth.id", op: "eq", value: vip }, variation: "true" }],
  } as Parameters<typeof upsertFlag>[0]);
});

afterEach(() => closeDb());

const evaluate = (context: unknown, bearer?: string) =>
  makeFlagsPlugin(SECRET).handle(new Request("http://localhost/flags/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ context, keys: ["vip_feature"] }),
  }));

describe("public flag evaluation", () => {
  it("a caller can't claim someone else's auth.id", async () => {
    const res = await evaluate({ auth: { id: vip } });
    expect((await res.json() as { data: Record<string, unknown> }).data["vip_feature"]).toBe(false);
  });

  it("the signed-in user gets their own treatment (legitimate path)", async () => {
    const jwt = await signUserJwt(vip, "vip@test.local", "users", SECRET);
    const res = await evaluate({}, jwt);
    expect((await res.json() as { data: Record<string, unknown> }).data["vip_feature"]).toBe(true);
  });

  it("flags.public_evaluate = 0 requires a signed-in caller", async () => {
    setSetting("flags.public_evaluate", "0");
    expect((await evaluate({})).status).toBe(401);
    const jwt = await signUserJwt(vip, "vip@test.local", "users", SECRET);
    expect((await evaluate({}, jwt)).status).toBe(200);
  });
});

describe("admin flag create and update", () => {
  async function adminToken(): Promise<string> {
    const { getDb } = await import("../db/client.ts");
    const { admin } = await import("../db/schema.ts");
    const { signAuthToken } = await import("../core/sec.ts");
    await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    return (await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 3600, jwtSecret: SECRET })).token;
  }
  const call = async (method: string, path: string, body: unknown, token: string) =>
    makeFlagsPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    }));

  it("POST of an existing key is a 409, PATCH of a missing one a 404", async () => {
    const token = await adminToken();
    expect((await call("POST", "/admin/flags", { key: "vip_feature", enabled: false }, token)).status).toBe(409);
    expect((await call("PATCH", "/admin/flags/nope", { enabled: true }, token)).status).toBe(404);
    expect((await call("POST", "/admin/flags", { key: "fresh", type: "bool" }, token)).status).toBe(200);
    expect((await call("PATCH", "/admin/flags/fresh", { enabled: true }, token)).status).toBe(200);
  });
});
