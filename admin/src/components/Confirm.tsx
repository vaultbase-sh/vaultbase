import { useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import Icon from "./Icon.tsx";

export interface ConfirmOptions {
  title?: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface PendingConfirm extends Required<Omit<ConfirmOptions, "title">> {
  title: string | undefined;
  resolve: (ok: boolean) => void;
}

let setPendingExternal: ((p: PendingConfirm | null) => void) | null = null;

/**
 * Show a custom confirmation modal. Returns true when the user confirms,
 * false when cancelled or dismissed.
 *
 * Mount `<ConfirmHost />` once at the app root for this to work.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setPendingExternal) {
      // Fallback to native confirm if host isn't mounted
      resolve(window.confirm(opts.message));
      return;
    }
    setPendingExternal({
      title: opts.title,
      message: opts.message,
      danger: opts.danger ?? false,
      confirmLabel: opts.confirmLabel ?? (opts.danger ? "Delete" : "Confirm"),
      cancelLabel: opts.cancelLabel ?? "Cancel",
      resolve,
    });
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    setPendingExternal = setPending;
    return () => { setPendingExternal = null; };
  }, []);

  function close(ok: boolean) {
    if (!pending) return;
    pending.resolve(ok);
    setPending(null);
  }

  const title = pending?.title ?? (pending?.danger ? "Confirm delete" : "Confirm");

  return (
    <Dialog
      visible={!!pending}
      onHide={() => close(false)}
      header={
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 28,
              height: 28,
              display: "grid",
              placeItems: "center",
              borderRadius: 8,
              background: pending?.danger ? "rgba(248,113,113,0.15)" : "var(--accent-glow)",
              color: pending?.danger ? "var(--danger)" : "var(--accent-light)",
            }}
          >
            <Icon name={pending?.danger ? "alert" : "info"} size={14} />
          </span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{title}</span>
        </div>
      }
      modal
      draggable={false}
      resizable={false}
      style={{ width: 440 }}
      contentStyle={{ padding: "16px 18px" }}
    >
      <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
        {pending?.message}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="btn btn-ghost" onClick={() => close(false)} autoFocus>
          {pending?.cancelLabel}
        </button>
        <button
          className={pending?.danger ? "btn btn-danger" : "btn btn-primary"}
          onClick={() => close(true)}
        >
          {pending?.confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
