import { create } from "zustand";
import { api, type ApiResponse, type Collection } from "../api.ts";

interface CollectionsState {
  list: Collection[];
  loading: boolean;
  loaded: boolean;
  load: (force?: boolean) => Promise<void>;
  invalidate: () => void;
}

export const useCollections = create<CollectionsState>((set, get) => ({
  list: [],
  loading: false,
  loaded: false,
  load: async (force = false) => {
    if (get().loading) return;
    if (get().loaded && !force) return;
    set({ loading: true });
    const res = await api.get<ApiResponse<Collection[]>>("/api/collections");
    set({
      list: res.data ?? [],
      loading: false,
      loaded: true,
    });
  },
  invalidate: () => set({ loaded: false }),
}));
