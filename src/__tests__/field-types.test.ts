/**
 * Field types an extension registers: stored, validated, normalised and
 * returned like the built-ins, and described in the OpenAPI document.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, getCollection, updateCollection } from "../core/collections.ts";
import { createRecord, getRecord, updateRecord } from "../core/records.ts";
import { listFieldTypes, registerFieldType } from "../core/field-types.ts";
import { buildOpenApi } from "../core/openapi.ts";
import { ValidationError } from "../core/validate.ts";
import { onSqlite } from "./_helpers.ts";

const offs: Array<() => void> = [];

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  // Whole cents, written as "12.50" or 12.5, stored as an integer.
  offs.push(registerFieldType({
    type: "money",
    sqlType: "INTEGER",
    validate: (v, f) => (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v)) ? null : `${f.name} must be an amount`),
    normalize: (v) => Math.round(Number(v) * 100),
    decode: (v) => Number(v) / 100,
    openapi: () => ({ type: "number", multipleOf: 0.01 }),
  }));
  offs.push(registerFieldType({ type: "point3", json: true }));
});

afterEach(async () => {
  for (const off of offs.splice(0)) off();
  await closeDb();
});

describe("custom field types", () => {
  it("uses the type's column type, normalise and decode", async () => {
    await createCollection({
      name: "orders",
      fields: JSON.stringify([{ name: "total", type: "money" }, { name: "at", type: "point3" }]),
    });
    if (onSqlite) {
      const cols = await db.all<{ name: string; type: string }>(`PRAGMA table_info("vb_orders")`);
      expect(cols.find((c) => c.name === "total")?.type).toBe("INTEGER");
    }

    const r = await createRecord("orders", { total: "12.50", at: { x: 1, y: 2, z: 3 } }, null);
    const raw = (await db.get<{ total: number; at: string }>(`SELECT total, at FROM vb_orders WHERE id = ?`, [r.id]))!;
    expect(raw.total).toBe(1250);
    expect(raw.at).toBe('{"x":1,"y":2,"z":3}');

    const back = await getRecord("orders", r.id) as unknown as { total: number; at: unknown };
    expect(back.total).toBe(12.5);
    expect(back.at).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("refuses a value the type's validate rejects", async () => {
    await createCollection({ name: "orders", fields: JSON.stringify([{ name: "total", type: "money" }]) });
    const err = await createRecord("orders", { total: "lots" }, null).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details["total"]).toBe("total must be an amount");
  });

  it("is described in the OpenAPI document", async () => {
    await createCollection({ name: "orders", fields: JSON.stringify([{ name: "total", type: "money" }]) });
    const doc = JSON.stringify(buildOpenApi([(await getCollection("orders"))!]));
    expect(doc).toContain('"multipleOf":0.01');
  });

  it("lists built-in and registered types", () => {
    const types = listFieldTypes();
    expect(types.find((t) => t.type === "text")?.builtin).toBe(true);
    expect(types.find((t) => t.type === "money")).toEqual({ type: "money", builtin: false, sqlType: "INTEGER" });
  });

  it("can't replace a built-in type or register a name twice", () => {
    expect(() => registerFieldType({ type: "text" })).toThrow(/already registered/);
    expect(() => registerFieldType({ type: "money" })).toThrow(/already registered/);
    expect(() => registerFieldType({ type: "no spaces" })).toThrow(/invalid field type name/);
  });
});

describe("unknown field types", () => {
  it("refuses a new field of an unregistered type", async () => {
    const err = await createCollection({ name: "bad", fields: JSON.stringify([{ name: "x", type: "nope" }]) }).catch((e) => e);
    expect(String((err as Error).message ?? err) + JSON.stringify((err as { details?: unknown }).details ?? {})).toContain("unknown field type 'nope'");
  });

  it("keeps a field whose type's extension was removed, and the record still reads", async () => {
    await createCollection({ name: "orders", fields: JSON.stringify([{ name: "total", type: "money" }]) });
    const r = await createRecord("orders", { total: 3 }, null);
    for (const off of offs.splice(0)) off();

    // Editing the rest of the schema still works.
    const col = (await getCollection("orders"))!;
    await updateCollection(col.id, {
      fields: JSON.stringify([{ name: "total", type: "money" }, { name: "note", type: "text" }]),
    });
    await updateRecord("orders", r.id, { note: "hi" }, null);
    const back = await getRecord("orders", r.id) as unknown as { total: unknown; note: string };
    expect(back.total).toBe(300);
    expect(back.note).toBe("hi");
  });
});
