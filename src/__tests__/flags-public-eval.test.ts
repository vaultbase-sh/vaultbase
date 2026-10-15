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
