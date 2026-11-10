/**
 * Rate limit rules apply first match first, so their order matters, and the
 * admin can now reorder them (0.43). Counters are keyed by the rule, not its
 * position, so a rule keeps its own count when the list is reordered.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Elysia from "elysia";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateRateLimitCache, makeRateLimitPlugin } from "../api/ratelimit.ts";

const SECRET = "test-secret-ratelimit-order";
const STRICT = { label: "/api/thing", max: 1, windowMs: 60_000, audience: "all" };
const BROAD = { label: "*", max: 100, windowMs: 60_000, audience: "all" };

async function rules(list: object[]) {
  await setSetting("rate_limit.rules", JSON.stringify(list));
  invalidateRateLimitCache();
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await setSetting("rate_limit.enabled", "1");
});

afterEach(async () => { invalidateRateLimitCache(); await closeDb(); });

const app = () => new Elysia().use(makeRateLimitPlugin(SECRET)).get("/api/thing", () => "ok");
const hit = () => app().handle(new Request("http://localhost/api/thing"));

describe("rule order", () => {
  it("a broad rule above a specific one wins", async () => {
    await rules([BROAD, STRICT]);
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
  });

  it("the specific rule wins once it is moved above", async () => {
    await rules([STRICT, BROAD]);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });
});
