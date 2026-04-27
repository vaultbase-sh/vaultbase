import { create } from "zustand";

interface AuthState {
  token: string | null;
  email: string;
  isAuthed: boolean;
  expiresAt: number | null;
  signIn: (token: string) => void;
  signOut: () => void;
  refresh: () => void;
}

const STORAGE_KEY = "vaultbase_admin_token";

function parseJwt(token: string): { email: string; exp: number | null } | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!));
    const email = typeof payload.email === "string" ? payload.email : "";
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    return { email, exp };
  } catch {
    return null;
  }
}

function readToken(): { token: string; email: string; expiresAt: number | null } | null {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) return null;
  const parsed = parseJwt(t);
  if (!parsed) return null;
  if (parsed.exp !== null && parsed.exp * 1000 < Date.now()) {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return { token: t, email: parsed.email, expiresAt: parsed.exp };
}

export const useAuth = create<AuthState>((set) => {
  const initial = readToken();
  return {
    token: initial?.token ?? null,
    email: initial?.email ?? "",
    isAuthed: !!initial,
    expiresAt: initial?.expiresAt ?? null,
    signIn: (token: string) => {
      const parsed = parseJwt(token);
      localStorage.setItem(STORAGE_KEY, token);
      set({
        token,
        email: parsed?.email ?? "",
        expiresAt: parsed?.exp ?? null,
        isAuthed: true,
      });
    },
    signOut: () => {
      localStorage.removeItem(STORAGE_KEY);
      set({ token: null, email: "", expiresAt: null, isAuthed: false });
    },
    refresh: () => {
      const fresh = readToken();
      set({
        token: fresh?.token ?? null,
        email: fresh?.email ?? "",
        expiresAt: fresh?.expiresAt ?? null,
        isAuthed: !!fresh,
      });
    },
  };
});

export function tokenValid(): boolean {
  return useAuth.getState().isAuthed;
}
