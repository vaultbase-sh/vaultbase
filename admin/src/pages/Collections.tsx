import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, parseFields, type ApiResponse } from "../api.ts";
import { confirm } from "../components/Confirm.tsx";
import Icon from "../components/Icon.tsx";
import { toast } from "../stores/toast.ts";
import { useCollections } from "../stores/collections.ts";
import {
  ActivityBar,
  BigStat,
  CollectionAvatar,
  FilterInput,
  TypePill,
  VbBtn,
  VbPageHeader,
  VbTabs,
  type VbTab,
} from "../components/Vb.tsx";
import NewCollectionModal from "./NewCollectionModal.tsx";

type Tab = "all" | "auth" | "base" | "view";

/** Compact "5m ago" / "3h ago" / "2d ago" formatter for `lastUpdated`. */
function formatRel(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function Collections() {
  const navigate = useNavigate();
  const collections = useCollections((s) => s.list);
  const isLoading = useCollections((s) => s.loading);
  const isLoaded = useCollections((s) => s.loaded);
  const loadCollections = useCollections((s) => s.load);
  const invalidate = useCollections((s) => s.invalidate);
  const loading = isLoading || !isLoaded;

  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);

  // Per-collection counts + activity. Fetched separately so the page
  // renders the collection list immediately and the stats fill in.
  interface CollectionStats {
    name: string;
    type: "base" | "auth" | "view";
    recordCount: number | null;
    recordCountCapped: boolean;
    lastUpdated: number | null;
    recentWrites: number;
  }
  const [stats, setStats] = useState<Map<string, CollectionStats>>(new Map());
  const [statsWindowSec, setStatsWindowSec] = useState<number>(86400);

  function load() { invalidate(); void loadCollections(true); void loadStats(); }
  useEffect(() => { void loadCollections(); void loadStats(); }, [loadCollections]);

  async function loadStats(): Promise<void> {
    const res = await api.get<ApiResponse<CollectionStats[]> & { windowSec?: number }>(
      "/api/v1/admin/collections/stats",
    );
    if (!res.data) return;
    const m = new Map<string, CollectionStats>();
    for (const s of res.data) m.set(s.name, s);
    setStats(m);
    if (typeof res.windowSec === "number") setStatsWindowSec(res.windowSec);
  }

  async function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.stopPropagation();
    const ok = await confirm({
      title: "Delete collection",
      message: `Delete collection "${name}" and ALL its records?\n\nThis drops the underlying table and cannot be undone.`,
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/api/v1/collections/${id}`);
    toast(`Collection "${name}" deleted`, "trash");
    load();
  }

  // Per-collection metadata. `stats` is loaded async via /admin/collections/stats —
  // until then `recordCount` is null and the cell renders "—".
  const enriched = useMemo(() => collections.map((c) => {
    const s = stats.get(c.name);
    const recordCount = s?.recordCount ?? null;
    const capped = s?.recordCountCapped ?? false;
    // ActivityBar rate is 0..1. Map recent writes against a soft ceiling so
    // a busy collection saturates the bar without surprises. Saturate at
    // ~3% of the window's seconds (≈2.5k writes / 24h fills).
    const ceiling = Math.max(1, Math.floor(statsWindowSec * 0.03));
    const writeRate = s?.recentWrites
      ? Math.min(1, s.recentWrites / ceiling)
      : 0;
    const lastWrite = s?.lastUpdated ? formatRel(s.lastUpdated) : null;
    return {
      ...c,
      type: (c.type ?? "base") as "base" | "auth" | "view",
      fieldCount: parseFields(c.fields).length,
      records: recordCount,
      recordsCapped: capped,
      writeRate,
      lastWrite,
    };
  }), [collections, stats, statsWindowSec]);

  const counts = {
    all: enriched.length,
    auth: enriched.filter((c) => c.type === "auth").length,
    base: enriched.filter((c) => c.type === "base").length,
    view: enriched.filter((c) => c.type === "view").length,
  };

  const tabs: VbTab<Tab>[] = [
    { id: "all",  label: "All",  count: counts.all  },
    { id: "auth", label: "Auth", count: counts.auth },
    { id: "base", label: "Base", count: counts.base },
    { id: "view", label: "View", count: counts.view },
  ];

  const visible = enriched
    .filter((c) => tab === "all" || c.type === tab)
    .filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()));

  // Summary strip — total records / writes / storage will get their numbers
  // alongside the per-collection stats endpoint. For now: collection count is
  // real, the rest are placeholders.
  const totalFields = enriched.reduce((s, c) => s + c.fieldCount, 0);

  return (
    <div style={{
      display: "flex",
      flex: 1,
      minWidth: 0,
      flexDirection: "column",
      overflow: "hidden",
    }}>
      <VbPageHeader
        breadcrumb={["Collections"]}
        title="Collections"
        sub={
          <>
            Define your data shape. Each collection becomes a typed REST + realtime endpoint at{" "}
            <code style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.86em",
              padding: "1px 5px",
              borderRadius: 4,
              background: "var(--vb-code-bg)",
              color: "var(--vb-code-fg)",
            }}>/api/v1/&lt;name&gt;</code>.
          </>
        }
        right={
          <>
            <VbBtn kind="ghost" size="sm" icon="copy" disabled title="Import — v2">Import</VbBtn>
            <VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>
              New collection
            </VbBtn>
          </>
        }
      />

      <VbTabs<Tab>
        tabs={tabs}
        active={tab}
        onChange={setTab}
        rightSlot={
          <FilterInput
            placeholder="Search collections…"
            value={search}
            onChange={setSearch}
            width={220}
          />
        }
      />

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px" }}>
        {/* Summary strip */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 1,
          marginBottom: 16,
          background: "var(--vb-border)",
          border: "1px solid var(--vb-border)",
          borderRadius: 7,
          overflow: "hidden",
        }}>
          <BigStat label="Collections" value={enriched.length} />
          <BigStat label="Auth" value={counts.auth} />
          <BigStat label="Base" value={counts.base} />
          <BigStat label="Total fields" value={totalFields} />
        </div>

        {/* Table */}
        <div style={{
          background: "var(--vb-bg-2)",
          border: "1px solid var(--vb-border)",
          borderRadius: 8,
          overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 100px 130px 130px 100px 56px",
            padding: "9px 14px",
            borderBottom: "1px solid var(--vb-border)",
            background: "var(--vb-bg-1)",
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: "var(--vb-fg-3)",
            fontFamily: "var(--font-mono)",
          }}>
            <span>Name</span>
            <span>Type</span>
            <span>Records</span>
            <span>Activity</span>
            <span style={{ textAlign: "right" }}>Fields</span>
            <span />
          </div>

          {loading ? (
            <div style={{ padding: "32px", textAlign: "center", color: "var(--vb-fg-3)", fontSize: 12 }}>
              Loading…
            </div>
          ) : visible.length === 0 ? (
            <CollectionsEmptyState
              hasAny={enriched.length > 0}
              onNew={() => setShowNew(true)}
            />
          ) : (
            visible.map((c, i) => (
              <div
                key={c.id}
                onClick={() => navigate(`/_/collections/${c.id}/records`)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 100px 130px 130px 100px 56px",
                  padding: "11px 14px",
                  alignItems: "center",
                  borderBottom: i === visible.length - 1 ? "none" : "1px solid var(--vb-border)",
                  cursor: "pointer",
                  transition: "background 100ms",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--vb-bg-3)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <CollectionAvatar letter={c.name[0] ?? "?"} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <span style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--vb-fg)",
                      fontFamily: "var(--font-mono)",
                    }}>{c.name}</span>
                    <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>
                      {c.fieldCount} fields · id, created…
                    </span>
                  </div>
                </div>
                <span><TypePill type={c.type} /></span>
                <span style={{
                  fontSize: 12,
                  color: c.records == null ? "var(--vb-fg-3)" : "var(--vb-fg)",
                  fontFamily: "var(--font-mono)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {c.records == null
                    ? "—"
                    : c.recordsCapped
                      ? `${c.records.toLocaleString()}+`
                      : c.records.toLocaleString()}
                </span>
                <ActivityBar rate={c.writeRate} lastWrite={c.lastWrite} />
                <span style={{
                  textAlign: "right",
                  fontSize: 12,
                  color: "var(--vb-fg-2)",
                  fontFamily: "var(--font-mono)",
                  fontVariantNumeric: "tabular-nums",
                }}>{c.fieldCount}</span>
                <span style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/_/collections/${c.id}/edit`);
                    }}
                    title="Edit schema"
                    style={iconBtnStyle}
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, c.id, c.name)}
                    title="Delete"
                    style={{ ...iconBtnStyle, color: "var(--vb-status-danger)" }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <NewCollectionModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreate={(name) => {
          setShowNew(false);
          toast(`Collection "${name}" created`);
          load();
        }}
      />
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  appearance: "none",
  border: "0",
  background: "transparent",
  color: "var(--vb-fg-3)",
  cursor: "pointer",
  padding: 4,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

const CollectionsEmptyState: React.FC<{ hasAny: boolean; onNew: () => void }> = ({ hasAny, onNew }) => (
  <div style={{
    padding: "48px 28px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    textAlign: "center",
  }}>
    <div style={{
      width: 44,
      height: 44,
      borderRadius: 10,
      background: "var(--vb-bg-3)",
      border: "1px dashed var(--vb-border-2)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--vb-fg-3)",
    }}>
      <Icon name="stack" size={18} />
    </div>
    <div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--vb-fg)", marginBottom: 4 }}>
        {hasAny ? "No matches" : "No collections yet"}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", maxWidth: 380 }}>
        {hasAny
          ? "Try a different filter or search term."
          : "Collections are typed SQL tables with API rules and realtime broadcasts."}
      </div>
    </div>
    {!hasAny && (
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <VbBtn kind="primary" size="sm" icon="plus" onClick={onNew}>New collection</VbBtn>
        <a
          href="https://docs.vaultbase.dev/concepts/collections/"
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 26,
            padding: "0 10px",
            borderRadius: 5,
            background: "transparent",
            border: "1px solid var(--vb-border-2)",
            color: "var(--vb-fg-2)",
            fontSize: 11.5,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Read docs
          <Icon name="chevronRight" size={11} />
        </a>
      </div>
    )}
  </div>
);
