import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

// ── Overlays: Modal and Drawer ───────────────────────────────────────────────
// Rendered into a `.vb-layer` on <body>, so the admin theme's `.app`-scoped
// rules (square corners, mono inputs and labels) reach them as they reach the
// pages. Escape and a click outside close the topmost overlay only, and focus
// goes back where it was when it closes.

const overlayStack: symbol[] = [];

function useOverlay(open: boolean, onClose: () => void, panel: React.RefObject<HTMLDivElement | null>, focusField = true) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = Symbol("overlay");
    overlayStack.push(id);
    const before = document.activeElement as HTMLElement | null;
    // Focus the first field (or the panel), unless something inside asked first.
    const t = window.setTimeout(() => {
      const el = panel.current;
      if (!el || el.contains(document.activeElement)) return;
      const editable = ":not([disabled]):not([readonly]):not([type=hidden])";
      const first = focusField
        ? el.querySelector<HTMLElement>(`.vb-ov__body input${editable}, .vb-ov__body textarea${editable}, .vb-ov__body select${editable}`)
        : null;
      (first ?? el).focus({ preventScroll: true });
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || overlayStack[overlayStack.length - 1] !== id) return;
      // A PrimeReact dropdown open inside the overlay closes first.
      if (document.querySelector(".p-dropdown-panel, .p-multiselect-panel")) return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      const i = overlayStack.indexOf(id);
      if (i >= 0) overlayStack.splice(i, 1);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [open, panel, focusField]);
}

const OverlayHeader: React.FC<{
  title: React.ReactNode;
  idLabel?: string | undefined;
  onClose: () => void;
  extra?: React.ReactNode;
}> = ({ title, idLabel, onClose, extra }) => (
  <div className="vb-ov__head">
    <div className="vb-ov__title">
      {typeof title === "string" ? <span>{title}</span> : title}
      {idLabel && <span className="vb-ov__id">{idLabel}</span>}
    </div>
    {extra}
    <button type="button" className="vb-ov__icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
      <Icon name="x" size={14} />
    </button>
  </div>
);

export const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  idLabel?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
  /** Panel style overrides (size, mostly). */
  style?: React.CSSProperties;
  /** Body style overrides; `padding: 0` for content that draws its own. */
  contentStyle?: React.CSSProperties;
  /** Offer a button that grows the panel to the whole window. */
  maximizable?: boolean;
}> = ({ open, onClose, title, idLabel, footer, children, width, style, contentStyle, maximizable }) => {
  const panel = useRef<HTMLDivElement>(null);
  const [max, setMax] = useState(false);
  useOverlay(open, onClose, panel);
  useEffect(() => { if (!open) setMax(false); }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="vb-layer">
      <div className="vb-ov__mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div
          ref={panel}
          className="vb-ov vb-modal"
          data-max={max ? "true" : undefined}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          style={{ width: width ?? 520, ...style, ...(max ? { width: "100vw", height: "100vh", maxWidth: "none", maxHeight: "none" } : {}) }}
        >
          <OverlayHeader
            title={title}
            idLabel={idLabel}
            onClose={onClose}
            extra={maximizable ? (
              <button type="button" className="vb-ov__icon" onClick={() => setMax((m) => !m)}
                aria-label={max ? "Restore size" : "Maximize"} title={max ? "Restore size" : "Maximize"}>
                <Icon name={max ? "minimize" : "maximize"} size={13} />
              </button>
            ) : null}
          />
          <div className="vb-ov__body" style={contentStyle}>{children}</div>
          {footer && <div className="vb-ov__foot">{footer}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export const Drawer: React.FC<{
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  idLabel?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
}> = ({ open, onClose, title, idLabel, footer, children, width }) => {
  const panel = useRef<HTMLDivElement>(null);
  // A drawer opens on something to read first; focus the panel, not a field.
  useOverlay(open, onClose, panel, false);
  if (!open) return null;
  return createPortal(
    <div className="vb-layer">
      <div className="vb-ov__mask vb-ov__mask--drawer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div ref={panel} className="vb-ov vb-drawer" role="dialog" aria-modal="true" tabIndex={-1} style={{ width: width ?? 480 }}>
          <OverlayHeader title={title} idLabel={idLabel} onClose={onClose} />
          <div className="vb-ov__body">{children}</div>
          {footer && <div className="vb-ov__foot">{footer}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
};

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
