const BASE = "";

const PUBLIC_PATHS = ["/api/admin/setup", "/api/admin/auth/login", "/api/auth/refresh"];

const TOKEN_STORAGE_KEY = "vaultbase_admin_token";

/**
 * Token stored in `sessionStorage`. Survives F5 refresh within the same tab
 * but is cleared on tab close — a smaller XSS-persistence window than
 * `localStorage`. The HttpOnly cookie set by the same login response is the
 * cross-tab persistence layer; this storage is the fallback for environments
 * where the cookie can't ride (Vite dev proxy stripping Set-Cookie, etc.).
 */
export function setMemoryToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch { /* private mode, full quota — ignore */ }
}

export function getMemoryToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_STORAGE_KEY); }
  catch { return null; }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const memToken = getMemoryToken();
  if (memToken) headers.Authorization = `Bearer ${memToken}`;
  const res = await fetch(BASE + path, {
    method,
    credentials: "same-origin",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !PUBLIC_PATHS.some((p) => path.startsWith(p))) {
    setMemoryToken(null);
    if (!window.location.pathname.startsWith("/_/login") && !window.location.pathname.startsWith("/_/setup")) {
      window.location.href = "/_/login";
    }
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => req<T>("GET", path),
  post: <T>(path: string, body: unknown) => req<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => req<T>("PATCH", path, body),
  delete: <T>(path: string) => req<T>("DELETE", path),
};

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  code?: number;
  details?: Record<string, string>;
}

export interface ListResponse<T> {
  data: T[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

export interface FieldDef {
  name: string;
  type:
    | "text" | "number" | "bool" | "file" | "relation"
    | "select" | "autodate" | "date" | "json" | "email" | "url"
    | "password" | "editor" | "geoPoint";
  required?: boolean;
  system?: boolean;
  /** Auth-collection implicit field (email, verified). Storage lives on vaultbase_users. */
  implicit?: boolean;
  collection?: string;
  options?: Record<string, unknown>;
  onCreate?: boolean;
  onUpdate?: boolean;
}

export interface Collection {
  id: string;
  name: string;
  type: "base" | "auth" | "view";
  fields: string;
  view_query: string | null;
  list_rule: string | null;
  view_rule: string | null;
  create_rule: string | null;
  update_rule: string | null;
  delete_rule: string | null;
  created_at: number;
  updated_at: number;
}

export const AUTH_RESERVED_FIELD_NAMES = [
  "email",
  "password",
  "verified",
  "tokenKey",
  "password_hash",
  "email_verified",
] as const;

/** Display order matches what the schema editor renders. */
export const AUTH_IMPLICIT_FIELDS: FieldDef[] = [
  { name: "email",    type: "email", required: true, implicit: true, options: { unique: true } },
  { name: "verified", type: "bool",  required: false, implicit: true },
];

export interface RecordRow {
  id: string;
  collectionId: string;
  collectionName: string;
  created: number;
  updated: number;
  [key: string]: unknown;
}

export const COLL_COLORS = ["cyan", "teal", "amber", "rose"] as const;
export type CollColor = typeof COLL_COLORS[number];

export function collColor(index: number): CollColor {
  return COLL_COLORS[index % 4]!;
}

export function parseFields(raw: string): FieldDef[] {
  try { return JSON.parse(raw) as FieldDef[]; } catch { return []; }
}
