import { describe, expect, it } from "bun:test";
import { collectionIdFromPath, sidebarCollections } from "./sidebar-collections.ts";

const col = (name: string) => ({ id: `id-${name}`, name, type: "base" });

describe("sidebarCollections", () => {
  it("sorts by name and shows them all under the limit", () => {
    const r = sidebarCollections([col("posts"), col("authors"), col("tags")], null);
    expect(r.shown.map((c) => c.name)).toEqual(["authors", "posts", "tags"]);
    expect(r.hidden).toBe(0);
  });
  it("caps the list and counts the rest", () => {
    const list = Array.from({ length: 20 }, (_, i) => col(`c${String(i).padStart(2, "0")}`));
    const r = sidebarCollections(list, null, 15);
    expect(r.shown).toHaveLength(15);
    expect(r.hidden).toBe(5);
  });
  it("keeps the open collection listed past the limit", () => {
    const list = Array.from({ length: 20 }, (_, i) => col(`c${String(i).padStart(2, "0")}`));
    const r = sidebarCollections(list, "id-c19", 15);
    expect(r.shown.map((c) => c.name)).toContain("c19");
    expect(r.hidden).toBe(4);
  });
});

describe("collectionIdFromPath", () => {
  it("reads records and edit paths", () => {
    expect(collectionIdFromPath("/_/collections/abc/records")).toBe("abc");
    expect(collectionIdFromPath("/_/collections/abc/edit")).toBe("abc");
    expect(collectionIdFromPath("/_/collections")).toBeNull();
    expect(collectionIdFromPath("/_/logs")).toBeNull();
  });
});
