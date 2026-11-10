import { expect, it } from "bun:test";
import { collectionTypeIcon } from "./collection-type-icon.ts";

it("maps each collection type to its icon", () => {
  expect(collectionTypeIcon("base")).toBe("colBase");
  expect(collectionTypeIcon("auth")).toBe("colAuth");
  expect(collectionTypeIcon("view")).toBe("colView");
  expect(collectionTypeIcon("singleton")).toBe("colSingleton");
  expect(collectionTypeIcon(undefined)).toBe("colBase");
  expect(collectionTypeIcon("something-new")).toBe("colBase");
});
