import React from "react";
import Icon from "./Icon.tsx";

// FieldTypeChip
export const FieldTypeChip: React.FC<{ type: string }> = ({ type }) => (
  <span className={`type-chip ${type}`}>
    <span className="dot" />
    {type}
  </span>
);

// Toggle
export const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <div
    className={`toggle${on ? " on" : ""}`}
    onClick={() => onChange(!on)}
    role="switch"
    aria-checked={on}
  />
);

// StatCard
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

// Modal
export const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
}> = ({ open, onClose, title, footer, children, width }) => {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={width ? { width } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn-icon close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
};

// Drawer
export const Drawer: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  idLabel?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ open, onClose, title, idLabel, footer, children }) => {
  if (!open) return null;
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>{title}</h2>
          {idLabel && <span className="id mono">{idLabel}</span>}
          <button className="btn-icon close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </>
  );
};

// Toast
interface Toast { id: string; text: string; icon?: string; color?: string }
export const ToastHost: React.FC<{ toasts: Toast[] }> = ({ toasts }) => (
  <div className="toast-host">
    {toasts.map((t) => (
      <div className="toast" key={t.id}>
        <Icon name={t.icon ?? "check"} size={14} style={{ color: t.color ?? "var(--success)" }} />
        <span>{t.text}</span>
      </div>
    ))}
  </div>
);

export type { Toast };
