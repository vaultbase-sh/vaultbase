import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, getMemoryToken, type ApiResponse } from "../api.ts";
import { VbBtn, VbPageHeader } from "../components/Vb.tsx";
import Icon from "../components/Icon.tsx";
import { Toggle } from "../components/UI.tsx";
import {
  SYSTEM_PRESETS, groupPresets, matchesPreset, presetsFromSpec,
  type Method, type OpenApiSpec, type Preset,
} from "../lib/api-presets.ts";

interface ResponseInfo {
  status: number;
  ms: number;
  ok: boolean;
  contentType: string;
  body: string;
  headers: Record<string, string>;
}

export default function ApiPreview() {
  const [specPresets, setSpecPresets] = useState<Preset[]>([]);
  const [specError, setSpecError] = useState<string | null>(null);
  const [loadingSpec, setLoadingSpec] = useState(true);
  const [query, setQuery] = useState("");
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [method, setMethod] = useState<Method>("GET");
  const [path, setPath] = useState("/api/health");
  const [body, setBody] = useState("");
  const [includeAuth, setIncludeAuth] = useState(true);
  const [response, setResponse] = useState<ResponseInfo | null>(null);
  const [sending, setSending] = useState(false);
  const [specPublic, setSpecPublic] = useState(false);

  // Endpoints come from the instance's own OpenAPI spec, so they follow the
  // live collections (see lib/api-presets.ts).
  async function loadSpec() {
    setLoadingSpec(true);
    const token = getMemoryToken();
    try {
      const r = await fetch("/api/v1/openapi.json", { credentials: "same-origin", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSpecPresets(presetsFromSpec((await r.json()) as OpenApiSpec));
      setSpecError(null);
    } catch (e) {
      setSpecError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSpec(false);
    }
  }

  useEffect(() => {
    void loadSpec();
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) setSpecPublic(res.data["api.openapi_public"] === "1");
    });
  }, []);

  async function downloadSpec() {
    const token = getMemoryToken();
    const r = await fetch("/api/v1/openapi.json", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const { toast } = await import("../stores/toast.ts");
    if (!r.ok) { toast(`Spec download failed: ${r.status}`, "info"); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url; a.download = "vaultbase-openapi.json"; a.click();
    URL.revokeObjectURL(url);
  }

  async function toggleSpecPublic(on: boolean) {
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", { "api.openapi_public": on ? "1" : "0" });
    const { toast } = await import("../stores/toast.ts");
    if (res.error) { toast(res.error, "info"); return; }
    setSpecPublic(on);
    toast(on ? "OpenAPI spec is public (admin-only collections hidden)" : "OpenAPI spec is admin-only", "check");
  }

  const groups = useMemo(
    () => groupPresets([...SYSTEM_PRESETS, ...specPresets].filter((p) => matchesPreset(p, query))),
    [specPresets, query],
  );

  async function applyPreset(p: Preset) {
    setActivePreset(p);
    setMethod(p.method);
    setBody(p.body ?? "");
    setResponse(null);
    // Fill {id} with a real record so the request works as is.
    let next = p.path;
    if (p.collection && next.includes("{id}")) {
      const res = await api.get<ApiResponse<Array<{ id: string }>>>(`/api/v1/${p.collection}?perPage=1&skipTotal=true&fields=id`);
      const id = res.data?.[0]?.id;
      if (id) next = next.replace("{id}", encodeURIComponent(id));
    }
    setPath(next);
  }

  async function send() {
    setSending(true);
    setResponse(null);
    const start = performance.now();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (includeAuth) {
      const token = getMemoryToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      // Cookie auth is the primary mechanism — added below via credentials.
    }

    let parsedBody: string | undefined;
    if (method !== "GET" && method !== "DELETE" && body.trim()) {
      try {
        // Validate but send as-is (preserves formatting)
        JSON.parse(body);
        parsedBody = body;
      } catch (e) {
        setSending(false);
        setResponse({
          status: 0, ms: 0, ok: false, contentType: "",
          body: `Invalid JSON body: ${e instanceof Error ? e.message : String(e)}`,
          headers: {},
        });
        return;
      }
    }

    try {
      const res = await fetch(path, {
        method,
        credentials: includeAuth ? "same-origin" : "omit",
        headers,
        body: parsedBody,
      });
      const ms = Math.round(performance.now() - start);
      const text = await res.text();
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      setResponse({
        status: res.status,
        ms,
        ok: res.ok,
        contentType: res.headers.get("content-type") ?? "",
        body: text,
        headers: respHeaders,
      });
    } catch (e) {
      const ms = Math.round(performance.now() - start);
      setResponse({
        status: 0, ms, ok: false, contentType: "",
        body: `Network error: ${e instanceof Error ? e.message : String(e)}`,
        headers: {},
      });
    } finally {
      setSending(false);
    }
  }

  function buildCurl(): string {
    const url = path.startsWith("http") ? path : `${window.location.origin}${path}`;
    const lines = [`curl -X ${method} \\`, `  '${url}'`];
    if (includeAuth) lines.push(`  -H 'Authorization: Bearer <admin-token>' \\`);
    if (method !== "GET" && method !== "DELETE" && body.trim()) {
      lines.push(`  -H 'Content-Type: application/json' \\`);
      lines.push(`  -d ${JSON.stringify(body)}`);
    }
    return lines.join("\n");
  }

  function buildFetch(): string {
    const url = path.startsWith("http") ? path : path;
    const headers: Record<string, string> = {};
    if (includeAuth) headers["Authorization"] = "Bearer <admin-token>";
    if (method !== "GET" && method !== "DELETE" && body.trim()) headers["Content-Type"] = "application/json";
    const init: Record<string, unknown> = { method };
    if (Object.keys(headers).length) init.headers = headers;
    if (method !== "GET" && method !== "DELETE" && body.trim()) {
      init.body = body;
    }
    return `await fetch(${JSON.stringify(url)}, ${JSON.stringify(init, null, 2)});`;
  }

  function copy(text: string, label: string): void {
    void navigator.clipboard.writeText(text);
    void import("../stores/toast.ts").then((m) => m.toast(`${label} copied`, "check"));
  }

  function formatBody(text: string, contentType: string): string {
    if (contentType.includes("application/json")) {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* fall through */ }
    }
    return text;
  }

  const statusClass = (s: number) =>
    s === 0 ? "status-5xx" : s < 300 ? "status-2xx" : s < 400 ? "status-3xx" : s < 500 ? "status-4xx" : "status-5xx";

  return (
    <>
      <VbPageHeader
        breadcrumb={["API preview"]}
        title="API preview"
        sub="Try any REST endpoint live against this instance. Pick a preset or build a request — see the response, copy as curl or fetch()."
        right={
          <>
            <span
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--vb-fg-3)" }}
              title="Serve /api/v1/openapi.json without an admin token. Admin-only collections are left out."
            >
              <Toggle on={specPublic} onChange={(v) => void toggleSpecPublic(v)} />
              public spec
            </span>
            <VbBtn kind="ghost" size="sm" icon="download" onClick={() => void downloadSpec()}>
              OpenAPI spec
            </VbBtn>
            <VbBtn kind="ghost" size="sm" icon="copy" onClick={() => copy(buildCurl(), "curl")}>
              Copy curl
            </VbBtn>
            <VbBtn kind="ghost" size="sm" icon="copy" onClick={() => copy(buildFetch(), "fetch()")}>
              Copy fetch()
            </VbBtn>
          </>
        }
      />
      <div className="app-body" style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 16, alignItems: "start" }}>
        {/* Presets sidebar */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "0.5px solid var(--border-default)",
            borderRadius: 10,
            overflow: "hidden",
            position: "sticky",
            top: 0,
          }}
        >
          <div style={{ padding: 8, borderBottom: "0.5px solid var(--border-default)", display: "flex", gap: 6 }}>
            <input
              className="input"
              style={{ flex: 1, height: 28, fontSize: 12 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter endpoints"
              aria-label="Filter endpoints"
            />
            <button className="btn-icon" title="Reload from the OpenAPI spec" onClick={() => void loadSpec()} disabled={loadingSpec}>
              <Icon name="refresh" size={12} />
            </button>
          </div>
          <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
            {specError && (
              <div style={{ padding: "8px 14px", fontSize: 11.5, color: "var(--text-secondary)" }}>
                Couldn't load the OpenAPI spec ({specError}). Collection endpoints are missing until it loads.
              </div>
            )}
            {groups.length === 0 && !loadingSpec && (
              <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-secondary)" }}>No endpoints match.</div>
            )}
            {groups.map((g) => (
              <div key={g.group}>
                <div
                  style={{
                    padding: "10px 14px 4px",
                    fontSize: 10.5,
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--text-secondary)",
                  }}
                >
                  {g.group}
                </div>
                {g.items.map((p) => {
                  const active = activePreset === p;
                  return (
                    <div
                      key={`${p.method} ${p.path}`}
                      role="button"
                      tabIndex={0}
                      title={p.summary}
                      onClick={() => void applyPreset(p)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void applyPreset(p); } }}
                      className="api-preset"
                      data-active={active ? "true" : undefined}
                      style={{
                        padding: "6px 14px",
                        fontSize: 11.5,
                        fontFamily: "var(--font-mono)",
                        cursor: "pointer",
                        display: "flex",
                        gap: 6,
                        alignItems: "baseline",
                        color: active ? "var(--text-primary)" : "var(--text-secondary)",
                        background: active ? "rgba(255,255,255,0.04)" : "transparent",
                      }}
                    >
                      <span className={`badge method-${p.method.toLowerCase()}`} style={{ flexShrink: 0 }}>{p.method}</span>
                      <span style={{ wordBreak: "break-all" }}>{p.path.replace(/^\/api\/v1/, "")}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Main panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Request line */}
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <Dropdown
              value={method}
              options={["GET", "POST", "PATCH", "PUT", "DELETE"]}
              onChange={(e) => setMethod(e.value as Method)}
              style={{ width: 110, height: 36 }}
            />
            <input
              className="input mono"
              style={{ flex: 1, height: 36 }}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              placeholder="/api/v1/posts?perPage=10"
            />
            <button
              className="btn btn-primary"
              style={{ height: 36, minWidth: 80 }}
              onClick={send}
              disabled={sending || !path.trim()}
            >
              {sending ? <span className="spinner" /> : <Icon name="play" size={12} />}
              {sending ? "Sending…" : "Send"}
            </button>
          </div>

          {/* Auth toggle */}
          <label
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)", userSelect: "none" }}
          >
            <input
              type="checkbox"
              checked={includeAuth}
              onChange={(e) => setIncludeAuth(e.target.checked)}
            />
            <span>Include admin token in <code style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>Authorization</code> header</span>
          </label>

          {/* Body */}
          {(method === "POST" || method === "PATCH" || method === "PUT") && (
            <div>
              <label className="label">Request body (JSON)</label>
              <textarea
                className="input mono"
                style={{ width: "100%", height: 140, padding: 10, fontSize: 12, lineHeight: 1.55, resize: "vertical" }}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder='{ "title": "hello" }'
                spellCheck={false}
              />
            </div>
          )}

          {/* Response */}
          {response && (
            <div
              style={{
                background: "var(--bg-surface)",
                border: "0.5px solid var(--border-default)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "10px 14px",
                  borderBottom: "0.5px solid var(--border-default)",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  fontSize: 12,
                  background: "rgba(255,255,255,0.015)",
                }}
              >
                <span className={`badge ${response.status === 0 ? "danger" : response.status < 300 ? "success" : response.status < 400 ? "info" : response.status < 500 ? "warning" : "danger"}`} style={{ fontSize: 11 }}>
                  {response.status === 0 ? "ERR" : response.status}
                </span>
                <span className="muted mono" style={{ fontSize: 11 }}>{response.ms}ms</span>
                {response.contentType && (
                  <span className="muted mono" style={{ fontSize: 11 }}>{response.contentType.split(";")[0]}</span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  className="btn-icon"
                  title="Copy response body"
                  onClick={() => navigator.clipboard.writeText(response.body)}
                >
                  <Icon name="copy" size={12} />
                </button>
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: "12px 14px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: "var(--text-primary)",
                  background: "var(--bg-deep)",
                  maxHeight: 480,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {formatBody(response.body, response.contentType) || "(empty)"}
              </pre>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
