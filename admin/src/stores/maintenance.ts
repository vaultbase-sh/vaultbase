import { create } from "zustand";
import { api, type ApiResponse } from "../api.ts";

export type MaintenanceLevel = "full" | "read_only";

interface MaintenanceStore {
  /** The level while maintenance mode is on, null when it's off. */
  level: MaintenanceLevel | null;
  /** Re-read it from `/api/health`, which stays open in maintenance mode. */
  refresh: () => Promise<void>;
}

export const useMaintenance = create<MaintenanceStore>((set) => ({
  level: null,
  refresh: async () => {
    const res = await api.get<ApiResponse<{ maintenance?: MaintenanceLevel | null }>>("/api/health");
    if (res.data) set({ level: res.data.maintenance ?? null });
  },
}));
