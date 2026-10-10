import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  createCollection, updateCollection, CollectionValidationError, _resetCollectionCache,
} from "../core/collections.ts";
import { createRecord } from "../core/records.ts";

// alterUserTable emitted `ADD COLUMN "x" TEXT UNIQUE`, which SQLite rejects
// ("Cannot add a UNIQUE column"), so adding a unique field to an existing
// collection 500'd. Toggling `unique` on an existing field did nothing at the
// database level.

const F = (fields: object[]) => JSON.stringify(fields);
let colId: string;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  colId = (await createCollection({ name: "items", fields: F([{ name: "title", type: "text" }]) })).id;
  await createRecord("items", { title: "a" });
  await createRecord("items", { title: "b" });
});

afterEach(() => {
  _resetCollectionCache();
  closeDb();
});

describe("unique fields on existing collections", () => {
  it("adds a new unique field and enforces it", async () => {
    await updateCollection(colId, {
      fields: F([{ name: "title", type: "text" }, { name: "sku", type: "text", options: { unique: true } }]),
    });
    await createRecord("items", { title: "c", sku: "X-1" });
    await expect(createRecord("items", { title: "d", sku: "X-1" })).rejects.toThrow();
  });

  it("turning unique on enforces it; turning it off lifts it", async () => {
    await updateCollection(colId, { fields: F([{ name: "title", type: "text", options: { unique: true } }]) });
    await expect(createRecord("items", { title: "a" })).rejects.toThrow();

    await updateCollection(colId, { fields: F([{ name: "title", type: "text" }]) });
    await createRecord("items", { title: "a" }); // duplicate allowed again
  });

  it("turning unique on over duplicate data is refused with a validation error", async () => {
    await createRecord("items", { title: "a" }); // now two "a"
    await expect(
      updateCollection(colId, { fields: F([{ name: "title", type: "text", options: { unique: true } }]) }),
    ).rejects.toBeInstanceOf(CollectionValidationError);
  });

  it("unique index follows a collection rename and can still be toggled off", async () => {
    await updateCollection(colId, {
      fields: F([{ name: "title", type: "text" }, { name: "sku", type: "text", options: { unique: true } }]),
    });
    await updateCollection(colId, { name: "products" });
    await createRecord("products", { title: "c", sku: "S-1" });
    await expect(createRecord("products", { title: "d", sku: "S-1" })).rejects.toThrow();
    await updateCollection(colId, {
      fields: F([{ name: "title", type: "text" }, { name: "sku", type: "text" }]),
    });
    await createRecord("products", { title: "e", sku: "S-1" });
  });

  it("a unique field added later can be dropped again", async () => {
    await updateCollection(colId, {
      fields: F([{ name: "title", type: "text" }, { name: "sku", type: "text", options: { unique: true } }]),
    });
    await updateCollection(colId, { fields: F([{ name: "title", type: "text" }]) });
    await createRecord("items", { title: "z" });
  });
});
