import { create } from "zustand";
import { api, type ApiResponse } from "../api.ts";

interface AuthState {
  email: string;
  isAuthed: boolean;
  expiresAt: number | null;
  loaded: boolean;
  /** Pull auth state from the server (cookie-based). */
  load: () => Promise<void>;
  /** Called after a successful POST /api/admin/auth/login. */
  signIn: (_token?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface MePayload { id: string; email: string; aud: string; exp?: number }

export const useAuth = create<AuthState>((set) => ({
  email: "",
  isAuthed: false,
  expiresAt: null,
  loaded: false,
  load: async () => {
    const res = await api.get<ApiResponse<MePayload>>("/api/admin/auth/me");
    if (res.data?.id) {
      set({
        email: res.data.email ?? "",
        expiresAt: res.data.exp ?? null,
        isAuthed: true,
        loaded: true,
      });
    } else {
      set({ email: "", expiresAt: null, isAuthed: false, loaded: true });
    }
  },
  signIn: async () => {
    // Token is already on the cookie — pull /me to populate UI state.
    await useAuth.getState().load();
  },
  signOut: async () => {
    try { await api.post<ApiResponse<unknown>>("/api/auth/logout", {}); } catch { /* noop */ }
    const { setMemoryToken } = await import("../api.ts");
    setMemoryToken(null);
    set({ email: "", expiresAt: null, isAuthed: false, loaded: true });
  },
  refresh: async () => {
    await useAuth.getState().load();
  },
}));

export function tokenValid(): boolean {
  return useAuth.getState().isAuthed;
}
