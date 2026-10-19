/**
 * The API preview's request model and everything about it that isn't UI:
 * keeping the URL and the params table in step, filling path values, turning
 * a request into curl / fetch() / SDK code, and exporting the instance's
 * endpoints for other HTTP clients. Pure, so it's tested on its own.
 */
import type { Method, Preset } from "./api-presets.ts";

export interface KV { key: string; value: string; on: boolean }

export type AuthMode = "none" | "admin" | "bearer" | "user";
export type BodyMode = "none" | "json" | "form";

export interface FormField { key: string; value: string; on: boolean; file?: File | null }

export interface RequestAuth {
  mode: AuthMode;
  /** For "bearer". */
  token?: string;
  /** For "user": the auth collection and email signed in with. */
  collection?: string;
  email?: string;
}

export interface ApiRequest {
  id: string;
  /** Set when saved; otherwise the tab shows method + path. */
  name?: string;
  method: Method;
  /** Path without the query string, e.g. /api/v1/posts/{id}. */
  path: string;
  params: KV[];
  /** Values for {name} segments in the path. */
  pathValues: Record<string, string>;
  headers: KV[];
  bodyMode: BodyMode;
  body: string;
  form: FormField[];
  auth: RequestAuth;
}

export function newRequest(init: Partial<ApiRequest> = {}): ApiRequest {
  return {
    id: Math.random().toString(36).slice(2, 10),
    method: "GET",
    path: "/api/health",
    params: [],
    pathValues: {},
    headers: [],
    bodyMode: "none",
    body: "",
    form: [],
    auth: { mode: "admin" },
    ...init,
  };
}

/** A request opened from an endpoint in the list. */
export function requestFromPreset(p: Preset): ApiRequest {
  const { path, params } = parseUrl(p.path);
  return newRequest({
    method: p.method,
    path,
    params,
    bodyMode: p.body !== undefined ? "json" : "none",
    body: p.body ?? "",
  });
}

// ── URL ⇄ params ────────────────────────────────────────────────────────────

const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };

/** Split what's typed in the URL bar into the path and its query params. */
export function parseUrl(url: string): { path: string; params: KV[] } {
  const q = url.indexOf("?");
  if (q < 0) return { path: url, params: [] };
  const params = url.slice(q + 1).split("&").filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    return eq < 0
      ? { key: dec(part), value: "", on: true }
      : { key: dec(part.slice(0, eq)), value: dec(part.slice(eq + 1)), on: true };
  });
  return { path: url.slice(0, q), params };
}

/** Readable query string: only what would break the URL is encoded. */
function encQuery(s: string): string {
  return s.replace(/[%&#+=?\s]/g, (c) => encodeURIComponent(c));
}

export function queryString(params: KV[]): string {
  const on = params.filter((p) => p.on && p.key);
  return on.length ? "?" + on.map((p) => `${encQuery(p.key)}=${encQuery(p.value)}`).join("&") : "";
}

/** The URL bar's text: the path as typed ({id} kept) plus the enabled params. */
export function displayUrl(r: Pick<ApiRequest, "path" | "params">): string {
  return r.path + queryString(r.params);
}

/** The URL bar was edited: take its params, keep the disabled rows. */
export function applyUrlEdit(r: ApiRequest, url: string): ApiRequest {
  const { path, params } = parseUrl(url);
  return { ...r, path, params: [...params, ...r.params.filter((p) => !p.on)] };
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!);
}

/** The URL actually requested: path values filled, params encoded. */
export function resolvedUrl(r: Pick<ApiRequest, "path" | "params" | "pathValues">): string {
  const path = r.path.replace(/\{([^}/]+)\}/g, (_, name: string) => {
    const v = r.pathValues[name];
    return v ? encodeURIComponent(v) : `{${name}}`;
  });
  return path + queryString(r.params);
}

/** Path values still empty, which would send a literal {id}. */
export function missingPathValues(r: Pick<ApiRequest, "path" | "pathValues">): string[] {
  return pathParamNames(r.path).filter((n) => !r.pathValues[n]);
}

export function hasBody(m: Method): boolean {
  return m === "POST" || m === "PATCH" || m === "PUT";
}

/** Headers sent, besides auth: enabled rows, plus JSON's Content-Type. */
export function requestHeaders(r: Pick<ApiRequest, "headers" | "bodyMode" | "method">): Record<string, string> {
  const out: Record<string, string> = {};
  if (hasBody(r.method) && r.bodyMode === "json") out["Content-Type"] = "application/json";
  for (const h of r.headers) if (h.on && h.key) out[h.key] = h.value;
  return out;
}

// ── Code snippets ───────────────────────────────────────────────────────────

const TOKEN_PLACEHOLDER = "<token>";

function authHeaderFor(r: ApiRequest): string | null {
  return r.auth.mode === "none" ? null : `Bearer ${TOKEN_PLACEHOLDER}`;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function curlSnippet(r: ApiRequest, origin: string): string {
  const lines = [`curl -X ${r.method} ${shq(origin + resolvedUrl(r))}`];
  const auth = authHeaderFor(r);
  if (auth) lines.push(`  -H ${shq(`Authorization: ${auth}`)}`);
  for (const [k, v] of Object.entries(requestHeaders(r))) lines.push(`  -H ${shq(`${k}: ${v}`)}`);
  if (hasBody(r.method) && r.bodyMode === "json" && r.body.trim()) lines.push(`  -d ${shq(r.body.trim())}`);
  if (hasBody(r.method) && r.bodyMode === "form") {
    for (const f of r.form) if (f.on && f.key) lines.push(`  -F ${shq(f.file ? `${f.key}=@${f.file.name}` : `${f.key}=${f.value}`)}`);
  }
  return lines.join(" \\\n");
}

export function fetchSnippet(r: ApiRequest, origin: string): string {
  const headers: Record<string, string> = { ...requestHeaders(r) };
  const auth = authHeaderFor(r);
  if (auth) headers["Authorization"] = auth;
  const parts = [`  method: ${JSON.stringify(r.method)},`];
  if (Object.keys(headers).length) parts.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, "\n  ")},`);
  let pre = "";
  if (hasBody(r.method) && r.bodyMode === "json" && r.body.trim()) {
    parts.push(`  body: JSON.stringify(${r.body.trim().replace(/\n/g, "\n  ")}),`);
  } else if (hasBody(r.method) && r.bodyMode === "form") {
    pre = "const form = new FormData();\n" + r.form.filter((f) => f.on && f.key)
      .map((f) => f.file ? `form.append(${JSON.stringify(f.key)}, fileInput.files[0]);` : `form.append(${JSON.stringify(f.key)}, ${JSON.stringify(f.value)});`)
      .join("\n") + "\n\n";
    parts.push("  body: form,");
  }
  return `${pre}const res = await fetch(${JSON.stringify(origin + resolvedUrl(r))}, {\n${parts.join("\n")}\n});\nconst data = await res.json();`;
}

function jsArgs(params: KV[]): string {
  const on = params.filter((p) => p.on && p.key);
  if (!on.length) return "";
  const entries = on.map((p) => {
    const v = /^\d+$/.test(p.value) ? p.value : p.value === "true" || p.value === "false" ? p.value : JSON.stringify(p.value);
    return `${/^[A-Za-z_$][\w$]*$/.test(p.key) ? p.key : JSON.stringify(p.key)}: ${v}`;
  });
  return `{ ${entries.join(", ")} }`;
}

/**
 * The same request through the Vaultbase SDK, when there's a helper for it.
 * `kinds` maps collection names to their type, to tell singletons apart.
 */
export function sdkSnippet(r: ApiRequest, origin: string, kinds: Record<string, string> = {}): string {
  const head = `import { Vaultbase } from "@vaultbase/sdk";\n\nconst vb = new Vaultbase({ baseUrl: ${JSON.stringify(origin)} });\n\n`;
  const body = hasBody(r.method) && r.bodyMode === "json" && r.body.trim() ? r.body.trim() : "{}";
  const id = (name: string) => JSON.stringify(r.pathValues[name] || `<${name}>`);
  const opts = jsArgs(r.params);
  let call: string | null = null;

  const authM = /^\/api\/v1\/auth\/([\w]+)\/(login|register|request-password-reset)$/.exec(r.path);
  const colM = /^\/api\/v1\/([\w]+)(?:\/(_aggregate|\{[^}]+\}|[^/{}]+))?$/.exec(r.path);
  if (authM && r.method === "POST") {
    const [, c, op] = authM;
    if (op === "login") call = `const { token, record } = await vb.auth.${c}.login(${body});`;
    if (op === "register") call = `const user = await vb.auth.${c}.register(${body});`;
    if (op === "request-password-reset") {
      let email = "<email>";
      try { email = (JSON.parse(body) as { email?: string }).email ?? email; } catch { /* keep the placeholder */ }
      call = `await vb.auth.${c}.requestPasswordReset(${JSON.stringify(email)});`;
    }
  } else if (colM && !["auth", "files", "admin", "collections", "custom", "batch"].includes(colM[1]!)) {
    const [, c, rest] = colM;
    const ref = kinds[c!] === "singleton" ? `vb.singleton(${JSON.stringify(c)})` : `vb.collection(${JSON.stringify(c)})`;
    const idArg = rest && rest.startsWith("{") ? id(rest.slice(1, -1)) : rest && rest !== "_aggregate" ? JSON.stringify(rest) : null;
    if (kinds[c!] === "singleton" && !rest) {
      if (r.method === "GET") call = `const record = await ${ref}.get();`;
      if (r.method === "PATCH") call = `const record = await ${ref}.update(${body});`;
    } else if (rest === "_aggregate" && r.method === "GET") {
      call = `const rows = await ${ref}.aggregate(${opts});`;
    } else if (!rest) {
      if (r.method === "GET") call = `const { data, totalItems } = await ${ref}.list(${opts});`;
      if (r.method === "POST") call = `const record = await ${ref}.create(${body});`;
    } else if (idArg) {
      if (r.method === "GET") call = `const record = await ${ref}.get(${idArg});`;
      if (r.method === "PATCH") call = `const record = await ${ref}.update(${idArg}, ${body});`;
      if (r.method === "DELETE") call = `await ${ref}.delete(${idArg});`;
    }
  } else if (r.path.startsWith("/api/v1/custom/")) {
    const m = r.method.toLowerCase();
    const sub = r.path.slice("/api/v1/custom".length);
    call = hasBody(r.method) ? `const data = await vb.custom.${m}(${JSON.stringify(sub)}, ${body});` : `const data = await vb.custom.${m}(${JSON.stringify(sub)});`;
  }
  return head + (call ?? "// The SDK has no helper for this endpoint; use fetch() instead.");
}

// ── Export for other HTTP clients ───────────────────────────────────────────

export type ExportFormat = "openapi" | "postman" | "insomnia" | "http";

export interface ExportFile { filename: string; mime: string; text: string }

const nameOf = (p: Preset) => p.summary || `${p.method} ${p.path}`;

function splitPreset(p: Preset): { path: string; params: KV[] } {
  return parseUrl(p.path);
}

/** Postman collection v2.1: folders per group, {{baseUrl}} and {{token}} variables. */
export function toPostman(presets: Preset[], baseUrl: string, title = "Vaultbase API"): string {
  const groups = new Map<string, Preset[]>();
  for (const p of presets) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const item = [...groups].map(([group, list]) => ({
    name: group,
    item: list.map((p) => {
      const { path, params } = splitPreset(p);
      const pmPath = path.replace(/\{([^}/]+)\}/g, ":$1");
      return {
        name: nameOf(p),
        request: {
          method: p.method,
          header: p.body !== undefined ? [{ key: "Content-Type", value: "application/json" }] : [],
          url: {
            raw: `{{baseUrl}}${pmPath}${queryString(params)}`,
            host: ["{{baseUrl}}"],
            path: pmPath.split("/").filter(Boolean),
            ...(params.length ? { query: params.map((q) => ({ key: q.key, value: q.value })) } : {}),
            ...(pathParamNames(path).length ? { variable: pathParamNames(path).map((key) => ({ key, value: "" })) } : {}),
          },
          ...(p.body !== undefined ? { body: { mode: "raw", raw: p.body, options: { raw: { language: "json" } } } } : {}),
        },
      };
    }),
  }));
  return JSON.stringify({
    info: { name: title, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
    variable: [{ key: "baseUrl", value: baseUrl }, { key: "token", value: "" }],
    item,
  }, null, 2);
}

/** Insomnia export format 4: a workspace, a base environment, a folder per group. */
export function toInsomnia(presets: Preset[], baseUrl: string, title = "Vaultbase API"): string {
  const resources: Array<Record<string, unknown>> = [
    { _id: "wrk_vaultbase", _type: "workspace", parentId: null, name: title, scope: "collection" },
    { _id: "env_vaultbase", _type: "environment", parentId: "wrk_vaultbase", name: "Base Environment", data: { baseUrl, token: "" } },
  ];
  const folders = new Map<string, string>();
  presets.forEach((p, i) => {
    let folder = folders.get(p.group);
    if (!folder) {
      folder = `fld_${folders.size + 1}`;
      folders.set(p.group, folder);
      resources.push({ _id: folder, _type: "request_group", parentId: "wrk_vaultbase", name: p.group });
    }
    resources.push({
      _id: `req_${i + 1}`,
      _type: "request",
      parentId: folder,
      name: nameOf(p),
      method: p.method,
      url: `{{ _.baseUrl }}${p.path}`,
      headers: p.body !== undefined ? [{ name: "Content-Type", value: "application/json" }] : [],
      body: p.body !== undefined ? { mimeType: "application/json", text: p.body } : {},
      authentication: { type: "bearer", token: "{{ _.token }}" },
    });
  });
  return JSON.stringify({ _type: "export", __export_format: 4, __export_source: "vaultbase", resources }, null, 2);
}

/** A .http file for the VS Code and JetBrains REST clients. */
export function toHttpFile(presets: Preset[], baseUrl: string): string {
  const blocks = presets.map((p) => {
    const lines = [`### ${nameOf(p)}`, `${p.method} {{baseUrl}}${p.path}`, "Authorization: Bearer {{token}}"];
    if (p.body !== undefined) lines.push("Content-Type: application/json", "", p.body);
    return lines.join("\n");
  });
  return [`@baseUrl = ${baseUrl}`, "@token = ", "", ...blocks.map((b) => b + "\n")].join("\n");
}

export function exportFile(format: Exclude<ExportFormat, "openapi">, presets: Preset[], baseUrl: string): ExportFile {
  switch (format) {
    case "postman": return { filename: "vaultbase.postman_collection.json", mime: "application/json", text: toPostman(presets, baseUrl) };
    case "insomnia": return { filename: "vaultbase.insomnia.json", mime: "application/json", text: toInsomnia(presets, baseUrl) };
    case "http": return { filename: "vaultbase.http", mime: "text/plain", text: toHttpFile(presets, baseUrl) };
  }
}

// ── History and saved requests ──────────────────────────────────────────────

/** A request as stored: no pasted token, no attached files. */
export function storableRequest(r: ApiRequest): ApiRequest {
  const { token: _token, ...auth } = r.auth;
  return { ...r, auth, form: r.form.map((f) => ({ key: f.key, value: f.value, on: f.on })) };
}

export interface HistoryEntry { at: number; status: number; req: ApiRequest }
export interface SavedRequest { name: string; req: ApiRequest }

export const HISTORY_LIMIT = 50;

/** Newest first, capped; a repeat of the latest request replaces it. */
export function pushHistory(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const key = (e: HistoryEntry) => `${e.req.method} ${resolvedUrl(e.req)} ${e.req.body}`;
  const rest = list.length && key(list[0]!) === key(entry) ? list.slice(1) : list;
  return [entry, ...rest].slice(0, HISTORY_LIMIT);
}

/** Setting holding one admin's saved requests, as JSON. */
export function savedRequestsKey(adminId: string): string {
  return `admin.api_saved.${adminId}`;
}

export function parseSaved(value: string | undefined): SavedRequest[] {
  try {
    const list = JSON.parse(value || "[]") as unknown;
    return Array.isArray(list)
      ? list.filter((s): s is SavedRequest => !!s && typeof s.name === "string" && !!s.req && typeof s.req.path === "string")
          .map((s) => ({ name: s.name, req: newRequest(s.req) }))
      : [];
  } catch { return []; }
}
