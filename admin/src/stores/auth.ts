import { create } from "zustand";
import { api, type ApiResponse } from "../api.ts";

interface AuthState {
  id: string;
  email: string;
  isAuthed: boolean;
  expiresAt: number | null;
  loaded: boolean;
  /** The last load() got no answer from the server. */
  unreachable: boolean;
  /** Pull auth state from the server (cookie-based). */
  load: () => Promise<void>;
  /** Called after a successful POST /api/v1/admin/auth/login. */
  signIn: (_token?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface MePayload { id: string; email: string; aud: string; exp?: number }

export const useAuth = create<AuthState>((set) => ({
  id: "",
  email: "",
  isAuthed: false,
  expiresAt: null,
  loaded: false,
  unreachable: false,
  load: async () => {
    // Always settle `loaded`, or the route guards render nothing forever.
    let res: ApiResponse<MePayload>;
    try {
      res = await api.get<ApiResponse<MePayload>>("/api/v1/admin/auth/me");
    } catch (e) {
      res = { error: String(e), code: 0 };
    }
    if (res.data?.id) {
      set({
        id: res.data.id,
        email: res.data.email ?? "",
        expiresAt: res.data.exp ?? null,
        isAuthed: true,
        loaded: true,
        unreachable: false,
      });
    } else if (res.code === 0) {
      set({ isAuthed: false, loaded: true, unreachable: true });
    } else {
      set({ id: "", email: "", expiresAt: null, isAuthed: false, loaded: true, unreachable: false });
    }
  },
  signIn: async () => {
    // Token is already on the cookie — pull /me to populate UI state.
    await useAuth.getState().load();
  },
  signOut: async () => {
    try { await api.post<ApiResponse<unknown>>("/api/v1/auth/logout", {}); } catch { /* noop */ }
    const { setMemoryToken } = await import("../api.ts");
    setMemoryToken(null);
    set({ id: "", email: "", expiresAt: null, isAuthed: false, loaded: true, unreachable: false });
  },
  refresh: async () => {
    await useAuth.getState().load();
  },
}));
