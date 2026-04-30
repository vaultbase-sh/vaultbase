import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, type ApiResponse, type Collection, parseFields } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import Icon from "../components/Icon.tsx";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface Preset {
  label: string;
  method: Method;
  path: string;
  body?: string;
}

interface ResponseInfo {
  status: number;
  ms: number;
  ok: boolean;
  contentType: string;
  body: string;
  headers: Record<string, string>;
}

export default function ApiPreview() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [method, setMethod] = useState<Method>("GET");
  const [path, setPath] = useState("/api/health");
  const [body, setBody] = useState("");
  const [includeAuth, setIncludeAuth] = useState(true);
  const [response, setResponse] = useState<ResponseInfo | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Collection[]>>("/api/collections").then((res) => {
      if (res.data) setCollections(res.data);
    });
  }, []);

  const presets = useMemo<Preset[]>(() => {
    const base: Preset[] = [
      { label: "GET /api/health", method: "GET", path: "/api/health" },
      { label: "GET /api/collections", method: "GET", path: "/api/collections" },
      { label: "GET /api/admin/auth/me", method: "GET", path: "/api/admin/auth/me" },
      { label: "GET /api/admin/admins", method: "GET", path: "/api/admin/admins" },
      { label: "GET /api/admin/logs?perPage=10", method: "GET", path: "/api/admin/logs?perPage=10" },
    ];
    for (const c of collections) {
      base.push({ label: `GET /api/${c.name}`, method: "GET", path: `/api/${c.name}?perPage=10` });
      const fields = parseFields(c.fields).filter((f) => !f.system && f.type !== "autodate");
      const sample: Record<string, unknown> = {};
      for (const f of fields.slice(0, 3)) {
        sample[f.name] = f.type === "number" ? 0 : f.type === "bool" ? false : "";
      }
      base.push({
        label: `POST /api/${c.name}`,
        method: "POST",
        path: `/api/${c.name}`,
        body: JSON.stringify(sample, null, 2),
      });
    }
    return base;
  }, [collections]);

  function applyPreset(p: Preset) {
    setMethod(p.method);
    setPath(p.path);
    setBody(p.body ?? "");
    setResponse(null);
  }

  async function send() {
    setSending(true);
    setResponse(null);
    const start = performance.now();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (includeAuth) {
      const token = localStorage.getItem("vaultbase_admin_token") ?? "";
      if (token) headers["Authorization"] = `Bearer ${token}`;
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
      const res = await fetch(path, { method, headers, body: parsedBody });
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
      <Topbar
        crumbs={[{ label: "API preview" }]}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => copy(buildCurl(), "curl")}>
              <Icon name="copy" size={11} /> Copy curl
            </button>
            <button className="btn btn-ghost" onClick={() => copy(buildFetch(), "fetch()")}>
              <Icon name="code" size={11} /> Copy fetch()
            </button>
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
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "0.5px solid var(--border-default)",
              fontSize: 11,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-secondary)",
            }}
          >
            Presets
          </div>
          <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
            {presets.map((p, i) => (
              <div
                key={i}
                onClick={() => applyPreset(p)}
                style={{
                  padding: "8px 14px",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  borderBottom: i < presets.length - 1 ? "0.5px solid rgba(255,255,255,0.04)" : "none",
                  color: "var(--text-secondary)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.025)"; e.currentTarget.style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary)"; }}
              >
                <span className={`badge method-${p.method.toLowerCase()}`} style={{ marginRight: 6 }}>{p.method}</span>
                {p.path.length > 24 ? p.path.slice(0, 22) + "…" : p.path}
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
              options={["GET", "POST", "PATCH", "DELETE"]}
              onChange={(e) => setMethod(e.value as Method)}
              style={{ width: 110, height: 36 }}
            />
            <input
              className="input mono"
              style={{ flex: 1, height: 36 }}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              placeholder="/api/posts?perPage=10"
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
          {(method === "POST" || method === "PATCH") && (
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
