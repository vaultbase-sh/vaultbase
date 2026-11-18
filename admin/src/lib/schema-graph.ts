/**
 * The Schema page's model: collections as cards, relation fields as arrows.
 *
 * Card sizes are fixed numbers rather than measured from the DOM, so the
 * layout and the arrow ends are worked out here and the page only draws them.
 */
import { AUTH_IMPLICIT_FIELDS, parseFields, type FieldDef } from "../api.ts";

export type CascadeMode = "setNull" | "cascade" | "restrict";

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  /** Relation fields: the collection name the field points at. */
  target?: string;
  /** Relation fields: false when no collection has that name. */
  resolved?: boolean;
  cascade?: CascadeMode;
}

export interface SchemaNode {
  id: string;
  name: string;
  type: string;
  fields: SchemaField[];
}

export interface SchemaEdge {
  id: string;
  /** Node id holding the relation field. */
  from: string;
  field: string;
  /** Node id the field points at. */
  to: string;
  cascade: CascadeMode;
}

export interface SchemaGraph { nodes: SchemaNode[]; edges: SchemaEdge[] }

export interface Point { x: number; y: number }
export type Positions = Record<string, Point>;
export interface View { x: number; y: number; k: number }

export const CARD_W = 248;
export const HEAD_H = 38;
export const ROW_H = 26;
/** The "+ N fields" line under a card showing relations only. */
export const MORE_H = 24;
export const CARD_PAD = 5;
export const GAP_X = 120;
export const GAP_Y = 36;
/** Between unlinked cards in their rows: room for a self relation's loop. */
export const GAP_ALONE = 72;
/** How far a self relation's loop reaches out of the card's right edge. */
export const SELF_LOOP = 36;
/** A column taller than this continues in a second one beside it. */
export const MAX_COL_H = 1500;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;

const CASCADES: readonly string[] = ["setNull", "cascade", "restrict"];

interface CollectionLike { id: string; name: string; type?: string | null; fields: string }

function schemaField(f: FieldDef, names: ReadonlySet<string>): SchemaField {
  const out: SchemaField = { name: f.name, type: f.type, required: !!f.required };
  if (f.type === "relation") {
    const cascade = f.options?.["cascade"];
    out.target = f.collection ?? "";
    out.resolved = !!f.collection && names.has(f.collection);
    out.cascade = typeof cascade === "string" && CASCADES.includes(cascade) ? (cascade as CascadeMode) : "setNull";
  }
  return out;
}

/** Cards by name; one arrow per relation field whose target exists. */
export function buildGraph(collections: readonly CollectionLike[]): SchemaGraph {
  const sorted = [...collections].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(sorted.map((c) => c.name));
  const idByName = new Map(sorted.map((c) => [c.name, c.id]));
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  for (const c of sorted) {
    const type = c.type ?? "base";
    let defs = parseFields(c.fields).filter((f) => !f.system && typeof f?.name === "string");
    // The server leaves an auth collection's email and verified out of
    // `fields`; the schema editor lists them first, and so does the card.
    if (type === "auth" && !defs.some((f) => f.implicit)) {
      const own = new Set(defs.map((f) => f.name));
      defs = [...AUTH_IMPLICIT_FIELDS.filter((f) => !own.has(f.name)), ...defs];
    }
    const fields = defs.map((f) => schemaField(f, names));
    nodes.push({ id: c.id, name: c.name, type, fields });
    for (const f of fields) {
      if (f.type !== "relation" || !f.resolved) continue;
      edges.push({ id: `${c.id}:${f.name}`, from: c.id, field: f.name, to: idByName.get(f.target!)!, cascade: f.cascade! });
    }
  }
  return { nodes, edges };
}

/** The field rows a card lists: all of them, or the relations only. */
export function visibleFields(node: SchemaNode, compact: boolean): SchemaField[] {
  return compact ? node.fields.filter((f) => f.type === "relation") : node.fields;
}

/** Fields a relations-only card leaves out. */
export function hiddenFieldCount(node: SchemaNode, compact: boolean): number {
  return node.fields.length - visibleFields(node, compact).length;
}

export function cardHeight(node: SchemaNode, compact: boolean): number {
  const rows = visibleFields(node, compact).length;
  const more = hiddenFieldCount(node, compact) > 0 ? MORE_H : 0;
  // A card with nothing to list still gets one row, saying so.
  const body = rows === 0 && more === 0 ? ROW_H : rows * ROW_H + more;
  return HEAD_H + body + CARD_PAD;
}

/**
 * Where each card goes when nobody has moved it: referenced collections on
 * the left, the ones pointing at them to their right, unlinked ones in rows
 * underneath.
 */
export function layoutGraph(graph: SchemaGraph, compact: boolean): Positions {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Set<string>>();   // node → nodes it points at
  const into = new Map<string, Set<string>>();  // node → nodes pointing at it
  for (const n of graph.nodes) { out.set(n.id, new Set()); into.set(n.id, new Set()); }
  for (const e of graph.edges) {
    if (e.from === e.to) continue; // a self relation doesn't place anything
    out.get(e.from)!.add(e.to);
    into.get(e.to)!.add(e.from);
  }
  const linked = graph.nodes.filter((n) => out.get(n.id)!.size > 0 || into.get(n.id)!.size > 0);
  const alone = graph.nodes.filter((n) => !linked.includes(n));

  // Rank = the longest chain of relations leaving the node. A relation that
  // closes a cycle is skipped, so cycles end.
  const rank = new Map<string, number>();
  const open = new Set<string>();
  const rankOf = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    open.add(id);
    let r = 0;
    for (const t of out.get(id)!) if (!open.has(t)) r = Math.max(r, rankOf(t) + 1);
    open.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const n of linked) rankOf(n.id);
  // A collection that points at nothing sits right before the nearest one
  // pointing at it, not at the far left away from it.
  for (const n of linked) {
    if (out.get(n.id)!.size > 0) continue;
    const refs = [...into.get(n.id)!].map((id) => rank.get(id)!);
    if (refs.length > 0) rank.set(n.id, Math.max(0, Math.min(...refs) - 1));
  }

  const maxRank = Math.max(-1, ...linked.map((n) => rank.get(n.id)!));
  const cols: SchemaNode[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of linked) cols[rank.get(n.id)!]!.push(n);

  // Fewer crossings: order each column by where its neighbours sit, once
  // left to right and once back.
  const index = new Map<string, number>();
  const reindex = (col: SchemaNode[]) => col.forEach((n, i) => index.set(n.id, i));
  cols.forEach(reindex);
  const sortBy = (col: SchemaNode[], neighbours: (id: string) => Set<string>, side: (r: number, own: number) => boolean) => {
    const key = new Map<string, number>();
    for (const n of col) {
      const own = rank.get(n.id)!;
      const at = [...neighbours(n.id)].filter((id) => side(rank.get(id)!, own)).map((id) => index.get(id)!);
      key.set(n.id, at.length > 0 ? at.reduce((a, b) => a + b, 0) / at.length : index.get(n.id)!);
    }
    col.sort((a, b) => key.get(a.id)! - key.get(b.id)! || a.name.localeCompare(b.name));
    reindex(col);
  };
  const both = (id: string) => new Set([...out.get(id)!, ...into.get(id)!]);
  for (let r = 1; r < cols.length; r++) sortBy(cols[r]!, both, (o, own) => o < own);
  for (let r = cols.length - 2; r >= 0; r--) sortBy(cols[r]!, both, (o, own) => o > own);

  // Split columns that grew too tall, then stack and centre each one.
  const stacks: SchemaNode[][] = [];
  for (const col of cols) {
    let cur: SchemaNode[] = [];
    let h = 0;
    for (const n of col) {
      const nh = cardHeight(n, compact) + GAP_Y;
      if (cur.length > 0 && h + nh > MAX_COL_H) { stacks.push(cur); cur = []; h = 0; }
      cur.push(n);
      h += nh;
    }
    if (cur.length > 0) stacks.push(cur);
  }
  const stackH = (s: SchemaNode[]) => s.reduce((sum, n) => sum + cardHeight(n, compact), 0) + GAP_Y * (s.length - 1);
  const tallest = Math.max(0, ...stacks.map(stackH));
  const pos: Positions = {};
  stacks.forEach((s, i) => {
    let y = Math.round((tallest - stackH(s)) / 2);
    for (const n of s) {
      pos[n.id] = { x: i * (CARD_W + GAP_X), y };
      y += cardHeight(n, compact) + GAP_Y;
    }
  });

  // Unlinked collections: rows under the linked block, at least four across.
  const perRow = Math.max(4, Math.min(stacks.length, 6));
  let y = stacks.length > 0 ? tallest + GAP_Y * 3 : 0;
  for (let i = 0; i < alone.length; i += perRow) {
    const row = alone.slice(i, i + perRow);
    row.forEach((n, j) => { pos[n.id] = { x: j * (CARD_W + GAP_ALONE), y }; });
    y += Math.max(...row.map((n) => cardHeight(n, compact))) + GAP_Y;
  }
  // Every node has a place, whatever the graph looked like.
  for (const n of graph.nodes) if (!pos[n.id] && byId.has(n.id)) pos[n.id] = { x: 0, y: 0 };
  return pos;
}

/** Saved positions over the automatic ones; saved entries for gone collections are dropped. */
export function mergePositions(auto: Positions, saved: Positions): Positions {
  const out: Positions = {};
  for (const id of Object.keys(auto)) out[id] = validPoint(saved[id]) ? saved[id]! : auto[id]!;
  return out;
}

function validPoint(p: unknown): p is Point {
  const q = p as Point | undefined;
  return !!q && Number.isFinite(q.x) && Number.isFinite(q.y);
}

/** Saved positions as stored in the browser; anything malformed reads as none. */
export function parsePositions(raw: string | null): Positions {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Positions = {};
    for (const [id, p] of Object.entries(parsed as Record<string, unknown>)) {
      if (validPoint(p)) out[id] = { x: p.x, y: p.y };
    }
    return out;
  } catch {
    return {};
  }
}

export interface EdgeGeometry {
  /** SVG path from the relation's field row to the target card's header. */
  d: string;
  /** Where the line leaves the field row. */
  start: Point;
  /** The middle of the curve, where the label goes. */
  mid: Point;
}

const bezier = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/**
 * The curve for one relation. It leaves the side of the field row that faces
 * the target and ends on the facing side of the target's header; cards
 * stacked in one column (and a card pointing at itself) are joined round
 * their right edges.
 */
export function edgeGeometry(from: Point, rowIndex: number, to: Point): EdgeGeometry {
  const sy = from.y + HEAD_H + Math.max(0, rowIndex) * ROW_H + ROW_H / 2;
  const ty = to.y + HEAD_H / 2;
  const clear = 24; // room a curve needs between two cards
  let sx: number, tx: number, c1: number, c2: number;
  if (from.x >= to.x + CARD_W + clear) {
    sx = from.x; tx = to.x + CARD_W;
    const bend = Math.max(40, (sx - tx) / 2);
    c1 = sx - bend; c2 = tx + bend;
  } else if (to.x >= from.x + CARD_W + clear) {
    sx = from.x + CARD_W; tx = to.x;
    const bend = Math.max(40, (tx - sx) / 2);
    c1 = sx + bend; c2 = tx - bend;
  } else {
    sx = from.x + CARD_W; tx = to.x + CARD_W;
    // A card pointing at itself keeps its loop tight, clear of its neighbour.
    const out = Math.max(sx, tx) + (sx === tx && from.y === to.y ? SELF_LOOP : Math.min(120, 48 + Math.abs(sy - ty) / 6));
    c1 = out; c2 = out;
  }
  return {
    d: `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`,
    start: { x: sx, y: sy },
    mid: { x: bezier(sx, c1, c2, tx, 0.5), y: bezier(sy, sy, ty, ty, 0.5) },
  };
}

export interface Bounds { x: number; y: number; w: number; h: number }

/** The box round every card; null when there are none. */
export function graphBounds(nodes: readonly SchemaNode[], pos: Positions, compact: boolean): Bounds | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + CARD_W); y1 = Math.max(y1, p.y + cardHeight(n, compact));
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** The view showing all of `b` centred in a `w`×`h` viewport, never above 100%. */
export function fitView(b: Bounds | null, w: number, h: number, pad = 48): View {
  if (!b || w <= 0 || h <= 0) return { x: 0, y: 0, k: 1 };
  const k = clampZoom(Math.min(1, (w - pad * 2) / Math.max(1, b.w), (h - pad * 2) / Math.max(1, b.h)));
  return { k, x: Math.round((w - b.w * k) / 2 - b.x * k), y: Math.round((h - b.h * k) / 2 - b.y * k) };
}

/** Zoom to `k`, keeping the canvas point under (`cx`, `cy`) where it is. */
export function zoomAt(view: View, k: number, cx: number, cy: number): View {
  const next = clampZoom(k);
  const ratio = next / view.k;
  return { k: next, x: cx - (cx - view.x) * ratio, y: cy - (cy - view.y) * ratio };
}

/** The view with a card in the middle of the viewport, zoom unchanged. */
export function centerOn(view: View, p: Point, height: number, w: number, h: number): View {
  return { k: view.k, x: Math.round(w / 2 - (p.x + CARD_W / 2) * view.k), y: Math.round(h / 2 - (p.y + height / 2) * view.k) };
}

/** What lights up for a hovered or selected card: itself, its arrows, and the cards at their other ends. */
export function neighbourhood(graph: SchemaGraph, nodeId: string): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set([nodeId]);
  const edges = new Set<string>();
  for (const e of graph.edges) {
    if (e.from !== nodeId && e.to !== nodeId) continue;
    edges.add(e.id);
    nodes.add(e.from);
    nodes.add(e.to);
  }
  return { nodes, edges };
}

const CASCADE_LABEL: Record<CascadeMode, string> = {
  setNull: "set null",
  cascade: "cascade",
  restrict: "restrict",
};

/** What deleting the target record does, in words. */
export function cascadeLabel(mode: CascadeMode): string {
  return CASCADE_LABEL[mode];
}
