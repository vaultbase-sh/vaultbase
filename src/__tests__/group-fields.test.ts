/**
 * Group fields: structured items declared in the schema. Covers the schema
 * checks, validation and normalisation of values, item ids, the single-object
 * mode, read-time shaping (removed subfields disappear) and subfield renames.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, updateCollection, getCollection, parseFields, _resetCollectionCache, type FieldDef } from "../core/collections.ts";
import { createRecord, getRecord, updateRecord, listRecords } from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import { newItemId } from "../core/group-fields.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { signAuthToken } from "../core/sec.ts";
import { admin } from "../db/schema.ts";
import { getDb } from "../db/client.ts";

const ENC_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

const ITEMS: FieldDef = {
  name: "items",
  type: "group",
  options: {
    max: 5,
    fields: [
      { name: "sku", type: "text", required: true },
      { name: "qty", type: "number", required: true, options: { min: 1 } },
      { name: "gift", type: "bool" },
      { name: "note", type: "text" },
    ],
  },
};

const ADDRESS: FieldDef = {
  name: "address",
  type: "group",
  options: {
    multiple: false,
    fields: [
      { name: "city", type: "text", required: true },
      { name: "zip", type: "text" },
    ],
  },
};

async function makeOrders(fields: FieldDef[] = [{ name: "title", type: "text" }, ITEMS, ADDRESS]) {
  await createCollection({ name: "orders", fields: JSON.stringify(fields) });
  _resetCollectionCache();
}

async function fieldsOf(name: string): Promise<FieldDef[]> {
  return parseFields((await getCollection(name))!.fields);
}

async function validationError(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ValidationError) return e.details;
    throw e;
  }
  throw new Error("expected a validation error");
}

async function schemaError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const details = (e as { details?: Record<string, string> }).details;
    return details ? Object.values(details).join("; ") : String((e as Error).message);
  }
  throw new Error("expected the schema to be refused");
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
});
afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
  delete process.env["VAULTBASE_ENCRYPTION_KEY"];
});

describe("group schema", () => {
  const withGroup = (group: Partial<FieldDef> & { options?: FieldDef["options"] }) =>
    createCollection({ name: "g", fields: JSON.stringify([{ name: "items", type: "group", ...group }]) });

  it("needs at least one subfield", async () => {
    expect(await schemaError(withGroup({ options: {} }))).toContain("at least one subfield");
    expect(await schemaError(withGroup({ options: { fields: [] } }))).toContain("at least one subfield");
  });

  it("refuses groups inside groups and types a group can't hold", async () => {
    expect(await schemaError(withGroup({ options: { fields: [{ name: "x", type: "group", options: { fields: [{ name: "y", type: "text" }] } }] } })))
      .toContain("can't contain groups");
    for (const type of ["relation", "file", "password", "autodate", "vector", "geoPoint", "nope"]) {
      expect(await schemaError(withGroup({ options: { fields: [{ name: "x", type }] } }))).toContain(`can't hold ${type}`);
    }
  });

  it("reserves id, refuses duplicate and malformed subfield names", async () => {
    expect(await schemaError(withGroup({ options: { fields: [{ name: "id", type: "text" }] } }))).toContain("'id' is reserved");
    expect(await schemaError(withGroup({ options: { fields: [{ name: "a", type: "text" }, { name: "A", type: "number" }] } }))).toContain("two subfields named");
    expect(await schemaError(withGroup({ options: { fields: [{ name: "a b", type: "text" }] } }))).toContain("invalid subfield name");
    expect(await schemaError(withGroup({ options: { fields: [{ name: "__proto__", type: "text" }] } }))).toContain("__proto__");
  });

  it("refuses unique, searchable and encrypted on subfields, and unique on the group", async () => {
    for (const o of ["unique", "searchable", "encrypted"]) {
      expect(await schemaError(withGroup({ options: { fields: [{ name: "a", type: "text", options: { [o]: true } }] } }))).toContain(`${o} isn't available on a subfield`);
    }
    expect(await schemaError(withGroup({ options: { unique: true, fields: [{ name: "a", type: "text" }] } }))).toContain("can't be unique");
    expect(await schemaError(withGroup({ options: { searchable: true, fields: [{ name: "a", type: "text" }] } }))).toContain("searchable");
  });

  it("checks item bounds", async () => {
    const fields = [{ name: "a", type: "text" }];
    expect(await schemaError(withGroup({ options: { min: 3, max: 2, fields } }))).toContain("min (3) is more than max (2)");
    expect(await schemaError(withGroup({ options: { max: 1001, fields } }))).toContain("from 1 to 1000");
    expect(await schemaError(withGroup({ options: { min: -1, fields } }))).toContain("min must be");
    expect(await schemaError(withGroup({ options: { min: 1.5, fields } }))).toContain("min must be");
    expect(await schemaError(withGroup({ options: { multiple: false, max: 2, fields } }))).toContain("only apply when multiple is on");
  });

  it("needs values on a select subfield", async () => {
    expect(await schemaError(withGroup({ options: { fields: [{ name: "s", type: "select" }] } }))).toContain("needs at least one value");
  });

  it("refuses a subfield type change, and switching multiple on the group or a select", async () => {
    await makeOrders();
    const fields = await fieldsOf("orders");
    const changeSub = fields.map((f) => f.name === "items"
      ? { ...f, options: { ...f.options, fields: f.options!.fields!.map((s) => s.name === "qty" ? { ...s, type: "text" } : s) } }
      : f);
    expect(await schemaError(updateCollection("orders", { fields: JSON.stringify(changeSub) }))).toContain("can't change a subfield's type");

    const toSingle = fields.map((f) => f.name === "items" ? { ...f, options: { ...f.options, max: undefined, multiple: false } } : f);
    expect(await schemaError(updateCollection("orders", { fields: JSON.stringify(toSingle) }))).toContain("multiple can't be switched");
  });

  it("refuses a rename onto a subfield that still exists", async () => {
    await makeOrders();
    const fields = (await fieldsOf("orders")).map((f) => f.name === "items"
      ? { ...f, options: { ...f.options, fields: [...f.options!.fields!.filter((s) => s.name !== "note"), { name: "note", type: "text", renamedFrom: "sku" }] } }
      : f);
    expect(await schemaError(updateCollection("orders", { fields: JSON.stringify(fields) }))).toContain("'note' already exists");
  });

  it("can't be turned into from json", async () => {
    await createCollection({ name: "g", fields: JSON.stringify([{ name: "items", type: "json" }]) });
    expect(await schemaError(updateCollection("g", { fields: JSON.stringify([ITEMS]) }))).toContain("Cannot change type");
  });
});

describe("group values", () => {
  beforeEach(() => makeOrders());

  it("stores items with an id each and returns them", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 2 }, { sku: "B", qty: 1, gift: true }] });
    const items = rec["items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ sku: "A", qty: 2 });
    expect(items[1]).toMatchObject({ sku: "B", qty: 1, gift: true });
    for (const it of items) expect(it["id"]).toMatch(/^[a-z0-9]{15}$/);
    expect(items[0]!["id"]).not.toBe(items[1]!["id"]);
    const read = await getRecord("orders", rec.id);
    expect(read!["items"]).toEqual(items);
  });

  it("keeps the ids a client sends back, and gives new items new ones", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 2 }] });
    const first = (rec["items"] as Array<Record<string, unknown>>)[0]!;
    const updated = await updateRecord("orders", rec.id, { items: [{ ...first, qty: 3 }, { sku: "C", qty: 1 }] });
    const items = updated["items"] as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ id: first["id"], sku: "A", qty: 3 });
    expect(items[1]!["id"]).toMatch(/^[a-z0-9]{15}$/);
    expect(items[1]!["id"]).not.toBe(first["id"]);
  });

  it("refuses a malformed or repeated item id", async () => {
    expect((await validationError(createRecord("orders", { items: [{ id: "a b", sku: "A", qty: 1 }] })))["items"]).toContain("items[0].id must be");
    expect((await validationError(createRecord("orders", { items: [{ id: 5, sku: "A", qty: 1 }] })))["items"]).toContain("items[0].id must be");
    expect((await validationError(createRecord("orders", { items: [{ id: "x1", sku: "A", qty: 1 }, { id: "x1", sku: "B", qty: 1 }] })))["items"])
      .toContain("items[1].id 'x1' is used by another item");
  });

  it("names the item and subfield in errors", async () => {
    expect((await validationError(createRecord("orders", { items: [{ sku: "A", qty: 1 }, { sku: "B", qty: 0 }] })))["items"]).toBe("items[1].qty must be at least 1");
    expect((await validationError(createRecord("orders", { items: [{ qty: 1 }] })))["items"]).toBe("items[0].sku is required");
    expect((await validationError(createRecord("orders", { items: [{ sku: "A", qty: "2" }] })))["items"]).toBe("items[0].qty must be a number");
    expect((await validationError(createRecord("orders", { items: [{ sku: "A", qty: 1, colour: "red" }] })))["items"]).toBe("items[0].colour is not a field of items");
  });

  it("refuses values that aren't a list of objects", async () => {
    expect((await validationError(createRecord("orders", { items: { sku: "A", qty: 1 } })))["items"]).toBe("items must be a list of items");
    expect((await validationError(createRecord("orders", { items: "[]" })))["items"]).toBe("items must be a list of items");
    expect((await validationError(createRecord("orders", { items: [["A", 1]] })))["items"]).toBe("items[0] must be an object");
    expect((await validationError(createRecord("orders", { items: [null] })))["items"]).toBe("items[0] must be an object");
  });

  it("checks the item count", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ sku: `S${i}`, qty: 1 }));
    expect((await validationError(createRecord("orders", { items: six })))["items"]).toBe("items can have at most 5 items");
    const rec = await createRecord("orders", { items: [] });
    expect(rec["items"]).toEqual([]);
  });

  it("needs one item when required, and min items when set", async () => {
    await createCollection({ name: "req", fields: JSON.stringify([{ ...ITEMS, required: true }]) });
    await createCollection({ name: "mins", fields: JSON.stringify([{ ...ITEMS, options: { ...ITEMS.options, min: 2 } }]) });
    _resetCollectionCache();
    expect((await validationError(createRecord("req", {})))["items"]).toBe("items is required");
    expect((await validationError(createRecord("req", { items: [] })))["items"]).toBe("items needs at least 1 item");
    expect((await validationError(createRecord("mins", { items: [{ sku: "A", qty: 1 }] })))["items"]).toBe("items needs at least 2 items");
  });

  it("stores subfield values as the top-level field would", async () => {
    await createCollection({
      name: "kinds",
      fields: JSON.stringify([{
        name: "rows", type: "group", options: { fields: [
          { name: "color", type: "color" },
          { name: "when", type: "date" },
          { name: "body", type: "editor" },
          { name: "status", type: "select", options: { values: ["1", "2"] } },
          { name: "tags", type: "select", options: { values: ["a", "b"], multiple: true } },
          { name: "n", type: "number" },
          { name: "t", type: "text" },
          { name: "meta", type: "json" },
        ] },
      }]),
    });
    _resetCollectionCache();
    const rec = await createRecord("kinds", { rows: [{
      color: "#ABC", when: "2026-01-02T00:00:00Z", body: "<p>hi</p><script>x()</script>", status: 2, tags: ["a"], n: "", t: "", meta: { deep: [1] },
    }] });
    const row = (rec["rows"] as Array<Record<string, unknown>>)[0]!;
    expect(row["color"]).toBe("#aabbcc");
    expect(row["when"]).toBe(Date.parse("2026-01-02T00:00:00Z") / 1000);
    expect(row["body"]).not.toContain("<script");
    expect(row["status"]).toBe("2");
    expect(row["tags"]).toEqual(["a"]);
    expect(row).not.toHaveProperty("n");
    expect(row["t"]).toBe("");
    expect(row["meta"]).toEqual({ deep: [1] });
    expect((await validationError(createRecord("kinds", { rows: [{ status: "3" }] })))["rows"]).toContain("rows[0].status must be one of");
  });

  it("drops nulls for optional subfields", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 1, note: null }] });
    expect((rec["items"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("note");
  });

  it("can be cleared on update unless required", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 1 }] });
    const cleared = await updateRecord("orders", rec.id, { items: null });
    expect(cleared["items"]).toBeNull();
  });
});

describe("single-object groups", () => {
  beforeEach(() => makeOrders());

  it("stores one object without an id", async () => {
    const rec = await createRecord("orders", { address: { city: "Oslo", zip: "0150" } });
    expect(rec["address"]).toEqual({ city: "Oslo", zip: "0150" });
    expect((await getRecord("orders", rec.id))!["address"]).toEqual({ city: "Oslo", zip: "0150" });
  });

  it("refuses lists, unknown keys and an id", async () => {
    expect((await validationError(createRecord("orders", { address: [{ city: "Oslo" }] })))["address"]).toBe("address must be an object");
    expect((await validationError(createRecord("orders", { address: { city: "Oslo", country: "NO" } })))["address"]).toBe("address.country is not a field of address");
    expect((await validationError(createRecord("orders", { address: { id: "x", city: "Oslo" } })))["address"]).toBe("address.id is not a field of address");
    expect((await validationError(createRecord("orders", { address: { zip: "1" } })))["address"]).toBe("address.city is required");
  });
});

describe("group schema changes", () => {
  beforeEach(() => makeOrders());

  const withSubfields = async (map: (subs: FieldDef[]) => FieldDef[]) => {
    const fields = (await fieldsOf("orders")).map((f) => f.name === "items"
      ? { ...f, options: { ...f.options, fields: map(f.options!.fields!) } }
      : f);
    await updateCollection("orders", { fields: JSON.stringify(fields) });
    _resetCollectionCache();
  };

  it("hides a removed subfield at once and keeps the others", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 1, note: "wrap it" }] });
    await withSubfields((subs) => subs.filter((s) => s.name !== "note"));
    const item = ((await getRecord("orders", rec.id))!["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item).not.toHaveProperty("note");
    expect(item).toMatchObject({ sku: "A", qty: 1 });
    const listed = ((await listRecords("orders")).data[0]!["items"] as Array<Record<string, unknown>>)[0]!;
    expect(listed).not.toHaveProperty("note");
  });

  it("deletes a removed subfield's data, so a re-added one starts empty", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 1, note: "private" }], address: { city: "Oslo", zip: "0150" } });
    await withSubfields((subs) => subs.filter((s) => s.name !== "note"));
    const stored = await db.get<{ items: string }>(`SELECT items FROM vb_orders WHERE id = ?`, [rec.id]);
    expect(stored!.items).not.toContain("private");
    await withSubfields((subs) => [...subs, { name: "note", type: "number" }]);
    const item = ((await getRecord("orders", rec.id))!["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item).not.toHaveProperty("note");
    // The record can be sent back as read.
    await updateRecord("orders", rec.id, { items: [item] });

    const fields = (await fieldsOf("orders")).map((f) => f.name === "address"
      ? { ...f, options: { ...f.options, fields: f.options!.fields!.filter((s) => s.name !== "zip") } }
      : f);
    await updateCollection("orders", { fields: JSON.stringify(fields) });
    const addr = await db.get<{ address: string }>(`SELECT address FROM vb_orders WHERE id = ?`, [rec.id]);
    expect(JSON.parse(addr!.address)).toEqual({ city: "Oslo" });
  });

  it("gives a renamed subfield its own value, not a stale key of the new name", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 1, note: "keep" }] });
    // A key no schema declares, as an older row could hold.
    await db.run(`UPDATE vb_orders SET items = ? WHERE id = ?`, [JSON.stringify([{ id: "x1", sku: "A", qty: 1, note: "keep", memo: "stale" }]), rec.id]);
    await withSubfields((subs) => subs.map((s) => s.name === "note" ? { ...s, name: "memo", renamedFrom: "note" } : s));
    const item = ((await getRecord("orders", rec.id))!["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item["memo"]).toBe("keep");
  });

  it("restores a history entry from before a subfield was renamed or removed", async () => {
    await getDb().insert(admin).values({ id: "admin-1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    await updateCollection("orders", { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    _resetCollectionCache();
    const rec = await createRecord("orders", { title: "v1", items: [{ sku: "A", qty: 1, note: "n", gift: true }] });
    // Both writes land in one second; put the first a minute back.
    const at = Math.floor(Date.now() / 1000) - 60;
    await db.run(`UPDATE vaultbase_record_history SET at = ? WHERE record_id = ?`, [at, rec.id]);
    await withSubfields((subs) => subs.filter((s) => s.name !== "gift").map((s) => s.name === "note" ? { ...s, name: "memo", renamedFrom: "note" } : s));
    await updateRecord("orders", rec.id, { title: "v2", items: [] });
    const SECRET = "test-secret-group-restore";
    const token = (await signAuthToken({ payload: { id: "admin-1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/orders/${rec.id}/restore?at=${at}`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));
    expect(res.status).toBe(200);
    const restored = await getRecord("orders", rec.id);
    expect(restored!["title"]).toBe("v1");
    expect((restored!["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({ sku: "A", qty: 1 });
  });

  it("reads old items without a new subfield", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 1 }] });
    await withSubfields((subs) => [...subs, { name: "price", type: "number" }]);
    const item = ((await getRecord("orders", rec.id))!["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item).not.toHaveProperty("price");
    const updated = await updateRecord("orders", rec.id, { items: [{ ...item, price: 9.5 }] });
    expect((updated["items"] as Array<Record<string, unknown>>)[0]!["price"]).toBe(9.5);
  });

  it("rewrites stored items when a subfield is renamed, without touching updated", async () => {
    const a = await createRecord("orders", { items: [{ sku: "A", qty: 1, note: "one" }, { sku: "B", qty: 2 }] });
    const b = await createRecord("orders", { items: [{ sku: "C", qty: 3, note: "three" }], address: { city: "Oslo" } });
    await db.run(`UPDATE vb_orders SET updated_at = 1000`);
    await withSubfields((subs) => subs.map((s) => s.name === "note" ? { ...s, name: "comment", renamedFrom: "note" } : s));

    const ra = await getRecord("orders", a.id);
    expect((ra!["items"] as Array<Record<string, unknown>>).map((i) => i["comment"])).toEqual(["one", undefined]);
    expect((ra!["items"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("note");
    expect(((await getRecord("orders", b.id))!["items"] as Array<Record<string, unknown>>)[0]!["comment"]).toBe("three");
    expect(ra!.updated).toBe(1000);

    const stored = await db.get<{ items: string }>(`SELECT items FROM vb_orders WHERE id = ?`, [a.id]);
    expect(stored!.items).not.toContain("\"note\"");
    // `renamedFrom` is an instruction, not schema.
    const sub = (await fieldsOf("orders")).find((f) => f.name === "items")!.options!.fields!.find((s) => s.name === "comment")!;
    expect(sub).not.toHaveProperty("renamedFrom");
  });

  it("renames a subfield of a renamed group", async () => {
    const rec = await createRecord("orders", { items: [{ sku: "A", qty: 1 }] });
    const fields = (await fieldsOf("orders")).map((f) => f.name === "items"
      ? { ...f, name: "lines", renamedFrom: "items", options: { ...f.options, fields: f.options!.fields!.map((s) => s.name === "sku" ? { ...s, name: "code", renamedFrom: "sku" } : s) } }
      : f);
    await updateCollection("orders", { fields: JSON.stringify(fields) });
    _resetCollectionCache();
    const item = ((await getRecord("orders", rec.id))!["lines"] as Array<Record<string, unknown>>)[0]!;
    expect(item).toMatchObject({ code: "A", qty: 1 });
  });

  it("renames the subfield of a single-object group", async () => {
    const rec = await createRecord("orders", { address: { city: "Oslo", zip: "0150" } });
    const fields = (await fieldsOf("orders")).map((f) => f.name === "address"
      ? { ...f, options: { ...f.options, fields: f.options!.fields!.map((s) => s.name === "zip" ? { ...s, name: "postcode", renamedFrom: "zip" } : s) } }
      : f);
    await updateCollection("orders", { fields: JSON.stringify(fields) });
    _resetCollectionCache();
    expect((await getRecord("orders", rec.id))!["address"]).toEqual({ city: "Oslo", postcode: "0150" });
  });
});

describe("encrypted groups", () => {
  it("are stored encrypted and read back, and survive a subfield rename", async () => {
    process.env["VAULTBASE_ENCRYPTION_KEY"] = ENC_KEY;
    await makeOrders([{ ...ITEMS, options: { ...ITEMS.options, encrypted: true } }]);
    const rec = await createRecord("orders", { items: [{ sku: "SECRET-1", qty: 1, note: "n" }] });
    const raw = await db.get<{ items: string }>(`SELECT items FROM vb_orders WHERE id = ?`, [rec.id]);
    expect(raw!.items.startsWith("vbenc:")).toBe(true);
    expect(raw!.items).not.toContain("SECRET-1");
    expect(((await getRecord("orders", rec.id))!["items"] as Array<Record<string, unknown>>)[0]!["sku"]).toBe("SECRET-1");

    const fields = (await fieldsOf("orders")).map((f) => ({ ...f, options: { ...f.options, fields: f.options!.fields!.map((s) => s.name === "note" ? { ...s, name: "memo", renamedFrom: "note" } : s) } }));
    await updateCollection("orders", { fields: JSON.stringify(fields) });
    _resetCollectionCache();
    const after = await db.get<{ items: string }>(`SELECT items FROM vb_orders WHERE id = ?`, [rec.id]);
    expect(after!.items.startsWith("vbenc:")).toBe(true);
    expect(((await getRecord("orders", rec.id))!["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({ sku: "SECRET-1", memo: "n" });
  });
});

describe("item ids", () => {
  it("are 15 characters of [a-z0-9] and don't repeat", () => {
    const ids = new Set(Array.from({ length: 2000 }, newItemId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{15}$/);
  });
});
