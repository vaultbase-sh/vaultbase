import { create } from "zustand";
import { api, type ApiResponse, type Collection } from "../api.ts";
import { singleFlight } from "../lib/single-flight.ts";

interface CollectionsState {
  list: Collection[];
  loading: boolean;
  loaded: boolean;
  /** Load once; `force` reloads, and queues a fresh load if one is running. */
  load: (force?: boolean) => Promise<void>;
  invalidate: () => void;
}

export const useCollections = create<CollectionsState>((set, get) => {
  const fetchList = singleFlight(async () => {
    set({ loading: true });
    try {
      const res = await api.get<ApiResponse<Collection[]>>("/api/v1/collections");
      if (res.data) set({ list: res.data });
    } finally {
      set({ loading: false, loaded: true });
    }
  });
  return {
    list: [],
    loading: false,
    loaded: false,
    load: async (force = false) => {
      if (get().loaded && !force) return;
      await fetchList(force);
    },
    invalidate: () => set({ loaded: false }),
  };
});
