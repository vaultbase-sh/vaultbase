const BASE = "";

const PUBLIC_PATHS = ["/api/admin/setup", "/api/admin/auth/login", "/api/auth/refresh"];

function getToken() {
  return localStorage.getItem("vaultbase_admin_token") ?? "";
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Auto-redirect to login on 401 (except for explicitly public endpoints)
  if (res.status === 401 && !PUBLIC_PATHS.some((p) => path.startsWith(p))) {
    localStorage.removeItem("vaultbase_admin_token");
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
  type: "text" | "number" | "bool" | "file" | "relation" | "select" | "autodate" | "date" | "json";
  required?: boolean;
  system?: boolean;
  options?: Record<string, unknown>;
}

export interface Collection {
  id: string;
  name: string;
  fields: string;
  list_rule: string | null;
  view_rule: string | null;
  create_rule: string | null;
  update_rule: string | null;
  delete_rule: string | null;
  created_at: number;
  updated_at: number;
}

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
