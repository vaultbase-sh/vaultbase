import { create } from "zustand";

export type ToastSeverity = "success" | "info" | "warn" | "error";

export interface ToastEntry {
  id: number;
  text: string;
  severity: ToastSeverity;
  ts: number;
}

interface ToastState {
  queue: ToastEntry[];
  show: (text: string, severity?: ToastSeverity) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToast = create<ToastState>((set) => ({
  queue: [],
  show: (text, severity = "success") => {
    const entry: ToastEntry = { id: nextId++, text, severity, ts: Date.now() };
    set((s) => ({ queue: [...s.queue, entry] }));
  },
  dismiss: (id) => {
    set((s) => ({ queue: s.queue.filter((e) => e.id !== id) }));
  },
}));

/** Imperative helper that maps the existing `toast(text, icon)` signature. */
export function toast(text: string, icon?: string): void {
  const sev: ToastSeverity =
    icon === "trash" ? "warn"
    : icon === "info" ? "info"
    : icon === "alert" || icon === "x" ? "error"
    : "success";
  useToast.getState().show(text, sev);
}
