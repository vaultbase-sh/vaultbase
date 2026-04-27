import React, { useEffect, useRef } from "react";
import { Dialog } from "primereact/dialog";
import { Sidebar } from "primereact/sidebar";
import { InputSwitch } from "primereact/inputswitch";
import { Toast as PrimeToast } from "primereact/toast";
import Icon from "./Icon.tsx";
import { useToast } from "../stores/toast.ts";

// ── FieldTypeChip ────────────────────────────────────────────────────────────
export const FieldTypeChip: React.FC<{ type: string }> = ({ type }) => (
  <span className={`type-chip ${type}`}>
    <span className="dot" />
    {type}
  </span>
);

// ── Toggle (PrimeReact InputSwitch) ──────────────────────────────────────────
export const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <InputSwitch checked={on} onChange={(e) => onChange(e.value)} />
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
            padding: "12px 0 0",
            borderTop: "0.5px solid var(--border-default)",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          {footer}
        </div>
      )}
    </div>
  </Sidebar>
);

// ── Toast ─────────────────────────────────────────────────────────────────────
// Subscribes to the zustand toast store and forwards entries to PrimeReact's
// Toast component. Mount once at the app root.
export const ToastHost: React.FC = () => {
  const toastRef = useRef<PrimeToast>(null);
  const queue = useToast((s) => s.queue);
  const dismiss = useToast((s) => s.dismiss);
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    for (const entry of queue) {
      if (seen.current.has(entry.id)) continue;
      seen.current.add(entry.id);
      toastRef.current?.show({ severity: entry.severity, detail: entry.text, life: 3000 });
      // Drop from store after life so memory doesn't grow
      setTimeout(() => dismiss(entry.id), 3500);
    }
  }, [queue, dismiss]);

  return <PrimeToast ref={toastRef} position="bottom-right" />;
};

// Legacy interface kept for pages that pass icon strings
export interface Toast { id: string; text: string; icon?: string; color?: string }

export type { Toast as ToastEntry };
