import React, { useEffect, useRef, useState } from "react";
import { Dialog } from "primereact/dialog";
import { Sidebar } from "primereact/sidebar";
import Icon from "./Icon.tsx";
import { useToast, type ToastSeverity } from "../stores/toast.ts";

// ── FieldTypeChip ────────────────────────────────────────────────────────────
export const FieldTypeChip: React.FC<{ type: string }> = ({ type }) => (
  <span className={`type-chip ${type}`}>
    <span className="dot" />
    {type}
  </span>
);

// ── Toggle (custom — no PrimeReact dep) ──────────────────────────────────────
export const Toggle: React.FC<{
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}> = ({ on, onChange, disabled, ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-disabled={disabled || undefined}
    aria-label={ariaLabel}
    disabled={disabled}
    data-on={on ? "true" : "false"}
    className="vb-toggle"
    onClick={(e) => { e.stopPropagation(); if (!disabled) onChange(!on); }}
  >
    <span className="vb-toggle-thumb" />
  </button>
);

// ── StatCard ─────────────────────────────────────────────────────────────────
export const StatCard: React.FC<{
  label: string;
  value: string | number;
  delta?: string;
  deltaDir?: "up" | "down";
  spark?: number[];
}> = ({ label, value, delta, deltaDir, spark }) => (
  <div className="stat-card">
    <div className="stat-label">{label}</div>
    <div className="stat-value">
      <span className="num">{value}</span>
      {delta && <span className={`delta ${deltaDir ?? "up"}`}>{delta}</span>}
    </div>
    {spark && (
      <div className="stat-spark">
        {spark.map((h, i) => (
          <span key={i} style={{ height: `${h * 100}%`, opacity: 0.3 + h * 0.6 }} />
        ))}
      </div>
    )}
  </div>
);

// ── Modal (PrimeReact Dialog) ─────────────────────────────────────────────────
export const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
}> = ({ open, onClose, title, footer, children, width }) => (
  <Dialog
    visible={open}
    onHide={onClose}
    header={title}
    footer={footer}
    style={{ width: width ? `${width}px` : "520px" }}
    modal
    draggable={false}
    resizable={false}
  >
    {children}
  </Dialog>
);

// ── Drawer (PrimeReact Sidebar) ───────────────────────────────────────────────
export const Drawer: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  idLabel?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ open, onClose, title, idLabel, footer, children }) => (
  <Sidebar
    visible={open}
    onHide={onClose}
    position="right"
    style={{ width: "480px" }}
    header={
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
        {idLabel && (
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              background: "rgba(255,255,255,0.05)",
              padding: "2px 6px",
              borderRadius: 4,
            }}
          >
            {idLabel}
          </span>
        )}
      </div>
    }
  >
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      <div style={{ flex: 1, overflow: "auto" }}>{children}</div>
      {footer && (
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border-subtle)",
            display: "flex",
            gap: "var(--space-2)",
            justifyContent: "flex-end",
            background: "var(--bg-app)",
            margin: "16px -20px -18px",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  </Sidebar>
);

// ── Toast ─────────────────────────────────────────────────────────────────────
// Custom toast host (per admin redesign §13). Bottom-right stack of
// bg-panel-2 cards with mono icon + body + dismiss. Identical messages
// fired in quick succession aggregate into one card with a × N counter.
const TOAST_LIFE_MS = 3500;
const TOAST_AGGREGATE_WINDOW_MS = 3000;

interface ToastIconProps { sev: ToastSeverity }

function ToastIcon({ sev }: ToastIconProps) {
  if (sev === "error") return <Icon name="alert" size={16} style={{ color: "#ff7b7b" }} />;
  if (sev === "warn")  return <Icon name="alert" size={16} style={{ color: "#fbbf24" }} />;
  if (sev === "info")  return <Icon name="info"  size={16} style={{ color: "#60a5fa" }} />;
  return <Icon name="check" size={16} style={{ color: "#4ade80" }} />;
}

export const ToastHost: React.FC = () => {
  const queue = useToast((s) => s.queue);
  const dismiss = useToast((s) => s.dismiss);
  const seen = useRef<Map<number, number>>(new Map()); // id → timer
  const [counts, setCounts] = useState<Record<number, number>>({});

  useEffect(() => {
    for (const entry of queue) {
      if (seen.current.has(entry.id)) continue;

      // Aggregate: fold into the most-recent visible toast with the same text.
      const visible = queue.filter((e) => seen.current.has(e.id) || e.id === entry.id);
      const sibling = visible.find(
        (e) => e.id !== entry.id && e.text === entry.text && e.severity === entry.severity
              && Date.now() - e.ts < TOAST_AGGREGATE_WINDOW_MS
      );
      if (sibling) {
        // Increment sibling count, drop the new one.
        setCounts((prev) => ({ ...prev, [sibling.id]: (prev[sibling.id] ?? 1) + 1 }));
        // Refresh sibling timer.
        const oldTimer = seen.current.get(sibling.id);
        if (oldTimer) clearTimeout(oldTimer);
        const newTimer = window.setTimeout(() => dismiss(sibling.id), TOAST_LIFE_MS);
        seen.current.set(sibling.id, newTimer);
        // Immediately remove the new dup from store.
        dismiss(entry.id);
        continue;
      }

      const timer = window.setTimeout(() => dismiss(entry.id), TOAST_LIFE_MS);
      seen.current.set(entry.id, timer);
    }
    // Clean up timers for entries that left the queue.
    for (const [id, timer] of seen.current.entries()) {
      if (!queue.find((e) => e.id === id)) {
        clearTimeout(timer);
        seen.current.delete(id);
        setCounts((prev) => {
          if (!(id in prev)) return prev;
          const { [id]: _drop, ...rest } = prev;
          return rest;
        });
      }
    }
  }, [queue, dismiss]);

  return (
    <div className="toast-host">
      {queue.map((entry) => {
        const count = counts[entry.id] ?? 1;
        return (
          <div key={entry.id} className={`vb-toast sev-${entry.severity}`} role="status">
            <span className="ic"><ToastIcon sev={entry.severity} /></span>
            <span className="body">{entry.text}</span>
            {count > 1 && <span className="dup">×{count}</span>}
            <button
              className="dismiss"
              onClick={() => dismiss(entry.id)}
              aria-label="Dismiss"
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
};

// Legacy interface kept for pages that pass icon strings
export interface Toast { id: string; text: string; icon?: string; color?: string }

export type { Toast as ToastEntry };
