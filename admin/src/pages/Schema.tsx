import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "../components/Icon.tsx";
import { FilterInput, VbBtn, VbEmptyState, VbPageHeader } from "../components/Vb.tsx";
import { useCollections } from "../stores/collections.ts";
import { collectionTypeIcon } from "../lib/collection-type-icon.ts";
import {
  CARD_W, HEAD_H, MAX_ZOOM, MIN_ZOOM, MORE_H, ROW_H,
  buildGraph, cardHeight, cascadeLabel, centerOn, edgeGeometry, fitView, graphBounds, hiddenFieldCount,
  layoutGraph, mergePositions, neighbourhood, parsePositions, visibleFields, zoomAt,
  type Positions, type SchemaNode, type View,
} from "../lib/schema-graph.ts";
import "../styles/schema.css";

// Where the cards were dragged to and the relations-only switch, per browser.
const POSITIONS_KEY = "vb_schema_positions";
const COMPACT_KEY = "vb_schema_compact";
const DOT_GAP = 24;

function readPositions(): Positions {
  try { return parsePositions(localStorage.getItem(POSITIONS_KEY)); } catch { return {}; }
}
function writePositions(p: Positions): void {
  try {
    if (Object.keys(p).length === 0) localStorage.removeItem(POSITIONS_KEY);
    else localStorage.setItem(POSITIONS_KEY, JSON.stringify(p));
  } catch { /* per-browser nicety only */ }
}
function readCompact(): boolean {
  try { return localStorage.getItem(COMPACT_KEY) === "1"; } catch { return false; }
}

interface CardProps {
  node: SchemaNode;
  x: number;
  y: number;
  compact: boolean;
  dim: boolean;
  lit: boolean;
  selected: boolean;
  match: boolean;
  dragging: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onRelation: (target: string) => void;
}

const Card = memo(function Card({ node, x, y, compact, dim, lit, selected, match, dragging, onHover, onSelect, onRelation }: CardProps) {
  const rows = visibleFields(node, compact);
  const hidden = hiddenFieldCount(node, compact);
  return (
    <div
      className="schema-card"
      data-node={node.id}
      data-dim={dim ? "1" : undefined}
      data-lit={lit ? "1" : undefined}
      data-selected={selected ? "1" : undefined}
      data-match={match ? "1" : undefined}
      data-dragging={dragging ? "1" : undefined}
      style={{ left: x, top: y, width: CARD_W, height: cardHeight(node, compact) }}
      onPointerEnter={() => onHover(node.id)}
      onPointerLeave={() => onHover(null)}
      onClick={() => onSelect(node.id)}
    >
      <div className="schema-card-head" style={{ height: HEAD_H }}>
        <Icon name={collectionTypeIcon(node.type)} size={13} />
        <Link
          className="schema-card-name"
          to={`/_/collections/${encodeURIComponent(node.id)}/edit`}
          draggable={false}
          title={`Edit ${node.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          {node.name}
        </Link>
        <span className="schema-card-type">{node.type}</span>
      </div>
      {rows.map((f) => f.type === "relation" ? (
        <button
          key={f.name}
          type="button"
          className="schema-row"
          data-broken={f.resolved ? undefined : "1"}
          style={{ height: ROW_H }}
          title={f.resolved
            ? `${node.name}.${f.name} holds a ${f.target} record id. On delete: ${cascadeLabel(f.cascade!)}. Click to go to ${f.target}.`
            : `No collection is named '${f.target}'`}
          onClick={(e) => { e.stopPropagation(); if (f.resolved) onRelation(f.target!); }}
        >
          <span className="schema-row-name">{f.name}{f.required && <span className="schema-row-req" title="Required">*</span>}</span>
          <span className="schema-row-type">→ {f.target || "?"}</span>
        </button>
      ) : (
        <div key={f.name} className="schema-row" style={{ height: ROW_H }}>
          <span className="schema-row-name">{f.name}{f.required && <span className="schema-row-req" title="Required">*</span>}</span>
          <span className="schema-row-type">{f.type}</span>
        </div>
      ))}
      {hidden > 0 && (
        <div className="schema-row schema-row-note" style={{ height: MORE_H }}>
          + {hidden} {hidden === 1 ? "field" : "fields"}
        </div>
      )}
      {rows.length === 0 && hidden === 0 && (
        <div className="schema-row schema-row-note" style={{ height: ROW_H }}>No fields</div>
      )}
    </div>
  );
});

interface Gesture {
  kind: "pan" | "card";
  id?: string;
  px: number;
  py: number;
  ox: number;
  oy: number;
  moved: boolean;
}

export default function Schema() {
  const navigate = useNavigate();
  const list = useCollections((s) => s.list);
  const loaded = useCollections((s) => s.loaded);
  const load = useCollections((s) => s.load);
  useEffect(() => { void load(); }, [load]);

  const [compact, setCompact] = useState(readCompact);
  const [saved, setSaved] = useState<Positions>(readPositions);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [glide, setGlide] = useState(false);
  const [dragging, setDragging] = useState<{ kind: "pan" | "card"; id?: string } | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const graph = useMemo(() => buildGraph(list), [list]);
  const auto = useMemo(() => layoutGraph(graph, compact), [graph, compact]);
  const positions = useMemo(() => mergePositions(auto, saved), [auto, saved]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const moved = useMemo(() => graph.nodes.some((n) => saved[n.id]), [graph, saved]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
  // The latest values, for handlers that outlive a render.
  const live = useRef({ view, positions, saved });
  live.current = { view, positions, saved };

  const size = () => {
    const el = viewportRef.current;
    return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
  };

  const fit = useCallback((pos: Positions, animate = true) => {
    const { w, h } = size();
    setGlide(animate);
    setView(fitView(graphBounds(graph.nodes, pos, compact), w, h));
  }, [graph, compact]);

  // Fit when the schema first shows, and again when the cards change size.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || graph.nodes.length === 0) return;
    const key = compact ? "compact" : "full";
    if (fittedFor.current === key) return;
    const first = fittedFor.current === null;
    fittedFor.current = key;
    fit(positions, !first);
    // Only the first load and the relations-only switch refit.
  }, [loaded, graph.nodes.length, compact]);

  // The wheel zooms about the pointer. Registered by hand: React's onWheel
  // is passive, so it can't stop the page from scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // A trackpad pinch arrives as ctrl+wheel with small deltas.
      const step = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setGlide(false);
      setView((v) => zoomAt(v, v.k * step, e.clientX - rect.left, e.clientY - rect.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [loaded, graph.nodes.length]);

  const zoomBy = (factor: number) => {
    const { w, h } = size();
    setGlide(true);
    setView((v) => zoomAt(v, v.k * factor, w / 2, h / 2));
  };

  const focusNode = useCallback((id: string) => {
    const node = nodeById.get(id);
    const p = live.current.positions[id];
    if (!node || !p) return;
    const el = viewportRef.current;
    setSelected(id);
    // The card under the pointer is about to slide away from it.
    setHoverNode(null);
    setGlide(true);
    setView((v) => centerOn(v, p, cardHeight(node, compact), el?.clientWidth ?? 0, el?.clientHeight ?? 0));
  }, [nodeById, compact]);

  const onRelation = useCallback((target: string) => {
    const node = graph.nodes.find((n) => n.name === target);
    if (node) focusNode(node.id);
  }, [graph, focusNode]);

  const onSelect = useCallback((id: string) => setSelected((cur) => (cur === id ? null : id)), []);
  const onHover = useCallback((id: string | null) => { if (!gesture.current?.moved) setHoverNode(id); }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest("[data-nodrag]")) return;
    const id = target.closest<HTMLElement>("[data-node]")?.dataset["node"];
    const p = id ? live.current.positions[id] : undefined;
    gesture.current = id && p
      ? { kind: "card", id, px: e.clientX, py: e.clientY, ox: p.x, oy: p.y, moved: false }
      : { kind: "pan", px: e.clientX, py: e.clientY, ox: live.current.view.x, oy: live.current.view.y, moved: false };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.px;
    const dy = e.clientY - g.py;
    if (!g.moved) {
      // A press that doesn't travel stays a click (on a name, a relation, a card).
      if (Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setGlide(false);
      setHoverNode(null);
      setHoverEdge(null);
      setDragging({ kind: g.kind, id: g.id });
    }
    if (g.kind === "pan") {
      setView((v) => ({ ...v, x: g.ox + dx, y: g.oy + dy }));
    } else {
      const k = live.current.view.k;
      setSaved((s) => ({ ...s, [g.id!]: { x: Math.round(g.ox + dx / k), y: Math.round(g.oy + dy / k) } }));
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    gesture.current = null;
    if (!g?.moved) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(null);
    if (g.kind === "card") writePositions(live.current.saved);
    // The click that ends a drag isn't a click on whatever is under it.
    swallowClick.current = true;
    window.setTimeout(() => { swallowClick.current = false; }, 0);
  }

  function onClickCapture(e: React.MouseEvent) {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? 240 : 60;
    const pan = (dx: number, dy: number) => { setGlide(false); setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })); };
    switch (e.key) {
      case "ArrowLeft": pan(step, 0); break;
      case "ArrowRight": pan(-step, 0); break;
      case "ArrowUp": pan(0, step); break;
      case "ArrowDown": pan(0, -step); break;
      case "+": case "=": zoomBy(1.25); break;
      case "-": case "_": zoomBy(0.8); break;
      case "0": fit(positions); break;
      case "Escape": setSelected(null); break;
      default: return;
    }
    e.preventDefault();
  }

  function toggleCompact() {
    setCompact((c) => {
      try { localStorage.setItem(COMPACT_KEY, c ? "0" : "1"); } catch { /* per-browser nicety only */ }
      return !c;
    });
  }

  function resetLayout() {
    setSaved({});
    writePositions({});
    fit(auto);
  }

  // Search: the matches stay lit, Enter walks through them.
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? graph.nodes.filter((n) => n.name.toLowerCase().includes(q)) : []), [graph, q]);
  const matchIds = useMemo(() => new Set(matches.map((n) => n.id)), [matches]);
  const jump = useRef(0);
  useEffect(() => { jump.current = 0; }, [q]);
  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (matches.length === 0) return;
    focusNode(matches[jump.current % matches.length]!.id);
    jump.current += 1;
  }

  // What is lit: a hovered arrow and its two ends, else the hovered (or
  // selected) card with its arrows and neighbours, else the search matches.
  const focus = hoverNode ?? selected;
  const lit = useMemo(() => {
    if (hoverEdge) {
      const e = graph.edges.find((x) => x.id === hoverEdge);
      if (e) return { nodes: new Set([e.from, e.to]), edges: new Set([e.id]) };
    }
    return focus && nodeById.has(focus) ? neighbourhood(graph, focus) : null;
  }, [graph, nodeById, hoverEdge, focus]);

  const edges = useMemo(() => {
    return graph.edges.flatMap((e) => {
      const from = positions[e.from];
      const to = positions[e.to];
      const node = nodeById.get(e.from);
      if (!from || !to || !node) return [];
      const row = visibleFields(node, compact).findIndex((f) => f.name === e.field);
      return [{ edge: e, geo: edgeGeometry(from, row, to), lit: !!lit?.edges.has(e.id) }];
    });
  }, [graph, positions, nodeById, compact, lit]);

  const label = hoverEdge ? edges.find((x) => x.edge.id === hoverEdge) : undefined;

  // The dots follow the canvas; when zoomed far out they thin so they don't fill it.
  let dot = DOT_GAP * view.k;
  while (dot < 14) dot *= 2;

  const count = `${graph.nodes.length} ${graph.nodes.length === 1 ? "collection" : "collections"} · ${graph.edges.length} ${graph.edges.length === 1 ? "relation" : "relations"}`;
  const empty = loaded && graph.nodes.length === 0;

  return (
    <div style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column", overflow: "hidden" }}>
      <VbPageHeader
        breadcrumb={["Schema"]}
        title="Schema"
        sub={loaded && !empty ? count : "Collections and the relations between them."}
        right={!empty && (
          <>
            <form onSubmit={onSearchSubmit} role="search" aria-label="Find a collection">
              <FilterInput placeholder="Find a collection…" value={query} onChange={setQuery} width={200} />
            </form>
            <VbBtn
              kind={compact ? "soft" : "ghost"}
              size="sm"
              onClick={toggleCompact}
              title={compact ? "Show every field on each card" : "Show only the relation fields on each card"}
            >
              {compact ? "All fields" : "Relations only"}
            </VbBtn>
            <VbBtn kind="ghost" size="sm" icon="refresh" disabled={!moved} onClick={resetLayout} title="Put every card back where the automatic layout places it">
              Reset layout
            </VbBtn>
          </>
        )}
      />

      {!loaded ? (
        <div style={{ flex: 1, padding: 40, color: "var(--vb-fg-3)", textAlign: "center", fontSize: 12 }}>Loading…</div>
      ) : empty ? (
        <VbEmptyState
          icon="schema"
          title="No collections yet"
          body="Collections show up here as cards, with an arrow for each relation field."
          actions={<VbBtn kind="primary" size="sm" icon="plus" onClick={() => navigate("/_/collections")}>New collection</VbBtn>}
        />
      ) : (
        <div
          ref={viewportRef}
          className="schema-view"
          data-glide={glide ? "1" : undefined}
          data-drag={dragging?.kind}
          tabIndex={0}
          role="application"
          aria-label="Schema diagram. Drag to pan, scroll to zoom, arrow keys to move, plus and minus to zoom, 0 to fit."
          style={{ backgroundSize: `${dot}px ${dot}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClickCapture={onClickCapture}
          onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
          onKeyDown={onKeyDown}
        >
          <div className="schema-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg className="schema-edges" aria-hidden="true">
              <defs>
                <marker id="schema-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path className="schema-arrow" d="M 0 1 L 10 5 L 0 9 z" />
                </marker>
                <marker id="schema-arrow-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path className="schema-arrow-lit" d="M 0 1 L 10 5 L 0 9 z" />
                </marker>
              </defs>
              {edges.map(({ edge, geo, lit: on }) => (
                <g key={edge.id} className="schema-edge" data-dim={lit || q !== "" ? "1" : undefined}>
                  {!on && <path className="schema-edge-line" d={geo.d} markerEnd="url(#schema-arrow)" />}
                  {!on && <circle className="schema-edge-port" cx={geo.start.x} cy={geo.start.y} r={3} />}
                  <path
                    className="schema-edge-hit"
                    d={geo.d}
                    onPointerEnter={() => { if (!gesture.current?.moved) setHoverEdge(edge.id); }}
                    onPointerLeave={() => setHoverEdge(null)}
                  />
                </g>
              ))}
            </svg>

            {graph.nodes.map((n) => {
              const p = positions[n.id];
              if (!p) return null;
              const isLit = !!lit?.nodes.has(n.id);
              const isMatch = matchIds.has(n.id);
              return (
                <Card
                  key={n.id}
                  node={n}
                  x={p.x}
                  y={p.y}
                  compact={compact}
                  dim={lit ? !isLit : q !== "" && !isMatch}
                  lit={isLit && n.id !== focus}
                  selected={n.id === selected}
                  match={!lit && isMatch}
                  dragging={dragging?.id === n.id}
                  onHover={onHover}
                  onSelect={onSelect}
                  onRelation={onRelation}
                />
              );
            })}

            {/* Lit arrows go over the cards: one that passes behind a card
                would look like it starts there. */}
            {lit && (
              <svg className="schema-edges schema-edges-top" aria-hidden="true">
                {edges.filter((x) => x.lit).map(({ edge, geo }) => (
                  <g key={edge.id} className="schema-edge" data-lit="1">
                    <path className="schema-edge-line" d={geo.d} markerEnd="url(#schema-arrow-lit)" />
                    <circle className="schema-edge-port" cx={geo.start.x} cy={geo.start.y} r={3} />
                  </g>
                ))}
              </svg>
            )}

            {label && (
              <div
                className="schema-edge-label"
                style={{
                  left: label.geo.mid.x,
                  top: label.geo.mid.y,
                  // Counter-scaled, so it reads the same at any zoom.
                  transform: `scale(${1 / view.k}) translate(-50%, -50%)`,
                }}
              >
                {nodeById.get(label.edge.from)?.name}.{label.edge.field} → {nodeById.get(label.edge.to)?.name}
                <span> · on delete: {cascadeLabel(label.edge.cascade)}</span>
              </div>
            )}
          </div>

          <div className="schema-controls" data-nodrag role="group" aria-label="Zoom">
            <button type="button" onClick={() => zoomBy(0.8)} disabled={view.k <= MIN_ZOOM} title="Zoom out (−)" aria-label="Zoom out">−</button>
            <button type="button" className="schema-zoom" onClick={() => zoomBy(1 / view.k)} title="Zoom to 100%" aria-label={`Zoom ${Math.round(view.k * 100)}%. Set to 100%`}>
              {Math.round(view.k * 100)}%
            </button>
            <button type="button" onClick={() => zoomBy(1.25)} disabled={view.k >= MAX_ZOOM} title="Zoom in (+)" aria-label="Zoom in">+</button>
            <button type="button" onClick={() => fit(positions)} title="Fit to screen (0)" aria-label="Fit to screen">
              <Icon name="maximize" size={12} />
            </button>
          </div>
          <div className="schema-hint">Drag to move · scroll to zoom · click a relation to follow it</div>
        </div>
      )}
    </div>
  );
}
