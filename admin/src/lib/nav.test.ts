import { describe, expect, it } from "bun:test";
import { NAV_ITEMS, OPTIONAL_NAV_ITEMS, favoriteItems, favoritesKey, isNavActive, isNavShown, parsePinned } from "./nav.ts";

const item = (id: string) => NAV_ITEMS.find((i) => i.id === id)!;
const none = { pinned: [], inUse: [], pathname: "/_/" };

describe("admin sidebar pages", () => {
  it("always show the core pages, hooks, MCP included", () => {
    for (const id of ["dashboard", "collections", "logs", "hooks", "mcp", "users", "settings"]) {
      expect(isNavShown(item(id), none)).toBe(true);
    }
  });

  it("hide the optional pages until they're used, pinned or open", () => {
    expect(OPTIONAL_NAV_ITEMS.map((i) => i.id).sort()).toEqual(["api-preview", "api-tokens", "audit-log", "flags", "monitoring", "sql", "webhooks"]);
    const flags = item("flags");
    expect(isNavShown(flags, none)).toBe(false);
    expect(isNavShown(flags, { ...none, inUse: ["flags"] })).toBe(true);
    expect(isNavShown(flags, { ...none, pinned: ["flags"] })).toBe(true);
    expect(isNavShown(flags, { ...none, pathname: "/_/flags" })).toBe(true);
  });

  it("match the open page by path, the dashboard exactly", () => {
    expect(isNavActive(item("dashboard"), "/_/")).toBe(true);
    expect(isNavActive(item("dashboard"), "/_/flags")).toBe(false);
    expect(isNavActive(item("collections"), "/_/collections/abc/records")).toBe(true);
    expect(isNavActive(item("api-tokens"), "/_/api-preview")).toBe(false);
  });

  it("read the pinned setting leniently", () => {
    expect(parsePinned(undefined)).toEqual([]);
    expect(parsePinned(" sql, flags ,,")).toEqual(["sql", "flags"]);
  });

  it("show favorites first, in the order added, and always", () => {
    expect(favoriteItems(["sql", "hooks", "gone"]).map((i) => i.id)).toEqual(["sql", "hooks"]);
    expect(isNavShown(item("sql"), { ...none, favorites: ["sql"] })).toBe(true);
    expect(favoritesKey("a1")).toBe("admin.favorites.a1");
  });
});
