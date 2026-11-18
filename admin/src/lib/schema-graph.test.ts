import { describe, expect, it } from "bun:test";
import {
  CARD_W, GAP_ALONE, HEAD_H, MAX_ZOOM, MIN_ZOOM, MORE_H, ROW_H, CARD_PAD,
  buildGraph, cardHeight, centerOn, edgeGeometry, fitView, graphBounds, hiddenFieldCount,
  layoutGraph, mergePositions, neighbourhood, parsePositions, visibleFields, zoomAt,
} from "./schema-graph.ts";

const col = (name: string, fields: unknown[], type = "base") => ({ id: `id_${name}`, name, type, fields: JSON.stringify(fields) });
const rel = (name: string, collection: string, cascade?: string) => ({ name, type: "relation", collection, ...(cascade ? { options: { cascade } } : {}) });
const text = (name: string) => ({ name, type: "text" });

const blog = [
  col("users", [text("name")], "auth"),
  col("posts", [text("title"), rel("author", "users", "cascade")]),
  col("comments", [text("body"), rel("post", "posts", "cascade"), rel("author", "users")]),
  col("settings", [text("theme")], "singleton"),
];

describe("schema graph", () => {
  it("draws one arrow per relation field, to the collection it names", () => {
    const g = buildGraph(blog);
    expect(g.nodes.map((n) => n.name)).toEqual(["comments", "posts", "settings", "users"]);
    expect(g.edges.map((e) => `${e.from}.${e.field}>${e.to}:${e.cascade}`).sort()).toEqual([
      "id_comments.author>id_users:setNull",
      "id_comments.post>id_posts:cascade",
      "id_posts.author>id_users:cascade",
    ]);
  });

  it("lists a relation to a missing collection without an arrow", () => {
    const g = buildGraph([col("posts", [rel("author", "gone")])]);
    expect(g.edges).toEqual([]);
    expect(g.nodes[0]!.fields[0]).toMatchObject({ target: "gone", resolved: false });
  });

  it("lists an auth collection's email and verified first, and skips system fields", () => {
    const g = buildGraph([col("users", [{ name: "id", type: "text", system: true }, text("name")], "auth")]);
    expect(g.nodes[0]!.fields.map((f) => f.name)).toEqual(["email", "verified", "name"]);
    // Already sent by the server: not listed twice.
    const sent = buildGraph([col("users", [{ name: "email", type: "email", implicit: true }, text("name")], "auth")]);
    expect(sent.nodes[0]!.fields.map((f) => f.name)).toEqual(["email", "name"]);
  });

  it("reads broken field JSON as no fields", () => {
    const g = buildGraph([{ id: "a", name: "a", type: "base", fields: "{nope" }]);
    expect(g.nodes[0]!.fields).toEqual([]);
  });

  it("keeps a self relation as an arrow from a card to itself", () => {
    const g = buildGraph([col("categories", [rel("parent", "categories")])]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.from).toBe(g.edges[0]!.to);
  });
});

describe("schema cards", () => {
  const g = buildGraph(blog);
  const comments = g.nodes.find((n) => n.name === "comments")!;
  const settings = g.nodes.find((n) => n.name === "settings")!;

  it("list every field, or the relations with a count of the rest", () => {
    expect(visibleFields(comments, false).map((f) => f.name)).toEqual(["body", "post", "author"]);
    expect(visibleFields(comments, true).map((f) => f.name)).toEqual(["post", "author"]);
    expect(hiddenFieldCount(comments, true)).toBe(1);
    expect(cardHeight(comments, false)).toBe(HEAD_H + 3 * ROW_H + CARD_PAD);
    expect(cardHeight(comments, true)).toBe(HEAD_H + 2 * ROW_H + MORE_H + CARD_PAD);
    expect(cardHeight(settings, true)).toBe(HEAD_H + MORE_H + CARD_PAD);
  });

  it("keep one row when there is nothing to list", () => {
    const empty = buildGraph([col("empty", [])]).nodes[0]!;
    expect(cardHeight(empty, false)).toBe(HEAD_H + ROW_H + CARD_PAD);
  });
});

describe("schema layout", () => {
  const overlaps = (g: ReturnType<typeof buildGraph>, pos: ReturnType<typeof layoutGraph>, compact: boolean) => {
    for (const a of g.nodes) for (const b of g.nodes) {
      if (a.id >= b.id) continue;
      const pa = pos[a.id]!, pb = pos[b.id]!;
      const apart = pa.x + CARD_W <= pb.x || pb.x + CARD_W <= pa.x
        || pa.y + cardHeight(a, compact) <= pb.y || pb.y + cardHeight(b, compact) <= pa.y;
      if (!apart) return `${a.name} overlaps ${b.name}`;
    }
    return null;
  };

  it("puts a referenced collection left of the ones pointing at it", () => {
    const g = buildGraph(blog);
    const pos = layoutGraph(g, false);
    expect(pos["id_users"]!.x).toBeLessThan(pos["id_posts"]!.x);
    expect(pos["id_posts"]!.x).toBeLessThan(pos["id_comments"]!.x);
    expect(overlaps(g, pos, false)).toBeNull();
  });

  it("puts unlinked collections under the linked ones", () => {
    const g = buildGraph(blog);
    const pos = layoutGraph(g, false);
    const linkedBottom = Math.max(...["users", "posts", "comments"].map((n) => pos[`id_${n}`]!.y + cardHeight(g.nodes.find((x) => x.name === n)!, false)));
    expect(pos["id_settings"]!.y).toBeGreaterThan(linkedBottom);
  });

  it("keeps a collection that points at nothing next to the one using it", () => {
    // tags is only used by post_tags, three columns in: it belongs beside it.
    const g = buildGraph([
      col("users", []), col("posts", [rel("author", "users")]),
      col("post_tags", [rel("post", "posts"), rel("tag", "tags")]), col("tags", []),
    ]);
    const pos = layoutGraph(g, false);
    expect(pos["id_tags"]!.x).toBe(pos["id_posts"]!.x);
    expect(overlaps(g, pos, false)).toBeNull();
  });

  it("ends on relations that form a cycle", () => {
    const g = buildGraph([col("a", [rel("b", "b")]), col("b", [rel("c", "c")]), col("c", [rel("a", "a")])]);
    const pos = layoutGraph(g, false);
    expect(Object.keys(pos).sort()).toEqual(["id_a", "id_b", "id_c"]);
    expect(overlaps(g, pos, false)).toBeNull();
  });

  it("places a card that only points at itself with the unlinked ones", () => {
    const g = buildGraph([col("categories", [rel("parent", "categories")]), col("other", [])]);
    const pos = layoutGraph(g, false);
    expect(pos["id_categories"]!.y).toBe(pos["id_other"]!.y);
    expect(overlaps(g, pos, false)).toBeNull();
  });

  it("splits a very tall column instead of running it down the page", () => {
    const many = Array.from({ length: 40 }, (_, i) => col(`t${String(i).padStart(2, "0")}`, [rel("owner", "users"), text("a"), text("b")]));
    const g = buildGraph([col("users", []), ...many]);
    const pos = layoutGraph(g, false);
    const xs = new Set(many.map((c) => pos[c.id]!.x));
    expect(xs.size).toBeGreaterThan(1);
    expect(overlaps(g, pos, false)).toBeNull();
    for (const x of xs) expect(x).toBeGreaterThan(pos["id_users"]!.x);
  });

  it("places every collection of a large schema, none on top of another", () => {
    const cols = Array.from({ length: 60 }, (_, i) => col(`c${i}`, i % 3 === 0 ? [] : [rel("r", `c${(i * 7) % 60}`), text("x")]));
    const g = buildGraph(cols);
    for (const compact of [false, true]) {
      const pos = layoutGraph(g, compact);
      expect(Object.keys(pos)).toHaveLength(60);
      expect(overlaps(g, pos, compact)).toBeNull();
    }
  });
});

describe("saved positions", () => {
  it("override the automatic ones, and are dropped for collections that are gone", () => {
    const auto = { a: { x: 0, y: 0 }, b: { x: 10, y: 10 } };
    expect(mergePositions(auto, { a: { x: 5, y: 6 }, gone: { x: 1, y: 1 } })).toEqual({ a: { x: 5, y: 6 }, b: { x: 10, y: 10 } });
  });

  it("read leniently", () => {
    expect(parsePositions(null)).toEqual({});
    expect(parsePositions("nope")).toEqual({});
    expect(parsePositions("[1]")).toEqual({});
    expect(parsePositions('{"a":{"x":1,"y":2},"b":{"x":"1"},"c":null}')).toEqual({ a: { x: 1, y: 2 } });
  });
});

describe("relation arrows", () => {
  const rowY = (y: number, row: number) => y + HEAD_H + row * ROW_H + ROW_H / 2;

  it("leave the side of the row facing the target", () => {
    // Target on the left: out of the row's left edge, into the header's right edge.
    const left = edgeGeometry({ x: 600, y: 100 }, 1, { x: 0, y: 0 });
    expect(left.start).toEqual({ x: 600, y: rowY(100, 1) });
    expect(left.d.endsWith(`${CARD_W} ${HEAD_H / 2}`)).toBe(true);
    // Target on the right: the other way round.
    const right = edgeGeometry({ x: 0, y: 0 }, 0, { x: 600, y: 100 });
    expect(right.start).toEqual({ x: CARD_W, y: rowY(0, 0) });
    expect(right.d.endsWith(`600 ${100 + HEAD_H / 2}`)).toBe(true);
  });

  it("go round the right edge for stacked cards and self relations", () => {
    const stacked = edgeGeometry({ x: 0, y: 300 }, 0, { x: 20, y: 0 });
    expect(stacked.start.x).toBe(CARD_W);
    expect(stacked.d.endsWith(`${20 + CARD_W} ${HEAD_H / 2}`)).toBe(true);
    expect(stacked.mid.x).toBeGreaterThan(20 + CARD_W);
    const self = edgeGeometry({ x: 0, y: 0 }, 2, { x: 0, y: 0 });
    expect(self.start).toEqual({ x: CARD_W, y: rowY(0, 2) });
    expect(self.mid.x).toBeGreaterThan(CARD_W);
    // The loop stays inside the gap left between unlinked cards.
    expect(self.mid.x).toBeLessThan(CARD_W + GAP_ALONE);
  });
});

describe("schema view", () => {
  it("fits the whole graph, centred, never above 100%", () => {
    const g = buildGraph(blog);
    const pos = layoutGraph(g, false);
    const b = graphBounds(g.nodes, pos, false)!;
    const v = fitView(b, 800, 500);
    expect(v.k).toBeLessThanOrEqual(1);
    expect(v.x + b.x * v.k).toBeGreaterThanOrEqual(0);
    expect(v.x + (b.x + b.w) * v.k).toBeLessThanOrEqual(800);
    expect(v.y + (b.y + b.h) * v.k).toBeLessThanOrEqual(500);
    // A small graph in a big viewport stays at 100% rather than blowing up.
    expect(fitView({ x: 0, y: 0, w: 200, h: 100 }, 2000, 1000).k).toBe(1);
    expect(fitView(null, 800, 500)).toEqual({ x: 0, y: 0, k: 1 });
    expect(graphBounds([], {}, false)).toBeNull();
  });

  it("zooms about the pointer, within limits", () => {
    const v = zoomAt({ x: 40, y: 20, k: 1 }, 1.5, 300, 200);
    // The canvas point under the pointer is the same before and after.
    expect((300 - v.x) / v.k).toBeCloseTo((300 - 40) / 1);
    expect((200 - v.y) / v.k).toBeCloseTo((200 - 20) / 1);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 99, 0, 0).k).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 0.001, 0, 0).k).toBe(MIN_ZOOM);
  });

  it("centres a card without changing the zoom", () => {
    const v = centerOn({ x: 0, y: 0, k: 0.5 }, { x: 1000, y: 400 }, 100, 800, 600);
    expect(v.k).toBe(0.5);
    expect(v.x + (1000 + CARD_W / 2) * 0.5).toBe(400);
    expect(v.y + (400 + 50) * 0.5).toBe(300);
  });

  it("lights a card up with its arrows and the cards at their other ends", () => {
    const g = buildGraph(blog);
    const n = neighbourhood(g, "id_posts");
    expect([...n.nodes].sort()).toEqual(["id_comments", "id_posts", "id_users"]);
    expect([...n.edges].sort()).toEqual(["id_comments:post", "id_posts:author"]);
    expect([...neighbourhood(g, "id_settings").nodes]).toEqual(["id_settings"]);
  });
});
