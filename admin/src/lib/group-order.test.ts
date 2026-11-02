import { describe, expect, it } from "bun:test";
import { groupInOrder } from "./group-order.ts";

describe("groupInOrder", () => {
  it("orders the flat list as the groups are shown, not by rank", () => {
    const ranked = [
      { id: "c1", group: "Collections" as const },
      { id: "n1", group: "Navigate" as const },
      { id: "c2", group: "Collections" as const },
      { id: "n2", group: "Navigate" as const },
    ];
    const { groups, flat } = groupInOrder(ranked, ["Navigate", "Collections"]);
    expect(flat.map((i) => i.id)).toEqual(["n1", "n2", "c1", "c2"]);
    expect(groups.map((g) => g.group)).toEqual(["Navigate", "Collections"]);
  });

  it("drops empty groups and items outside the order", () => {
    const { groups, flat } = groupInOrder([{ id: "x", group: "Other" }], ["Navigate", "Collections"] as string[]);
    expect(groups).toEqual([]);
    expect(flat).toEqual([]);
  });
});
