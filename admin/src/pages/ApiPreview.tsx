import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, getMemoryToken, type ApiResponse } from "../api.ts";
import { VbBtn, VbPageHeader } from "../components/Vb.tsx";
import Icon from "../components/Icon.tsx";
import { Toggle } from "../components/UI.tsx";
import { RequestPanel, type UserSession } from "../components/api-preview/RequestPanel.tsx";
import { ResponsePanel, type ApiResponseInfo } from "../components/api-preview/ResponsePanel.tsx";
import { useAuth } from "../stores/auth.ts";
import { useCollections } from "../stores/collections.ts";
import { toast } from "../stores/toast.ts";
import {
  SYSTEM_PRESETS, groupPresets, matchesPreset, presetsFromSpec,
  type Method, type OpenApiSpec, type Preset,
} from "../lib/api-presets.ts";
import {
  applyUrlEdit, displayUrl, exportFile, hasBody, missingPathValues, newRequest, parseSaved,
  pushHistory, requestFromPreset, requestHeaders, resolvedUrl, savedRequestsKey, storableRequest,
  type ApiRequest, type HistoryEntry, type SavedRequest,
} from "../lib/api-client.ts";
import "../styles/api-preview.css";

/**
 * A small HTTP client for this instance: open several requests, edit their
 * params, headers, auth and body, send them as the admin, a user, a token or
 * nobody, and copy them as code. Endpoints come from the instance's OpenAPI
 * spec; history stays in this browser, saved requests on the server per admin.
 */

type Side = "endpoints" | "history" | "saved";

const HISTORY_KEY = "vb_api_preview_history";
const METHODS: Method[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const TEXT_TYPES = /json|text|xml|javascript|html|csv|yaml|x-www-form-urlencoded/;

function loadHistory(): HistoryEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryEntry[];
    return Array.isArray(list) ? list.map((e) => ({ ...e, req: newRequest(e.req) })) : [];
  } catch { return []; }
}

function saveHistory(list: HistoryEntry[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* storage full or blocked */ }
}

const shortPath = (p: string) => p.replace(/^\/api\/v1/, "") || "/";
const tabLabel = (r: ApiRequest) => r.name ?? shortPath(r.path);

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}

export default function ApiPreview() {
  const adminId = useAuth((s) => s.id);
  const collections = useCollections((s) => s.list);
  const loadCollections = useCollections((s) => s.load);

  // Endpoints, from the spec.
  const [specPresets, setSpecPresets] = useState<Preset[]>([]);
  const [specError, setSpecError] = useState<string | null>(null);
  const [loadingSpec, setLoadingSpec] = useState(true);
  const [specPublic, setSpecPublic] = useState(false);

  // Open requests and their responses.
  const [requests, setRequests] = useState<ApiRequest[]>(() => [newRequest()]);
  const [activeId, setActiveId] = useState(() => requests[0]!.id);
  const [responses, setResponses] = useState<Record<string, ApiResponseInfo>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [sessions, setSessions] = useState<UserSession[]>([]);

  // Left panel.
  const [side, setSide] = useState<Side>("endpoints");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [saved, setSaved] = useState<SavedRequest[]>([]);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const active = requests.find((r) => r.id === activeId) ?? requests[0]!;
  const kinds = useMemo(() => Object.fromEntries(collections.map((c) => [c.name, c.type])), [collections]);
  const authCollections = useMemo(() => collections.filter((c) => c.type === "auth").map((c) => c.name), [collections]);

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
    void loadCollections(true);
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (!res.data) return;
      setSpecPublic(res.data["api.openapi_public"] === "1");
      if (adminId) setSaved(parseSaved(res.data[savedRequestsKey(adminId)]));
    });
  }, [adminId, loadCollections]);

  // ── Open requests ─────────────────────────────────────────────────────────

  const update = (next: ApiRequest) => setRequests((rs) => rs.map((r) => (r.id === next.id ? next : r)));

  function open(req: ApiRequest) {
    // Reuse the active tab if it's an untouched blank one.
    const blank = requests.length === 1 && !responses[active.id] && active.path === "/api/health" && !active.name;
    setRequests((rs) => (blank ? [req] : [...rs, req]));
    setActiveId(req.id);
  }

  async function openPreset(p: Preset) {
    const req = requestFromPreset(p);
    open(req);
    // Fill {id} with a real record so the request works as is.
    if (p.collection && req.path.includes("{id}")) {
      const res = await api.get<ApiResponse<Array<{ id: string }>>>(`/api/v1/${p.collection}?perPage=1&skipTotal=true&fields=id`);
      const id = res.data?.[0]?.id;
      if (id) setRequests((rs) => rs.map((r) => (r.id === req.id ? { ...r, pathValues: { ...r.pathValues, id } } : r)));
    }
  }

  function close(id: string) {
    setRequests((rs) => {
      const next = rs.filter((r) => r.id !== id);
      if (next.length === 0) next.push(newRequest());
      if (id === activeId) setActiveId(next[Math.max(0, rs.findIndex((r) => r.id === id) - 1)]!.id);
      return next;
    });
    setResponses(({ [id]: _gone, ...rest }) => rest);
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  const send = useCallback(async (req: ApiRequest) => {
    const missing = missingPathValues(req);
    if (missing.length) { toast(`Fill in ${missing.map((m) => `{${m}}`).join(", ")} on the Params tab`, "info"); return; }

    const headers = new Headers(requestHeaders(req));
    let credentials: RequestCredentials = "omit";
    const { auth } = req;
    if (auth.mode === "admin") {
      credentials = "same-origin";
      const token = getMemoryToken();
      if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    } else if (auth.mode === "bearer" && auth.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${auth.token}`);
    } else if (auth.mode === "user") {
      const s = sessions.find((x) => x.collection === auth.collection && x.email === auth.email);
      if (!s) { toast("Sign in as a user on the Auth tab first", "info"); return; }
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${s.token}`);
    }

    let body: BodyInit | undefined;
    if (hasBody(req.method) && req.bodyMode === "json" && req.body.trim()) {
      try { JSON.parse(req.body); } catch (e) {
        setResponses((rs) => ({ ...rs, [req.id]: { status: 0, ms: 0, size: 0, contentType: "", body: "", binary: false, headers: [], error: `The body isn't valid JSON: ${e instanceof Error ? e.message : String(e)}` } }));
        return;
      }
      body = req.body;
    } else if (hasBody(req.method) && req.bodyMode === "form") {
      const form = new FormData();
      for (const f of req.form) if (f.on && f.key) form.append(f.key, f.file ?? f.value);
      body = form;
      headers.delete("Content-Type"); // the browser sets the multipart boundary
    }

    setSending(req.id);
    const start = performance.now();
    let info: ApiResponseInfo;
    try {
      const res = await fetch(resolvedUrl(req), { method: req.method, headers, body, credentials });
      const contentType = res.headers.get("content-type") ?? "";
      const blob = await res.blob();
      const binary = !!contentType && !TEXT_TYPES.test(contentType);
      info = {
        status: res.status,
        ms: Math.round(performance.now() - start),
        size: blob.size,
        contentType,
        body: binary ? "" : await blob.text(),
        binary,
        headers: [...res.headers.entries()],
      };
    } catch (e) {
      info = { status: 0, ms: Math.round(performance.now() - start), size: 0, contentType: "", body: "", binary: false, headers: [], error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      setSending(null);
    }
    setResponses((rs) => ({ ...rs, [req.id]: info }));
    setHistory((h) => {
      const next = pushHistory(h, { at: Date.now(), status: info.status, req: { ...storableRequest(req), id: newRequest().id } });
      saveHistory(next);
      return next;
    });
  }, [sessions]);

  // ⌘↵ / Ctrl+↵ sends the active request from anywhere on the page.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void send(activeRef.current); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  async function signIn(collection: string, email: string, password: string): Promise<string | null> {
    try {
      const res = await fetch(`/api/v1/auth/${encodeURIComponent(collection)}/login`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { token?: string; mfa_required?: boolean }; error?: string };
      if (json.data?.mfa_required) return "This user has MFA on; sign in elsewhere and paste the token under Token.";
      const token = json.data?.token;
      if (!res.ok || !token) return json.error ?? `Sign-in failed (HTTP ${res.status})`;
      setSessions((ss) => [...ss.filter((s) => !(s.collection === collection && s.email === email)), { collection, email, token }]);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  // ── Saved requests (server, per admin) ────────────────────────────────────

  async function persistSaved(next: SavedRequest[]): Promise<boolean> {
    if (!adminId) { toast("Couldn't tell which admin you are; reload and try again", "info"); return false; }
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", { [savedRequestsKey(adminId)]: JSON.stringify(next) });
    if (res.error) { toast(res.error, "info"); return false; }
    setSaved(next);
    return true;
  }

  async function saveActive(name: string) {
    const clean = name.trim();
    if (!clean) return;
    const entry: SavedRequest = { name: clean, req: { ...storableRequest(active), name: clean } };
    const next = [...saved.filter((s) => s.name !== clean), entry];
    if (await persistSaved(next)) {
      update({ ...active, name: clean });
      setSaveName(null);
      toast(`Saved "${clean}"`, "check");
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  function download(filename: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  async function exportAs(format: "openapi" | "postman" | "insomnia" | "http") {
    setExportOpen(false);
    if (format === "openapi") {
      const token = getMemoryToken();
      const r = await fetch("/api/v1/openapi.json", { credentials: "same-origin", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) { toast(`Spec download failed: ${r.status}`, "info"); return; }
      download("vaultbase-openapi.json", await r.blob());
      return;
    }
    if (!specPresets.length) { toast("The endpoints haven't loaded yet", "info"); return; }
    const f = exportFile(format, [...SYSTEM_PRESETS, ...specPresets], window.location.origin);
    download(f.filename, new Blob([f.text], { type: f.mime }));
  }

  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest(".ap-menu-wrap")) setExportOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); };
  }, [exportOpen]);

  async function toggleSpecPublic(on: boolean) {
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", { "api.openapi_public": on ? "1" : "0" });
    if (res.error) { toast(res.error, "info"); return; }
    setSpecPublic(on);
    toast(on ? "OpenAPI spec is public (admin-only collections hidden)" : "OpenAPI spec is admin-only", "check");
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const groups = useMemo(
    () => groupPresets([...SYSTEM_PRESETS, ...specPresets].filter((p) => matchesPreset(p, query))),
    [specPresets, query],
  );
  const q = query.trim().toLowerCase();
  const historyShown = history.filter((h) => !q || `${h.req.method} ${displayUrl(h.req)}`.toLowerCase().includes(q));
  const savedShown = saved.filter((s) => !q || `${s.name} ${s.req.method} ${s.req.path}`.toLowerCase().includes(q));

  return (
    <>
      <VbPageHeader
        breadcrumb={["API preview"]}
        title="API preview"
        sub="Send requests to this instance as the admin, a user, a token or nobody. Endpoints follow your collections."
        right={
          <>
            <span
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--vb-fg-3)" }}
              title="Serve /api/v1/openapi.json without an admin token. Admin-only collections are left out."
            >
              <Toggle on={specPublic} onChange={(v) => void toggleSpecPublic(v)} />
              public spec
            </span>
            <div className="ap-menu-wrap">
              <VbBtn kind="ghost" size="sm" icon="download" iconRight="chevronDown" onClick={() => setExportOpen((o) => !o)}>
                Export
              </VbBtn>
              {exportOpen && (
                <div className="ap-menu" role="menu">
                  <div className="ap-menu-label">Specification</div>
                  <button type="button" role="menuitem" onClick={() => void exportAs("openapi")}>
                    <Icon name="code" size={14} />
                    <span>OpenAPI spec<small>openapi.json, for code generators and docs</small></span>
                  </button>
                  <div className="ap-menu-sep" role="separator" />
                  <div className="ap-menu-label">HTTP clients</div>
                  <button type="button" role="menuitem" onClick={() => void exportAs("postman")}>
                    <Icon name="send" size={14} />
                    <span>Postman collection<small>v2.1, with baseUrl and token variables</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => void exportAs("insomnia")}>
                    <Icon name="layers" size={14} />
                    <span>Insomnia<small>export format 4, with a base environment</small></span>
                  </button>
                  <div className="ap-menu-sep" role="separator" />
                  <div className="ap-menu-label">Editors</div>
                  <button type="button" role="menuitem" onClick={() => void exportAs("http")}>
                    <Icon name="scroll" size={14} />
                    <span>.http file<small>for the VS Code and JetBrains REST clients</small></span>
                  </button>
                </div>
              )}
            </div>
          </>
        }
      />
      <div className="app-body ap-layout">
        {/* Left panel: endpoints, history, saved */}
        <div className="ap-panel ap-side">
          <div className="ap-side-tabs" role="tablist">
            <button type="button" role="tab" className="ap-tab" aria-selected={side === "endpoints"} onClick={() => setSide("endpoints")}>Endpoints</button>
            <button type="button" role="tab" className="ap-tab" aria-selected={side === "history"} onClick={() => setSide("history")}>
              History{history.length > 0 && <span className="ap-count">{history.length}</span>}
            </button>
            <button type="button" role="tab" className="ap-tab" aria-selected={side === "saved"} onClick={() => setSide("saved")}>
              Saved{saved.length > 0 && <span className="ap-count">{saved.length}</span>}
            </button>
          </div>
          <div className="ap-side-tools">
            <input className="input" style={{ flex: 1, height: 28, fontSize: 12 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter" />
            {side === "endpoints" && (
              <button className="btn-icon" title="Reload from the OpenAPI spec" aria-label="Reload endpoints" onClick={() => void loadSpec()} disabled={loadingSpec}>
                <Icon name="refresh" size={12} />
              </button>
            )}
            {side === "history" && history.length > 0 && (
              <button className="btn-icon" title="Clear history" aria-label="Clear history" onClick={() => { setHistory([]); saveHistory([]); }}>
                <Icon name="trash" size={12} />
              </button>
            )}
          </div>
          <div className="ap-side-list">
            {side === "endpoints" && (
              <>
                {specError && <div className="ap-empty">Couldn't load the OpenAPI spec ({specError}). Collection endpoints are missing until it loads.</div>}
                {groups.length === 0 && !loadingSpec && <div className="ap-empty">No endpoints match.</div>}
                {groups.map((g) => (
                  <div key={g.group}>
                    <div className="ap-group">{g.group}</div>
                    {g.items.map((p) => (
                      <div
                        key={`${p.method} ${p.path}`}
                        className="ap-item"
                        role="button"
                        tabIndex={0}
                        title={p.summary}
                        onClick={() => void openPreset(p)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openPreset(p); } }}
                      >
                        <span className={`badge method-${p.method.toLowerCase()}`}>{p.method}</span>
                        <span className="ap-item-path">{shortPath(p.path)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
            {side === "history" && (
              historyShown.length === 0
                ? <div className="ap-empty">{history.length ? "Nothing matches." : "Requests you send show up here. History stays in this browser."}</div>
                : historyShown.map((h, i) => (
                  <div
                    key={`${h.at}-${i}`}
                    className="ap-item"
                    role="button"
                    tabIndex={0}
                    title={displayUrl(h.req)}
                    onClick={() => open({ ...h.req, id: newRequest().id })}
                    onKeyDown={(e) => { if (e.key === "Enter") open({ ...h.req, id: newRequest().id }); }}
                  >
                    <span className={`badge method-${h.req.method.toLowerCase()}`}>{h.req.method}</span>
                    <span className="ap-item-path">{shortPath(displayUrl(h.req))}</span>
                    <span className="ap-item-meta">{h.status || "ERR"} · {ago(h.at)}</span>
                  </div>
                ))
            )}
            {side === "saved" && (
              savedShown.length === 0
                ? <div className="ap-empty">{saved.length ? "Nothing matches." : <>Save a request with <b>Save</b> next to Send. Saved requests are kept on the server, for you only.</>}</div>
                : savedShown.map((s) => (
                  <div
                    key={s.name}
                    className="ap-item"
                    role="button"
                    tabIndex={0}
                    title={`${s.req.method} ${displayUrl(s.req)}`}
                    onClick={() => open({ ...s.req, id: newRequest().id, name: s.name })}
                    onKeyDown={(e) => { if (e.key === "Enter") open({ ...s.req, id: newRequest().id, name: s.name }); }}
                  >
                    <span className={`badge method-${s.req.method.toLowerCase()}`}>{s.req.method}</span>
                    <span className="ap-item-path" style={{ fontFamily: "inherit" }}>{s.name}</span>
                    <button
                      type="button"
                      className="btn-icon ap-item-del"
                      title="Delete"
                      aria-label={`Delete ${s.name}`}
                      onClick={(e) => { e.stopPropagation(); void persistSaved(saved.filter((x) => x.name !== s.name)); }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                ))
            )}
          </div>
        </div>

        {/* Main: open requests, the request, the response */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div className="ap-reqtabs" role="tablist" aria-label="Open requests">
            {requests.map((r) => (
              <div key={r.id} className="ap-reqtab" role="tab" aria-selected={r.id === active.id} onClick={() => setActiveId(r.id)} title={`${r.method} ${displayUrl(r)}`}>
                <span className={`ap-m ap-m-${r.method.toLowerCase()}`}>{r.method}</span>
                <span className="ap-reqtab-label">{tabLabel(r)}</span>
                <button type="button" className="btn-icon" aria-label="Close" title="Close" onClick={(e) => { e.stopPropagation(); close(r.id); }}>
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
            <button type="button" className="btn-icon" title="New request" aria-label="New request" onClick={() => open(newRequest())}>
              <Icon name="plus" size={13} />
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <Dropdown
              value={active.method}
              options={METHODS}
              onChange={(e) => update({ ...active, method: e.value as Method, bodyMode: hasBody(e.value as Method) && active.bodyMode === "none" ? "json" : active.bodyMode })}
              style={{ width: 110, height: 36 }}
            />
            <input
              className="input mono"
              style={{ flex: 1, height: 36 }}
              value={displayUrl(active)}
              onChange={(e) => update(applyUrlEdit(active, e.target.value))}
              onKeyDown={(e) => { if (e.key === "Enter") void send(active); }}
              placeholder="/api/v1/posts?perPage=10"
              aria-label="URL"
              spellCheck={false}
            />
            <button className="btn btn-primary" style={{ height: 36, minWidth: 84 }} onClick={() => void send(active)} disabled={sending === active.id || !active.path.trim()} title="Send (⌘↵)">
              {sending === active.id ? <span className="spinner" /> : <Icon name="play" size={12} />}
              {sending === active.id ? "Sending…" : "Send"}
            </button>
            {saveName === null ? (
              <VbBtn kind="ghost" icon="star" onClick={() => setSaveName(active.name ?? "")} title="Save this request" style={{ height: 36 }}>
                Save
              </VbBtn>
            ) : (
              <form style={{ display: "flex", gap: 6 }} onSubmit={(e) => { e.preventDefault(); void saveActive(saveName); }}>
                <input className="input" autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name" aria-label="Saved request name" style={{ height: 36, width: 160 }} onKeyDown={(e) => { if (e.key === "Escape") setSaveName(null); }} />
                <VbBtn kind="primary" type="submit" disabled={!saveName.trim()} style={{ height: 36 }}>Save</VbBtn>
              </form>
            )}
          </div>

          <RequestPanel
            key={active.id}
            req={active}
            onChange={update}
            authCollections={authCollections}
            sessions={sessions}
            onSignIn={signIn}
          />
          <ResponsePanel key={`res-${active.id}`} req={active} res={responses[active.id] ?? null} sending={sending === active.id} kinds={kinds} />
        </div>
      </div>
    </>
  );
}
