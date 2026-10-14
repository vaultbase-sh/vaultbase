import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { dbScopedTtlCache } from "../core/ttl-cache.ts";

beforeAll(() => { initDb(":memory:"); });
afterAll(() => { closeDb(); });

describe("dbScopedTtlCache", () => {
  test("a lazy thenable (drizzle query builder) runs once per TTL, not once per await", async () => {
    let runs = 0;
    // Same shape as a drizzle builder: nothing happens until `.then` is called,
    // and every `.then` call runs the query again.
    const lazy: PromiseLike<number> = {
      then(onOk, onErr) {
        runs++;
        return Promise.resolve(42).then(onOk, onErr);
      },
    };
    const cache = dbScopedTtlCache(60_000, () => lazy);
    expect(await cache.get()).toBe(42);
    expect(await cache.get()).toBe(42);
    expect(await cache.get()).toBe(42);
    expect(runs).toBe(1);
  });

  test("invalidate forces a fresh load", async () => {
    let runs = 0;
    const cache = dbScopedTtlCache(60_000, async () => ++runs);
    await cache.get();
    cache.invalidate();
    expect(await cache.get()).toBe(2);
  });
});
