/**
 * Closing the database drops every cache bound to the connection before
 * closeDb returns. It used to happen through a lazy import, a few ticks
 * later, so a reopened database could briefly be read through statements
 * of the closed one.
 */
import { describe, expect, it } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, getCollectionCached } from "../core/collections.ts";
import { listRecords, _preparedStatementCount } from "../core/records.ts";
import { tableColumns } from "../core/users-table.ts";
import { createPublicCollection } from "./_helpers.ts";

describe("closeDb", () => {
  it("clears the statement, column and collection caches synchronously", async () => {
    initDb(":memory:");
    await runMigrations();
    await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await listRecords("posts", {});
    expect(_preparedStatementCount()).toBeGreaterThan(0);
    expect(tableColumns("posts")).toContain("title");
    expect(getCollectionCached("posts")).not.toBeNull();
    closeDb();
    expect(_preparedStatementCount()).toBe(0);
    expect(getCollectionCached("posts")).toBeNull();
    // A fresh database with the same collection works at once.
    initDb(":memory:");
    await runMigrations();
    await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "extra", type: "text" }]) });
    expect(tableColumns("posts")).toContain("extra");
    expect((await listRecords("posts", {})).totalItems).toBe(0);
    _resetCollectionCache();
    closeDb();
  });
});
