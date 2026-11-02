/**
 * Startup read the collection list once per step (five times on every
 * start); it reads it once now and the steps share it.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

describe("startup", () => {
  it("reads the collection list once", async () => {
    await createCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text", options: { searchable: true } }, { name: "at", type: "autodate", options: { onCreate: true } }]) });
    await createCollection({ name: "members", type: "auth", fields: JSON.stringify([{ name: "nick", type: "text" }]) });
    const statements: string[] = [];
    db.trace((sql) => statements.push(sql));
    try {
      await runMigrations();
    } finally {
      db.trace(null);
    }
    expect(statements.filter((q) => /FROM vaultbase_collections/i.test(q))).toHaveLength(1);
  });
});
