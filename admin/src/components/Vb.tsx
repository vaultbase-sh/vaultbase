/**
 * Design primitives — A·Refined aesthetic from the Notifications + Collections
 * redesign handoffs (vaultbase/project/shell.jsx + collections.jsx).
 *
 * All visual tokens come from the --vb-* CSS variable block in globals.css.
 * Pages assemble these into the bigger layouts; nothing here knows about
 * routing, data fetching, or the rest of the admin.
 */
import React from "react";
import Icon from "./Icon.tsx";

// ── Tone palette (status pills, status dots) ────────────────────────────────

export type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

const TONE_BG: Record<Tone, string> = {
  neutral: "rgba(255,255,255,0.06)",
  success: "var(--vb-status-success-bg)",
  warning: "var(--vb-status-warning-bg)",
  danger:  "var(--vb-status-danger-bg)",
  accent:  "var(--vb-accent-soft)",
};
const TONE_FG: Record<Tone, string> = {
  neutral: "rgba(231,229,225,0.7)",
  success: "var(--vb-status-success)",
  warning: "var(--vb-status-warning)",
  danger:  "var(--vb-status-danger)",
  accent:  "var(--vb-accent)",
};

// ── Pill (status chip) ──────────────────────────────────────────────────────

export const VbPill: React.FC<{
  tone?: Tone;
  children: React.ReactNode;
  dot?: boolean;
}> = ({ tone = "neutral", children, dot }) => (
  <span style={{
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "2px 7px",
    borderRadius: 4,
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: 0.2,
    background: TONE_BG[tone],
    color: TONE_FG[tone],
    fontFamily: "var(--font-mono)",
    textTransform: "lowercase",
  }}>
    {dot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: TONE_FG[tone] }} />}
    {children}
  </span>
);

// ── Code chip ───────────────────────────────────────────────────────────────

export const VbCode: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <code style={{
    fontFamily: "var(--font-mono)",
    fontSize: "0.86em",
    padding: "1px 5px",
    borderRadius: 4,
    background: "var(--vb-code-bg)",
    color: "var(--vb-code-fg)",
    whiteSpace: "nowrap",
  }}>{children}</code>
);

// ── Button ──────────────────────────────────────────────────────────────────

export const VbBtn: React.FC<{
  kind?: "primary" | "ghost" | "soft" | "danger";
  size?: "sm" | "md";
  icon?: string;
  iconRight?: string;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
  type?: "button" | "submit";
  title?: string;
  style?: React.CSSProperties;
}> = ({ kind = "primary", size = "md", icon, iconRight, disabled, onClick, children, type = "button", title, style }) => {
  const sizes = size === "sm" ? { h: 26, px: 10, fs: 11.5 } : { h: 30, px: 12, fs: 12.5 };
  const styles: Record<string, React.CSSProperties> = {
    primary: { background: "var(--vb-accent)", color: "#fff", border: "1px solid transparent" },
    ghost:   { background: "transparent", color: "var(--vb-fg-2)", border: "1px solid var(--vb-border-2)" },
    soft:    { background: "var(--vb-bg-3)", color: "var(--vb-fg)", border: "1px solid transparent" },
    danger:  { background: "transparent", color: "var(--vb-status-danger)", border: "1px solid rgba(232,90,79,0.30)" },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...styles[kind],
        height: sizes.h,
        padding: `0 ${sizes.px}px`,
        borderRadius: 5,
        fontSize: sizes.fs,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        opacity: disabled ? 0.5 : 1,
        transition: "background 120ms",
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
      {iconRight && <Icon name={iconRight} size={11} />}
    </button>
  );
};

// ── Input ───────────────────────────────────────────────────────────────────

export const VbInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  ({ mono, style, ...rest }, ref) => (
    <input
      ref={ref}
      {...rest}
      style={{
        width: "100%",
        height: 32,
        padding: "0 10px",
        background: "var(--vb-bg-3)",
        border: "1px solid var(--vb-border-2)",
        borderRadius: 5,
        color: "var(--vb-fg)",
        fontFamily: mono ? "var(--font-mono)" : "inherit",
        fontSize: mono ? 12 : 12.5,
        outline: "none",
        ...(style ?? {}),
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = "var(--vb-accent)";
        e.currentTarget.style.background = "var(--vb-bg-2)";
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "var(--vb-border-2)";
        e.currentTarget.style.background = "var(--vb-bg-3)";
        rest.onBlur?.(e);
      }}
    />
  ),
);
VbInput.displayName = "VbInput";

// ── Field (label + hint + child) ────────────────────────────────────────────

export const VbField: React.FC<{
  label: string;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, hint, right, children }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
      <span style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        color: "var(--vb-fg-2)",
        fontFamily: "var(--font-mono)",
      }}>{label}</span>
      {right}
    </div>
    {hint && <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>{hint}</div>}
    {children}
  </label>
);

// ── Status dot (live / paused / not configured) ─────────────────────────────

export const VbStatusDot: React.FC<{
  state: { configured: boolean; enabled: boolean };
}> = ({ state }) => {
  let tone: "success" | "warning" | "neutral" = "neutral";
  let label = "not configured";
  if (state.configured && state.enabled) { tone = "success"; label = "live"; }
  else if (state.configured && !state.enabled) { tone = "warning"; label = "paused"; }
  const color = tone === "success" ? "var(--vb-status-success)"
    : tone === "warning" ? "var(--vb-status-warning)"
    : "rgba(255,255,255,0.18)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: color,
        boxShadow: tone === "success" ? "0 0 0 3px rgba(98,204,156,0.16)" : "none",
      }} />
      <span style={{
        fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
        color: tone === "neutral" ? "var(--vb-fg-3)" : color,
        fontFamily: "var(--font-mono)",
      }}>{label}</span>
    </span>
  );
};

// ── Stat (small mono number with label) ─────────────────────────────────────

export const VbStat: React.FC<{
  label: string;
  value: React.ReactNode;
  tone?: "danger" | null;
}> = ({ label, value, tone }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2 }}>
    <span style={{
      fontSize: 12, fontWeight: 600,
      color: tone === "danger" ? "var(--vb-status-danger)" : "var(--vb-fg)",
      fontFamily: "var(--font-mono)",
      fontVariantNumeric: "tabular-nums",
    }}>{value}</span>
    <span style={{
      fontSize: 9.5, color: "var(--vb-fg-3)",
      textTransform: "uppercase", letterSpacing: 0.6,
    }}>{label}</span>
  </div>
);

// ── BigStat (summary-strip card: large mono value with label) ───────────────

export const BigStat: React.FC<{
  label: string;
  value: React.ReactNode;
  tone?: "danger" | null;
}> = ({ label, value, tone }) => (
  <div style={{
    background: "var(--vb-bg-2)",
    padding: "11px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 2,
  }}>
    <span style={{
      fontSize: 9.5, color: "var(--vb-fg-3)",
      textTransform: "uppercase", letterSpacing: 1,
      fontFamily: "var(--font-mono)",
    }}>{label}</span>
    <span style={{
      fontSize: 18, fontWeight: 600,
      color: tone === "danger" ? "var(--vb-status-danger)" : "var(--vb-fg)",
      fontFamily: "var(--font-mono)",
      fontVariantNumeric: "tabular-nums",
    }}>{value}</span>
  </div>
);

// ── Collection avatar (single-letter monogram in coral square) ──────────────

export const CollectionAvatar: React.FC<{
  letter: string;
  size?: number;
  accent?: string;
}> = ({ letter, size = 22, accent }) => (
  <div style={{
    width: size,
    height: size,
    borderRadius: 5,
    background: accent ?? "var(--vb-accent)",
    color: "#fff",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: Math.round(size * 0.55),
    fontWeight: 700,
    fontFamily: "var(--font-mono)",
    flexShrink: 0,
  }}>{letter.toUpperCase()}</div>
);

// ── Collection-type pill (base / auth / view) ───────────────────────────────

const TYPE_PALETTE: Record<string, { bg: string; fg: string }> = {
  base: { bg: "rgba(255,255,255,0.06)", fg: "var(--vb-fg-2)" },
  auth: { bg: "rgba(124,160,255,0.16)", fg: "#9bb6ff" },
  view: { bg: "rgba(168,124,255,0.16)", fg: "#b8a0ff" },
};

export const TypePill: React.FC<{ type: string }> = ({ type }) => {
  const p = TYPE_PALETTE[type] ?? TYPE_PALETTE["base"]!;
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: "2px 7px",
      borderRadius: 4,
      fontSize: 10.5,
      fontWeight: 600,
      background: p.bg,
      color: p.fg,
      fontFamily: "var(--font-mono)",
    }}>
      <span style={{ width: 4, height: 4, borderRadius: "50%", background: p.fg }} />
      {type}
    </span>
  );
};

// ── Field-type pill (text / number / bool / etc.) ──────────────────────────

const FIELD_TYPE_COLOR: Record<string, string> = {
  text:     "#9bb6ff",
  number:   "#62cc9c",
  bool:     "#f0b056",
  email:    "#9bb6ff",
  url:      "#9bb6ff",
  date:     "#b8a0ff",
  password: "#ee7a70",
  editor:   "#9bb6ff",
  geoPoint: "#62cc9c",
  file:     "#f0b056",
  relation: "#b8a0ff",
  select:   "#9bb6ff",
  json:     "#62cc9c",
  autodate: "#b8a0ff",
  vector:   "#62cc9c",
};

export const FieldTypePill: React.FC<{
  type: string;
  size?: "sm" | "md";
}> = ({ type, size = "sm" }) => {
  const color = FIELD_TYPE_COLOR[type] ?? "var(--vb-fg-3)";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: size === "sm" ? "2px 7px" : "3px 9px",
      borderRadius: 4,
      fontSize: size === "sm" ? 10.5 : 11.5,
      fontWeight: 600,
      background: "rgba(255,255,255,0.05)",
      color,
      fontFamily: "var(--font-mono)",
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
      {type}
    </span>
  );
};

export const FIELD_TYPES: Array<{ id: string; color: string }> = Object.entries(FIELD_TYPE_COLOR).map(
  ([id, color]) => ({ id, color }),
);

// ── Activity sparkbar (12 bars, opacity tied to recency) ────────────────────

export const ActivityBar: React.FC<{
  rate: number;        // 0..1
  lastWrite?: string | null;
}> = ({ rate, lastWrite }) => {
  const bars = 12;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1.5, height: 16 }}>
        {Array.from({ length: bars }).map((_, i) => {
          const active = i / bars < rate;
          const h = 4 + ((i * 7919) % 11);
          return (
            <div key={i} style={{
              width: 2,
              height: h,
              background: active ? "var(--vb-accent)" : "var(--vb-bg-3)",
              borderRadius: 1,
              opacity: active ? 0.4 + (i / bars) * 0.6 : 1,
            }} />
          );
        })}
      </div>
      <span style={{
        fontSize: 10.5,
        color: "var(--vb-fg-3)",
        fontFamily: "var(--font-mono)",
      }}>{lastWrite ?? "—"}</span>
    </div>
  );
};

// ── FilterInput (small search input with leading icon) ──────────────────────

export const FilterInput: React.FC<{
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
  width?: number | string;
  mono?: boolean;
}> = ({ placeholder, value, onChange, width = 220, mono }) => (
  <div style={{ position: "relative", width }}>
    <span style={{
      position: "absolute",
      left: 8,
      top: "50%",
      transform: "translateY(-50%)",
      color: "var(--vb-fg-3)",
      display: "flex",
    }}>
      <Icon name="search" size={12} />
    </span>
    <input
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      style={{
        width: "100%",
        height: 28,
        padding: "0 10px 0 24px",
        background: "var(--vb-bg-2)",
        border: "1px solid var(--vb-border-2)",
        borderRadius: 5,
        color: "var(--vb-fg)",
        fontFamily: mono ? "var(--font-mono)" : "inherit",
        fontSize: 12,
        outline: "none",
      }}
    />
  </div>
);

// ── Page header (breadcrumb · h1 · sub · right) ────────────────────────────

export const VbPageHeader: React.FC<{
  breadcrumb?: React.ReactNode[];
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}> = ({ breadcrumb, title, sub, right }) => (
  <header style={{
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    padding: "20px 28px 18px",
    borderBottom: "1px solid var(--vb-border)",
    gap: 16,
  }}>
    <div style={{ minWidth: 0 }}>
      {breadcrumb && breadcrumb.length > 0 && (
        <div style={{
          fontSize: 11.5,
          color: "var(--vb-fg-3)",
          fontFamily: "var(--font-mono)",
          marginBottom: 6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          {breadcrumb.map((b, i) => (
            <React.Fragment key={i}>
              <span style={{ color: i === breadcrumb.length - 1 ? "var(--vb-fg-2)" : "var(--vb-fg-3)" }}>{b}</span>
              {i < breadcrumb.length - 1 && <span style={{ color: "var(--vb-fg-3)", opacity: 0.5 }}>/</span>}
            </React.Fragment>
          ))}
        </div>
      )}
      <h1 style={{
        margin: 0,
        fontSize: 22,
        fontWeight: 600,
        color: "var(--vb-fg)",
        letterSpacing: -0.2,
        lineHeight: 1.2,
      }}>{title}</h1>
      {sub && (
        <div style={{
          marginTop: 6,
          fontSize: 12.5,
          color: "var(--vb-fg-2)",
          maxWidth: 620,
          lineHeight: 1.5,
        }}>{sub}</div>
      )}
    </div>
    {right && <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>{right}</div>}
  </header>
);

// ── Tab strip (with optional counts) ────────────────────────────────────────

export interface VbTab<Id extends string> {
  id: Id;
  label: string;
  count?: number | string | null;
  icon?: string;
}

export function VbTabs<Id extends string>({
  tabs,
  active,
  onChange,
  rightSlot,
}: {
  tabs: VbTab<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 28px",
      borderBottom: "1px solid var(--vb-border)",
      background: "var(--vb-bg-1)",
    }}>
      <div style={{ display: "flex" }}>
        {tabs.map((t) => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              style={{
                appearance: "none",
                border: 0,
                background: "transparent",
                fontFamily: "inherit",
                padding: "12px 14px",
                fontSize: 12.5,
                fontWeight: isActive ? 600 : 500,
                color: isActive ? "var(--vb-fg)" : "var(--vb-fg-2)",
                borderBottom: `2px solid ${isActive ? "var(--vb-accent)" : "transparent"}`,
                marginBottom: -1,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              {t.icon && <Icon name={t.icon} size={12} />}
              {t.label}
              {t.count !== undefined && t.count !== null && (
                <span style={{
                  fontSize: 10.5,
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: "var(--vb-bg-3)",
                  color: "var(--vb-fg-3)",
                  fontFamily: "var(--font-mono)",
                }}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
      {rightSlot && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingRight: 4 }}>
          {rightSlot}
        </div>
      )}
    </div>
  );
}

// ── Sub-page header (used inside Records / CollectionEdit — has back chevron,
//     breadcrumb-with-avatar, and right-side actions). Distinct from
//     VbPageHeader which is the larger top-level header.
// ──────────────────────────────────────────────────────────────────────────

export const VbSubHeader: React.FC<{
  onBack?: () => void;
  /** Mono breadcrumb fragments rendered with `/` separators. */
  crumbs: React.ReactNode[];
  /** Optional right-side area (action buttons, status pill, etc.). */
  right?: React.ReactNode;
}> = ({ onBack, crumbs, right }) => (
  <header style={{
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 28px",
    borderBottom: "1px solid var(--vb-border)",
    gap: 16,
    background: "var(--vb-bg-1)",
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
      {onBack && (
        <button
          onClick={onBack}
          style={{
            appearance: "none",
            border: "1px solid var(--vb-border-2)",
            background: "var(--vb-bg-2)",
            width: 28,
            height: 28,
            borderRadius: 5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--vb-fg-2)",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title="Back"
        >
          <Icon name="chevronLeft" size={12} />
        </button>
      )}
      <div style={{
        fontSize: 11.5,
        color: "var(--vb-fg-3)",
        fontFamily: "var(--font-mono)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
        flexWrap: "wrap",
      }}>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ opacity: 0.5 }}>/</span>}
            {c}
          </React.Fragment>
        ))}
      </div>
    </div>
    {right && (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
        {right}
      </div>
    )}
  </header>
);

// ── Sort menu (presentational button — caller wires the menu) ───────────────

export const SortMenu: React.FC<{
  label?: string;
  value: string;
  onClick?: () => void;
}> = ({ label = "Sort", value, onClick }) => (
  <button
    onClick={onClick}
    style={{
      appearance: "none",
      border: "1px solid var(--vb-border-2)",
      background: "var(--vb-bg-2)",
      color: "var(--vb-fg-2)",
      height: 32,
      padding: "0 10px",
      borderRadius: 5,
      fontFamily: "inherit",
      fontSize: 12,
      fontWeight: 500,
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
    }}
  >
    <span style={{ color: "var(--vb-fg-3)" }}>{label}</span>
    <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg)" }}>{value}</span>
    <Icon name="chevronDown" size={11} />
  </button>
);

// ── VbTable ────────────────────────────────────────────────────────────────
//
// Custom data table matching the design's aesthetic. Used in place of the
// default-styled PrimeReact DataTable on the Records / AuditLog / Webhook-
// deliveries surfaces. Smaller PR tables get a CSS override (.vb-pr-table)
// instead of a swap.
//
// Visual spec:
//   - Header strip: --vb-bg-1 background, mono uppercase 10.5px label.
//   - Rows: --vb-bg-2 background, hairline border between rows, hover --vb-bg-3,
//     selected --vb-accent-soft + 2px left accent bar.
//   - Cells: 11/14 padding, mono for numeric/id, sans for text, "—" for empty.
//   - Empty state slot, lazy-friendly pagination footer in mono.

export interface VbTableColumn<Row> {
  /** Unique id, also the default key into the row for value extraction. */
  key: string;
  /** Header label (rendered uppercase mono). */
  label: string;
  /** Fixed pixel / CSS-grid width. Mutually exclusive with `flex`. */
  width?: number | string;
  /** Flex weight inside the grid. Default 1 if neither width nor flex set. */
  flex?: number;
  /** Mono font for the cell value. Default false. */
  mono?: boolean;
  /** Make the header click-to-sort. Default false. */
  sortable?: boolean;
  /** Cell text alignment. Default "left". */
  align?: "left" | "right" | "center";
  /** Override cell rendering. Default: stringified row[key]. */
  render?: (row: Row, idx: number) => React.ReactNode;
}

export interface VbTableProps<Row> {
  rows: Row[];
  columns: VbTableColumn<Row>[];
  rowKey: (row: Row) => string;
  loading?: boolean;
  /** When true, prepend a checkbox selection column. */
  selectable?: boolean;
  selected?: Row[];
  onSelectionChange?: (rows: Row[]) => void;
  onRowClick?: (row: Row) => void;
  /**
   * Single-column sort spec: `"key"` for asc, `"-key"` for desc, `""` for none.
   * Header click cycles asc → desc → none for sortable columns.
   */
  sort?: string;
  onSortChange?: (sort: string) => void;
  /** When provided, renders a pagination footer. 1-indexed page. */
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  /** Rendered when rows.length === 0 and not loading. */
  emptyState?: React.ReactNode;
  /** Optional className on the outer wrapper. */
  className?: string;
  /** Outer max height — when set, the body scrolls and the header sticks. */
  maxBodyHeight?: number | string;
}

function buildGridTemplate(columns: VbTableColumn<unknown>[], selectable: boolean): string {
  const colTemplate = columns.map((c) => {
    if (c.width !== undefined) {
      return typeof c.width === "number" ? `${c.width}px` : c.width;
    }
    return c.flex ? `${c.flex}fr` : "1fr";
  });
  return selectable ? ["32px", ...colTemplate].join(" ") : colTemplate.join(" ");
}

export function VbTable<Row>({
  rows,
  columns,
  rowKey,
  loading,
  selectable,
  selected,
  onSelectionChange,
  onRowClick,
  sort,
  onSortChange,
  total,
  page = 1,
  pageSize = 30,
  onPageChange,
  emptyState,
  className,
  maxBodyHeight,
}: VbTableProps<Row>) {
  const gridTemplate = buildGridTemplate(columns as VbTableColumn<unknown>[], !!selectable);
  const selectedKeys = new Set((selected ?? []).map(rowKey));
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selectedKeys.has(rowKey(r)));
  const someOnPageSelected = rows.some((r) => selectedKeys.has(rowKey(r))) && !allOnPageSelected;

  function toggleRow(row: Row, on: boolean) {
    if (!onSelectionChange) return;
    const key = rowKey(row);
    if (on) {
      if (selectedKeys.has(key)) return;
      onSelectionChange([...(selected ?? []), row]);
    } else {
      onSelectionChange((selected ?? []).filter((r) => rowKey(r) !== key));
    }
  }

  function toggleAllOnPage(on: boolean) {
    if (!onSelectionChange) return;
    if (on) {
      const merged = [...(selected ?? [])];
      for (const r of rows) {
        if (!selectedKeys.has(rowKey(r))) merged.push(r);
      }
      onSelectionChange(merged);
    } else {
      const pageKeys = new Set(rows.map(rowKey));
      onSelectionChange((selected ?? []).filter((r) => !pageKeys.has(rowKey(r))));
    }
  }

  function clickHeader(col: VbTableColumn<Row>) {
    if (!col.sortable || !onSortChange) return;
    const cur = sort ?? "";
    if (cur === col.key) onSortChange(`-${col.key}`);
    else if (cur === `-${col.key}`) onSortChange("");
    else onSortChange(col.key);
  }

  function sortIndicator(col: VbTableColumn<Row>): React.ReactNode {
    if (!col.sortable) return null;
    const cur = sort ?? "";
    const active = cur === col.key || cur === `-${col.key}`;
    if (!active) {
      return (
        <span style={{ opacity: 0.35, marginLeft: 4 }}>
          <Icon name="sort" size={10} />
        </span>
      );
    }
    return (
      <span style={{ marginLeft: 4, color: "var(--vb-accent)" }}>
        {cur.startsWith("-") ? "↓" : "↑"}
      </span>
    );
  }

  const totalPages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const showFooter = total != null && totalPages != null;

  return (
    <div
      className={["vb-table", className].filter(Boolean).join(" ")}
      style={{
        background: "var(--vb-bg-2)",
        border: "1px solid var(--vb-border)",
        borderRadius: 8,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: gridTemplate,
          gap: 10,
          padding: "9px 14px",
          alignItems: "center",
          background: "var(--vb-bg-1)",
          borderBottom: "1px solid var(--vb-border)",
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          color: "var(--vb-fg-3)",
          fontFamily: "var(--font-mono)",
          position: "sticky",
          top: 0,
          zIndex: 1,
        }}
      >
        {selectable && (
          <input
            type="checkbox"
            checked={allOnPageSelected}
            ref={(el) => { if (el) el.indeterminate = someOnPageSelected; }}
            onChange={(e) => toggleAllOnPage(e.target.checked)}
            style={{ accentColor: "var(--vb-accent)", cursor: "pointer" }}
          />
        )}
        {columns.map((c) => (
          <span
            key={c.key}
            onClick={() => clickHeader(c)}
            style={{
              cursor: c.sortable ? "pointer" : "default",
              userSelect: "none",
              textAlign: c.align ?? "left",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: c.align === "right" ? "flex-end" : c.align === "center" ? "center" : "flex-start",
              minWidth: 0,
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
            }}
          >
            {c.label}
            {sortIndicator(c)}
          </span>
        ))}
      </div>

      {/* Body */}
      <div
        style={{
          maxHeight: maxBodyHeight,
          overflowY: maxBodyHeight ? "auto" : "visible",
          minHeight: rows.length === 0 ? undefined : 0,
        }}
      >
        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--vb-fg-3)", fontSize: 12 }}>
            Loading…
          </div>
        ) : rows.length === 0 ? (
          emptyState ?? (
            <div style={{ padding: "32px", textAlign: "center", color: "var(--vb-fg-3)", fontSize: 12 }}>
              No rows.
            </div>
          )
        ) : (
          rows.map((row, i) => {
            const key = rowKey(row);
            const isSel = selectedKeys.has(key);
            return (
              <div
                key={key}
                onClick={() => onRowClick?.(row)}
                style={{
                  display: "grid",
                  gridTemplateColumns: gridTemplate,
                  gap: 10,
                  padding: "11px 14px",
                  alignItems: "center",
                  borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--vb-border)",
                  background: isSel ? "var(--vb-accent-soft)" : "transparent",
                  borderLeft: isSel ? "2px solid var(--vb-accent)" : "2px solid transparent",
                  cursor: onRowClick ? "pointer" : "default",
                  transition: "background 100ms",
                  position: "relative",
                  minWidth: 0,
                }}
                onMouseEnter={(e) => {
                  if (!isSel) e.currentTarget.style.background = "var(--vb-bg-3)";
                }}
                onMouseLeave={(e) => {
                  if (!isSel) e.currentTarget.style.background = "transparent";
                }}
              >
                {selectable && (
                  <input
                    type="checkbox"
                    checked={isSel}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => toggleRow(row, e.target.checked)}
                    style={{ accentColor: "var(--vb-accent)", cursor: "pointer" }}
                  />
                )}
                {columns.map((c) => {
                  const value = c.render
                    ? c.render(row, i)
                    : ((row as unknown as Record<string, unknown>)[c.key] as React.ReactNode);
                  const display = (value === null || value === undefined || value === "") ? (
                    <span style={{ color: "var(--vb-fg-3)" }}>—</span>
                  ) : value;
                  return (
                    <span
                      key={c.key}
                      style={{
                        fontSize: 12,
                        color: "var(--vb-fg)",
                        fontFamily: c.mono ? "var(--font-mono)" : "inherit",
                        fontVariantNumeric: c.mono ? "tabular-nums" : "normal",
                        textAlign: c.align ?? "left",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                        minWidth: 0,
                      }}
                    >
                      {display}
                    </span>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      {showFooter && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 14px",
            background: "var(--vb-bg-1)",
            borderTop: "1px solid var(--vb-border)",
            fontSize: 11.5,
            color: "var(--vb-fg-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>
            {total!.toLocaleString()} total · page <span style={{ color: "var(--vb-fg)" }}>{page}</span> /{" "}
            <span style={{ color: "var(--vb-fg-2)" }}>{totalPages}</span>
          </span>
          <span style={{ display: "inline-flex", gap: 6 }}>
            <button
              onClick={() => onPageChange?.(Math.max(1, page - 1))}
              disabled={page <= 1}
              style={pagerBtnStyle(page <= 1)}
            >
              <Icon name="chevronLeft" size={11} /> Prev
            </button>
            <button
              onClick={() => onPageChange?.(Math.min(totalPages!, page + 1))}
              disabled={page >= totalPages!}
              style={pagerBtnStyle(page >= totalPages!)}
            >
              Next <Icon name="chevronRight" size={11} />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function pagerBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    appearance: "none",
    border: "1px solid var(--vb-border-2)",
    background: "var(--vb-bg-2)",
    color: disabled ? "var(--vb-fg-3)" : "var(--vb-fg-2)",
    padding: "3px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontFamily: "inherit",
    fontWeight: 500,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
  };
}

// ── VbEmptyState ───────────────────────────────────────────────────────────

export const VbEmptyState: React.FC<{
  icon?: string;
  title: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ icon, title, body, actions }) => (
  <div
    style={{
      padding: "48px 28px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 12,
      textAlign: "center",
    }}
  >
    {icon && (
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          background: "var(--vb-bg-3)",
          border: "1px dashed var(--vb-border-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--vb-fg-3)",
        }}
      >
        <Icon name={icon} size={18} />
      </div>
    )}
    <div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--vb-fg)", marginBottom: 4 }}>
        {title}
      </div>
      {body && (
        <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", maxWidth: 380, lineHeight: 1.5 }}>
          {body}
        </div>
      )}
    </div>
    {actions && <div style={{ display: "flex", gap: 8, marginTop: 4 }}>{actions}</div>}
  </div>
);
