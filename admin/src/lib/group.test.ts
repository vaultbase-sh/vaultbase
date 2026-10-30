import { describe, expect, it } from "bun:test";
import type { FieldDef } from "../api.ts";
import {
  groupCellText, groupItemBounds, groupSchemaProblem, isBlankItem, itemSummary, itemsOf, moveItem, newItem,
  singleGroupValue, subfieldsForSave, withStoredSubfieldNames,
} from "./group.ts";

const items: FieldDef = {
  name: "items", type: "group", options: { fields: [
    { name: "sku", type: "text" },
    { name: "qty", type: "number" },
    { name: "gift", type: "bool" },
    { name: "note", type: "editor" },
    { name: "due", type: "date" },
    { name: "tags", type: "select", options: { values: ["a", "b"], multiple: true } },
    { name: "extra", type: "json" },
  ] },
};
const address: FieldDef = { name: "address", type: "group", options: { multiple: false, fields: [{ name: "city", type: "text" }, { name: "zip", type: "text" }] } };

describe("moveItem", () => {
  it("moves up and down, and ignores moves off the ends", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });
});

describe("item helpers", () => {
  it("reads items only from a list of objects", () => {
    expect(itemsOf([{ a: 1 }, 2, null, [1], { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(itemsOf({ a: 1 })).toEqual([]);
  });

  it("treats an item with only an id or empty values as blank", () => {
    expect(isBlankItem({ id: "x", sku: "", qty: null, tags: [] })).toBe(true);
    expect(isBlankItem({ qty: 0 })).toBe(false);
    expect(isBlankItem({ gift: false })).toBe(false);
  });

  it("sends null for an untouched single object", () => {
    expect(singleGroupValue({ city: "", zip: undefined })).toBeNull();
    expect(singleGroupValue({ city: "Oslo" })).toEqual({ city: "Oslo" });
  });

  it("counts required as one item at least", () => {
    expect(groupItemBounds(items)).toEqual({ min: 0, max: 100 });
    expect(groupItemBounds({ ...items, required: true, options: { ...items.options, max: 3 } })).toEqual({ min: 1, max: 3 });
    expect(groupItemBounds({ ...items, required: true, options: { ...items.options, min: 2 } })).toEqual({ min: 2, max: 100 });
  });
});

describe("summaries", () => {
  it("summarises an item by its readable values", () => {
    expect(itemSummary({ sku: "A-1", qty: 3, gift: true, note: "<p>Wrap <b>it</b></p>", due: 0, tags: ["a", "b"], extra: { x: 1 } }, items))
      .toBe("A-1 · 3 · gift · Wrap it · 1970-01-01 · a, b");
    expect(itemSummary({ gift: false, qty: null }, items)).toBe("");
    expect(itemSummary({ sku: "x".repeat(100) }, items, 10)).toBe("xxxxxxxxx…");
  });

  it("shows a list as a count and a single object as its values", () => {
    expect(groupCellText(null, items)).toBe("—");
    expect(groupCellText([], items)).toBe("no items");
    expect(groupCellText([{ sku: "A" }], items)).toBe("1 item · A");
    expect(groupCellText([{ sku: "A" }, { sku: "B" }], items)).toBe("2 items · A, …");
    expect(groupCellText([{ extra: 1 }], items)).toBe("1 item");
    expect(groupCellText({ city: "Oslo", zip: "0150" }, address)).toBe("Oslo · 0150");
    expect(groupCellText({ city: "" }, address)).toBe("—");
    // A hand-edited value that isn't items is shown as stored.
    expect(groupCellText("odd", items)).toBe('"odd"');
  });
});

describe("reusing a saved subfield's name in the same save", () => {
  const g = (fields: FieldDef[]): FieldDef => ({ name: "g", type: "group", options: { fields } });
  const stored = ["a", "b"];
  it("allows keeping and renaming saved subfields, and new names", () => {
    expect(groupSchemaProblem(g([{ name: "a", type: "text", renamedFrom: "a" }, { name: "c", type: "text", renamedFrom: "b" }, { name: "d", type: "text" }]), stored)).toBeNull();
  });
  it("refuses a new subfield named like a removed one", () => {
    expect(groupSchemaProblem(g([{ name: "a", type: "number" }]), stored)).toContain("'g.a' is still a saved subfield");
  });
  it("refuses renaming onto a removed one", () => {
    expect(groupSchemaProblem(g([{ name: "b", type: "text", renamedFrom: "a" }]), stored)).toContain("'g.b' is still a saved subfield");
  });
  it("refuses a new subfield taking the name another was renamed from", () => {
    expect(groupSchemaProblem(g([{ name: "c", type: "text", renamedFrom: "a" }, { name: "a", type: "text" }]), stored)).toContain("'g.a'");
  });
  it("has nothing to compare for a new group", () => {
    expect(groupSchemaProblem(g([{ name: "a", type: "text" }]))).toBeNull();
  });
});

describe("schema editing", () => {
  it("remembers stored subfield names and sends only real renames", () => {
    const loaded = withStoredSubfieldNames(address);
    expect((loaded.options!["fields"] as FieldDef[]).map((s) => s.renamedFrom)).toEqual(["city", "zip"]);
    const edited: FieldDef = { ...loaded, options: { ...loaded.options, fields: [
      { ...(loaded.options!["fields"] as FieldDef[])[0]!, name: "town" },
      (loaded.options!["fields"] as FieldDef[])[1]!,
      { name: "country", type: "text" },
    ] } };
    expect(subfieldsForSave(edited).options!["fields"]).toEqual([
      { name: "town", type: "text", renamedFrom: "city" },
      { name: "zip", type: "text" },
      { name: "country", type: "text" },
    ]);
    const text: FieldDef = { name: "t", type: "text" };
    expect(withStoredSubfieldNames(text)).toBe(text);
    expect(subfieldsForSave(text)).toBe(text);
  });

  it("finds problems before saving", () => {
    expect(groupSchemaProblem(items)).toBeNull();
    expect(groupSchemaProblem({ name: "g", type: "group", options: { fields: [] } })).toContain("at least one subfield");
    expect(groupSchemaProblem({ name: "g", type: "group" })).toContain("at least one subfield");
    expect(groupSchemaProblem({ name: "g", type: "group", options: { fields: [{ name: "", type: "text" }] } })).toContain("needs a name");
    expect(groupSchemaProblem({ name: "g", type: "group", options: { fields: [{ name: "id", type: "text" }] } })).toContain("reserved");
    expect(groupSchemaProblem({ name: "g", type: "group", options: { fields: [{ name: "a", type: "text" }, { name: "A", type: "number" }] } })).toContain("two subfields");
    expect(groupSchemaProblem({ name: "g", type: "group", options: { fields: [{ name: "s", type: "select" }] } })).toContain("allowed value");
    expect(groupSchemaProblem({ name: "g", type: "group", options: { fields: [{ name: "1st", type: "text" }] } })).toContain("start with a letter");
    expect(groupSchemaProblem({ ...items, options: { ...items.options, min: 1.5 } })).toContain("whole numbers");
    expect(groupSchemaProblem({ ...items, options: { ...items.options, min: -1 } })).toContain("whole numbers");
    expect(groupSchemaProblem({ ...items, options: { ...items.options, min: 5, max: 2 } })).toContain("more than max");
    expect(groupSchemaProblem({ ...items, options: { ...items.options, max: 0 } })).toContain("from 1 to 1000");
    expect(groupSchemaProblem({ ...items, options: { ...items.options, max: 2000 } })).toContain("from 1 to 1000");
    // min and max count items, so a single object can't have them
    expect(groupSchemaProblem(address)).toBeNull();
    expect(groupSchemaProblem({ ...address, options: { ...address.options, max: 2 } })).toContain("only apply to a list");
    expect(groupSchemaProblem({ name: "g", type: "group", options: { fields: Array.from({ length: 51 }, (_, i) => ({ name: `f${i}`, type: "text" })) } })).toContain("at most 50");
  });
});

describe("newItem", () => {
  it("starts required bool subfields off, and nothing else", () => {
    const field = { name: "items", type: "group", options: { fields: [
      { name: "gift", type: "bool", required: true },
      { name: "wrap", type: "bool" },
      { name: "sku", type: "text", required: true },
    ] } } as FieldDef;
    expect(newItem(field)).toEqual({ gift: false });
  });
});
