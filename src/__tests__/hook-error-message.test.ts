/**
 * A before-hook's failure reaches the client as `_hook`. Its own message
 * does; a database error from helpers.sql named tables and columns, and now
 * stays in the server log.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { hooks } from "../db/schema.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { createRecord } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
});
afterEach(async () => {
  invalidateHookCache();
  await closeDb();
});

async function hook(code: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await getDb().delete(hooks);
  await getDb().insert(hooks).values({ id: crypto.randomUUID(), name: "check", collection_name: "posts", event: "beforeCreate", code, enabled: 1, created_at: now, updated_at: now });
  invalidateHookCache();
}

const refusal = async () => {
  try { await createRecord("posts", { title: "t" }, null); return null; }
  catch (e) { return JSON.stringify((e as { details?: unknown }).details ?? (e as Error).message); }
};

describe("before-hook errors", () => {
  it("a database error doesn't reach the client", async () => {
    await hook("await ctx.helpers.sql.query('SELECT secret_col FROM vb_hidden_table', []);");
    const err = console.error; console.error = () => {};
    try {
      const msg = await refusal();
      expect(msg).not.toBeNull();
      expect(msg!).not.toContain("vb_hidden_table");
      expect(msg!).toContain("check");
    } finally { console.error = err; }
  });

  it("the hook's own message does (legitimate path)", async () => {
    await hook("throw new Error('Titles need a capital letter');");
    expect(await refusal()).toContain("Titles need a capital letter");
  });
});
