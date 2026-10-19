import { useEffect, useState } from "react";
import Icon from "./Icon.tsx";
import { Modal } from "./UI.tsx";
import { VbBtn } from "./Vb.tsx";

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
    <Modal
      open={!!pending}
      onClose={() => close(false)}
      width={440}
      title={
        <span className="vb-confirm__title">
          <span className="vb-confirm__mark" data-danger={pending?.danger ? "true" : undefined}>
            <Icon name={pending?.danger ? "alert" : "info"} size={13} />
          </span>
          <span>{title}</span>
        </span>
      }
      footer={
        <>
          <VbBtn kind="ghost" onClick={() => close(false)} autoFocus>{pending?.cancelLabel}</VbBtn>
          <VbBtn kind={pending?.danger ? "danger" : "primary"} onClick={() => close(true)}>{pending?.confirmLabel}</VbBtn>
        </>
      }
    >
      <div className="vb-confirm__msg">{pending?.message}</div>
    </Modal>
  );
}
