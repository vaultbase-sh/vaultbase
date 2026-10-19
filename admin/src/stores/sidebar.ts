import { create } from "zustand";
import { api, type ApiResponse } from "../api.ts";
import { OPTIONAL_NAV_ITEMS, SIDEBAR_PINNED_KEY, parsePinned } from "../lib/nav.ts";

interface SidebarState {
  /** Optional pages pinned in Settings → Sidebar. */
  pinned: string[];
  /** Optional pages that have something in them (a flag, a webhook, a token). */
  inUse: string[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Re-check one page's usage, e.g. after leaving it. */
  refreshUsage: (id: string) => Promise<void>;
  setPinned: (ids: string[]) => Promise<string | null>;
}

async function hasEntries(endpoint: string): Promise<boolean> {
  const res = await api.get<ApiResponse<unknown[]>>(endpoint);
  return Array.isArray(res.data) && res.data.length > 0;
}

export const useSidebar = create<SidebarState>((set, get) => ({
  pinned: [],
  inUse: [],
  loaded: false,
  load: async () => {
    const [settings, ...usage] = await Promise.all([
      api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings"),
      ...OPTIONAL_NAV_ITEMS.filter((i) => i.usage).map(async (i) => ((await hasEntries(i.usage!)) ? i.id : null)),
    ]);
    set({
      pinned: parsePinned(settings.data?.[SIDEBAR_PINNED_KEY]),
      inUse: usage.filter((id): id is string => id !== null),
      loaded: true,
    });
  },
  refreshUsage: async (id) => {
    const item = OPTIONAL_NAV_ITEMS.find((i) => i.id === id);
    if (!item?.usage) return;
    const used = await hasEntries(item.usage);
    const rest = get().inUse.filter((x) => x !== id);
    set({ inUse: used ? [...rest, id] : rest });
  },
  setPinned: async (ids) => {
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      [SIDEBAR_PINNED_KEY]: ids.join(","),
    });
    if (res.error) return res.error;
    set({ pinned: ids });
    return null;
  },
}));
