import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Dialog } from "primereact/dialog";
import cronstrue from "cronstrue";
import { CronExpressionParser } from "cron-parser";
import { api, type ApiResponse, type Collection, type FieldDef, parseFields } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Toggle } from "../components/UI.tsx";
import { CodeEditor } from "../components/CodeEditor.tsx";
import Icon from "../components/Icon.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";

type Tab = "hooks" | "routes" | "jobs";

interface Hook {
  id: string;
  name: string;
  collection_name: string;
  event: HookEvent;
  code: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface CustomRoute {
  id: string;
  name: string;
  method: string;
  path: string;
  code: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface CronJob {
  id: string;
  name: string;
  cron: string;
  code: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const JOB_TEMPLATE = `// Cron job — runs on schedule (UTC).
// Available context:
//   ctx.helpers     — slug, abort, find, query, fetch, log, email
//   ctx.scheduledAt — unix seconds when this run was scheduled

ctx.helpers.log("Job tick at", new Date(ctx.scheduledAt * 1000).toISOString());

// Example: clean up stale records
// const stale = await ctx.helpers.query("sessions", {
//   filter: \`last_seen < \${Math.floor(Date.now() / 1000) - 86400}\`,
//   perPage: 1000,
// });
// for (const s of stale.data) {
//   // delete via API or mark inactive
// }
`;

const ROUTE_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

const ROUTE_TEMPLATE = `// Available context:
//   ctx.req         — raw Request
//   ctx.method      — "GET" | "POST" | …
//   ctx.path        — inner path after /api/custom
//   ctx.params      — { id: "..." } from :name segments
//   ctx.query       — query string params
//   ctx.body        — parsed JSON body (or text/null)
//   ctx.auth        — { id, type, email } or null
//   ctx.helpers     — slug, abort, find, query, fetch, log, email
//   ctx.set.status  — set response status
//   ctx.set.headers — set response headers

// Example: GET /users/:id/profile
const user = await ctx.helpers.find("users", ctx.params.id);
if (!user) {
  ctx.set.status = 404;
  return { error: "User not found" };
}
return { data: user };
`;

type HookEvent =
  | "beforeCreate" | "afterCreate"
  | "beforeUpdate" | "afterUpdate"
  | "beforeDelete" | "afterDelete";

const EVENTS: HookEvent[] = [
  "beforeCreate", "afterCreate",
  "beforeUpdate", "afterUpdate",
  "beforeDelete", "afterDelete",
];

const HOOK_TEMPLATE = `// Available context:
//   ctx.record    — record being processed (mutable in before* hooks)
//   ctx.existing  — existing record (only in beforeUpdate / beforeDelete)
//   ctx.auth      — { id, type, email } or null
//   ctx.helpers   — utilities:
//     .slug(s)
//     .abort(message)        // throws → 422 error
//     .find(coll, id)
//     .query(coll, { filter, sort, perPage })
//     .fetch(url, init)
//     .log(...args)
//     .email({ to, subject, body })  // pending SMTP

if (!ctx.record.slug && ctx.record.title) {
  ctx.record.slug = ctx.helpers.slug(ctx.record.title);
}
`;

export default function Hooks() {
  const [tab, setTab] = useState<Tab>("hooks");
  return (
    <>
      <Topbar
        title="Hooks"
        subtitle="Server-side JS — record events + custom HTTP routes"
      />
      <div className="tabs" style={{ paddingLeft: 20 }}>
        <div className={`tab ${tab === "hooks" ? "active" : ""}`} onClick={() => setTab("hooks")}>
          <Icon name="webhook" size={12} /> Record hooks
        </div>
        <div className={`tab ${tab === "routes" ? "active" : ""}`} onClick={() => setTab("routes")}>
          <Icon name="server" size={12} /> Custom routes
        </div>
        <div className={`tab ${tab === "jobs" ? "active" : ""}`} onClick={() => setTab("jobs")}>
          <Icon name="refresh" size={12} /> Cron jobs
        </div>
      </div>
      {tab === "hooks" && <HooksTab />}
      {tab === "routes" && <RoutesTab />}
      {tab === "jobs" && <JobsTab />}
    </>
  );
}

function HooksTab() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Hook | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setLoading(true);
    const [h, c] = await Promise.all([
      api.get<ApiResponse<Hook[]>>("/api/admin/hooks"),
      api.get<ApiResponse<Collection[]>>("/api/collections"),
    ]);
    if (h.data) setHooks(h.data);
    if (c.data) setCollections(c.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleEnabled(h: Hook) {
    const res = await api.patch<ApiResponse<Hook>>(`/api/admin/hooks/${h.id}`, {
      enabled: !h.enabled,
    });
    if (res.error) { toast(res.error, "info"); return; }
    toast(`Hook ${h.enabled ? "disabled" : "enabled"}`);
    load();
  }

  async function handleDelete(h: Hook) {
    const ok = await confirm({
      title: "Delete hook",
      message: `Delete the "${h.name || "(unnamed)"}" ${h.event} hook${h.collection_name ? ` on "${h.collection_name}"` : " (global)"}?`,
      danger: true,
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<null>>(`/api/admin/hooks/${h.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Hook deleted", "trash");
    load();
  }

  return (
    <>
      <div style={{ padding: "12px 20px 0", display: "flex", justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Icon name="plus" size={12} /> New hook
        </button>
      </div>
      <div className="app-body">
        <div className="table-wrap">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : hooks.length === 0 ? (
            <div className="empty">
              No hooks yet. Hooks run server-side JS on record events (beforeCreate, afterUpdate, etc.).
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Collection</th>
                  <th>Event</th>
                  <th>Code preview</th>
                  <th style={{ width: 80 }}>Enabled</th>
                  <th style={{ width: 90, textAlign: "right" }} />
                </tr>
              </thead>
              <tbody>
                {hooks.map((h) => (
                  <tr key={h.id}>
                    <td onClick={() => setEditing(h)} style={{ cursor: "pointer" }}>
                      {h.name ? (
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{h.name}</span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>(unnamed)</span>
                      )}
                    </td>
                    <td className="mono-cell">
                      {h.collection_name === "" ? (
                        <span className="badge auth">global</span>
                      ) : (
                        <span style={{ fontSize: 12 }}>{h.collection_name}</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${h.event.startsWith("before") ? "warning" : "success"}`}>
                        {h.event}
                      </span>
                    </td>
                    <td
                      className="mono-cell muted"
                      style={{
                        fontSize: 11,
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      onClick={() => setEditing(h)}
                    >
                      {h.code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim() ?? "(empty)"}
                    </td>
                    <td>
                      <Toggle
                        on={!!h.enabled}
                        onChange={() => toggleEnabled(h)}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className="row-actions" style={{ opacity: 1, gap: 4 }}>
                        <button className="btn-icon" onClick={() => setEditing(h)} title="Edit">
                          <Icon name="pencil" size={12} />
                        </button>
                        <button className="btn-icon danger" onClick={() => handleDelete(h)} title="Delete">
                          <Icon name="trash" size={12} />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <HookEditor
        hook={editing}
        open={!!editing}
        collections={collections}
        onClose={() => setEditing(null)}
        onSaved={() => { toast("Hook saved"); load(); }}
      />
      <HookEditor
        hook={null}
        open={showNew}
        collections={collections}
        onClose={() => setShowNew(false)}
        onSaved={() => { toast("Hook created"); load(); }}
      />
    </>
  );
}

function HookEditor({
  hook,
  open,
  collections,
  onClose,
  onSaved,
}: {
  hook: Hook | null;
  open: boolean;
  collections: Collection[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !hook;
  const [name, setName] = useState<string>("");
  const [collName, setCollName] = useState<string>("");
  const [event, setEvent] = useState<HookEvent>("beforeCreate");
  const [code, setCode] = useState<string>(HOOK_TEMPLATE);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    if (hook) {
      setName(hook.name ?? "");
      setCollName(hook.collection_name);
      setEvent(hook.event);
      setCode(hook.code);
      setEnabled(!!hook.enabled);
    } else {
      setName("");
      setCollName("");
      setEvent("beforeCreate");
      setCode(HOOK_TEMPLATE);
      setEnabled(true);
    }
    setError("");
    setSaving(false);
  }, [open, hook]);

  const collOptions = useMemo(
    () => [
      { label: "Global (all collections)", value: "" },
      ...collections.map((c) => ({ label: c.name, value: c.name })),
    ],
    [collections]
  );

  // Pull schema fields for the selected collection — drives ctx.record IntelliSense
  const fieldsForCtx: FieldDef[] = useMemo(() => {
    if (!collName) return [];
    const col = collections.find((c) => c.name === collName);
    if (!col) return [];
    try { return parseFields(col.fields); } catch { return []; }
  }, [collName, collections]);

  async function handleSave() {
    setSaving(true);
    setError("");
    const body = { name: name.trim(), collection_name: collName, event, code, enabled };
    const res = isNew
      ? await api.post<ApiResponse<Hook>>("/api/admin/hooks", body)
      : await api.patch<ApiResponse<Hook>>(`/api/admin/hooks/${hook!.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved();
    onClose();
  }

  const headerNode = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
      <span style={{ fontSize: 14, fontWeight: 600 }}>
        {isNew ? "New hook" : (name || "Edit hook")}
      </span>
      {!isNew && hook && (
        <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)", background: "rgba(255,255,255,0.05)", padding: "2px 6px", borderRadius: 4 }}>
          {hook.id.slice(0, 12)}…
        </span>
      )}
    </div>
  );

  return (
    <Dialog
      visible={open}
      onHide={onClose}
      header={headerNode}
      modal
      draggable={false}
      resizable={false}
      maximizable
      style={{ width: "92vw", height: "92vh", maxWidth: 1400 }}
      contentStyle={{ display: "flex", flexDirection: "column", padding: 0, height: "100%", background: "var(--bg-surface)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1 }}>
        {/* Top config bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 18px",
            borderBottom: "0.5px solid var(--border-default)",
            background: "var(--bg-surface)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Name</span>
            <input
              className="input"
              style={{ height: 32, width: 240, fontSize: 13 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. auto-slug-posts"
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Collection</span>
            <Dropdown
              value={collName}
              options={collOptions}
              onChange={(e) => setCollName(e.value)}
              filter
              style={{ width: 220, height: 32 }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Event</span>
            <Dropdown
              value={event}
              options={EVENTS.map((e) => ({ label: e, value: e }))}
              onChange={(e) => setEvent(e.value as HookEvent)}
              style={{ width: 180, height: 32 }}
              panelStyle={{ fontFamily: "var(--font-mono)" }}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)", marginTop: 18 }}>
            <Toggle on={enabled} onChange={setEnabled} />
            <span>Enabled</span>
          </label>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 18px", background: "rgba(248,113,113,0.1)", borderBottom: "0.5px solid rgba(248,113,113,0.3)" }}>
            {error}
          </div>
        )}

        {/* Editor takes all remaining space */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 6, background: "var(--bg-deep)" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CodeEditor
              value={code}
              onChange={setCode}
              language="javascript"
              hookContext
              hookCollectionName={collName || null}
              hookFields={fieldsForCtx}
              height="100%"
            />
          </div>
          <div className="muted" style={{ fontSize: 11, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>Type <span className="mono">ctx.</span> for autocomplete</span>
            <span>·</span>
            <span><span className="mono">ctx.helpers.abort(msg)</span> in <span className="mono">before*</span> → 422</span>
            <span>·</span>
            <span><span className="mono">after*</span> errors are logged, don't fail the request</span>
            {collName && fieldsForCtx.length > 0 && (
              <>
                <span>·</span>
                <span><span className="mono">ctx.record</span> typed as <span className="mono" style={{ color: "var(--accent-light)" }}>{collName}Record</span></span>
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ── Routes tab ──────────────────────────────────────────────────────────────

function RoutesTab() {
  const [routes, setRoutes] = useState<CustomRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CustomRoute | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setLoading(true);
    const r = await api.get<ApiResponse<CustomRoute[]>>("/api/admin/routes");
    if (r.data) setRoutes(r.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleEnabled(r: CustomRoute) {
    const res = await api.patch<ApiResponse<CustomRoute>>(`/api/admin/routes/${r.id}`, {
      enabled: !r.enabled,
    });
    if (res.error) { toast(res.error, "info"); return; }
    toast(`Route ${r.enabled ? "disabled" : "enabled"}`);
    load();
  }

  async function handleDelete(r: CustomRoute) {
    const ok = await confirm({
      title: "Delete custom route",
      message: `Delete the route ${r.method} /api/custom${r.path}?`,
      danger: true,
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<null>>(`/api/admin/routes/${r.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Route deleted", "trash");
    load();
  }

  return (
    <>
      <div style={{ padding: "12px 20px 0", display: "flex", justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Icon name="plus" size={12} /> New route
        </button>
      </div>
      <div className="app-body">
        <div className="table-wrap">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : routes.length === 0 ? (
            <div className="empty">
              No custom routes. Routes mount under <code style={{ fontFamily: "var(--font-mono)" }}>/api/custom/&lt;your-path&gt;</code>.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: 80 }}>Method</th>
                  <th>Path</th>
                  <th>Code preview</th>
                  <th style={{ width: 80 }}>Enabled</th>
                  <th style={{ width: 90, textAlign: "right" }} />
                </tr>
              </thead>
              <tbody>
                {routes.map((r) => (
                  <tr key={r.id}>
                    <td onClick={() => setEditing(r)} style={{ cursor: "pointer" }}>
                      {r.name ? (
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>(unnamed)</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge method-${r.method.toLowerCase()}`}>{r.method}</span>
                    </td>
                    <td className="mono-cell" onClick={() => setEditing(r)} style={{ cursor: "pointer" }}>
                      <span style={{ color: "var(--text-muted)" }}>/api/custom</span>
                      <span style={{ color: "var(--accent-light)" }}>{r.path}</span>
                    </td>
                    <td
                      className="mono-cell muted"
                      style={{
                        fontSize: 11,
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      onClick={() => setEditing(r)}
                    >
                      {r.code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim() ?? "(empty)"}
                    </td>
                    <td>
                      <Toggle on={!!r.enabled} onChange={() => toggleEnabled(r)} />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className="row-actions" style={{ opacity: 1, gap: 4 }}>
                        <button className="btn-icon" onClick={() => setEditing(r)} title="Edit">
                          <Icon name="pencil" size={12} />
                        </button>
                        <button className="btn-icon danger" onClick={() => handleDelete(r)} title="Delete">
                          <Icon name="trash" size={12} />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <RouteEditor
        route={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
        onSaved={() => { toast("Route saved"); load(); }}
      />
      <RouteEditor
        route={null}
        open={showNew}
        onClose={() => setShowNew(false)}
        onSaved={() => { toast("Route created"); load(); }}
      />
    </>
  );
}

function RouteEditor({
  route,
  open,
  onClose,
  onSaved,
}: {
  route: CustomRoute | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !route;
  const [name, setName] = useState("");
  const [method, setMethod] = useState<typeof ROUTE_METHODS[number]>("GET");
  const [path, setPath] = useState("");
  const [code, setCode] = useState(ROUTE_TEMPLATE);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    if (route) {
      setName(route.name ?? "");
      setMethod((route.method as typeof ROUTE_METHODS[number]) ?? "GET");
      setPath(route.path);
      setCode(route.code);
      setEnabled(!!route.enabled);
    } else {
      setName("");
      setMethod("GET");
      setPath("/");
      setCode(ROUTE_TEMPLATE);
      setEnabled(true);
    }
    setError("");
    setSaving(false);
  }, [open, route]);

  async function handleSave() {
    if (!path.trim() || !path.startsWith("/")) {
      setError("Path must start with /");
      return;
    }
    setSaving(true);
    setError("");
    const body = { name: name.trim(), method, path, code, enabled };
    const res = isNew
      ? await api.post<ApiResponse<CustomRoute>>("/api/admin/routes", body)
      : await api.patch<ApiResponse<CustomRoute>>(`/api/admin/routes/${route!.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved();
    onClose();
  }

  const headerNode = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
      <span style={{ fontSize: 14, fontWeight: 600 }}>
        {isNew ? "New route" : (name || `${method} ${path}`)}
      </span>
      {!isNew && route && (
        <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)", background: "rgba(255,255,255,0.05)", padding: "2px 6px", borderRadius: 4 }}>
          {route.id.slice(0, 12)}…
        </span>
      )}
    </div>
  );

  return (
    <Dialog
      visible={open}
      onHide={onClose}
      header={headerNode}
      modal
      draggable={false}
      resizable={false}
      maximizable
      style={{ width: "92vw", height: "92vh", maxWidth: 1400 }}
      contentStyle={{ display: "flex", flexDirection: "column", padding: 0, height: "100%", background: "var(--bg-surface)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 18px",
            borderBottom: "0.5px solid var(--border-default)",
            background: "var(--bg-surface)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Name</span>
            <input
              className="input"
              style={{ height: 32, width: 220, fontSize: 13 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. user-profile-endpoint"
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Method</span>
            <Dropdown
              value={method}
              options={ROUTE_METHODS.map((m) => ({ label: m, value: m }))}
              onChange={(e) => setMethod(e.value)}
              style={{ width: 110, height: 32 }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 240 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Path <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>(mounts under /api/custom)</span>
            </span>
            <input
              className="input mono"
              style={{ height: 32, fontSize: 12 }}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/users/:id/profile"
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)", marginTop: 18 }}>
            <Toggle on={enabled} onChange={setEnabled} />
            <span>Enabled</span>
          </label>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 18px", background: "rgba(248,113,113,0.1)", borderBottom: "0.5px solid rgba(248,113,113,0.3)" }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 6, background: "var(--bg-deep)" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CodeEditor
              value={code}
              onChange={setCode}
              language="javascript"
              routeContext
              height="100%"
            />
          </div>
          <div className="muted" style={{ fontSize: 11, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>Type <span className="mono">ctx.</span> for autocomplete</span>
            <span>·</span>
            <span>Mounts at <span className="mono" style={{ color: "var(--accent-light)" }}>{method} /api/custom{path}</span></span>
            <span>·</span>
            <span>Throw or call <span className="mono">ctx.helpers.abort(msg)</span> → 422</span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ── Cron jobs tab ───────────────────────────────────────────────────────────

function fmtRelTime(secOrNull: number | null): string {
  if (secOrNull === null) return "—";
  const diff = secOrNull - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diff);
  let unit = "s", val = abs;
  if (abs >= 86400)      { unit = "d"; val = Math.floor(abs / 86400); }
  else if (abs >= 3600)  { unit = "h"; val = Math.floor(abs / 3600); }
  else if (abs >= 60)    { unit = "m"; val = Math.floor(abs / 60); }
  return diff >= 0 ? `in ${val}${unit}` : `${val}${unit} ago`;
}

function JobsTab() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CronJob | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setLoading(true);
    const r = await api.get<ApiResponse<CronJob[]>>("/api/admin/jobs");
    if (r.data) setJobs(r.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleEnabled(j: CronJob) {
    const res = await api.patch<ApiResponse<CronJob>>(`/api/admin/jobs/${j.id}`, {
      enabled: !j.enabled,
    });
    if (res.error) { toast(res.error, "info"); return; }
    toast(`Job ${j.enabled ? "disabled" : "enabled"}`);
    load();
  }

  async function handleDelete(j: CronJob) {
    const ok = await confirm({
      title: "Delete cron job",
      message: `Delete job "${j.name || "(unnamed)"}" (${j.cron})?`,
      danger: true,
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<null>>(`/api/admin/jobs/${j.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Job deleted", "trash");
    load();
  }

  async function handleRunNow(j: CronJob) {
    const res = await api.post<ApiResponse<{ ok: boolean }>>(`/api/admin/jobs/${j.id}/run`, {});
    if (res.error) { toast(`Run failed: ${res.error}`, "info"); return; }
    toast("Job ran", "check");
    load();
  }

  return (
    <>
      <div style={{ padding: "12px 20px 0", display: "flex", justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Icon name="plus" size={12} /> New job
        </button>
      </div>
      <div className="app-body">
        <div className="table-wrap">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : jobs.length === 0 ? (
            <div className="empty">
              No cron jobs. Schedule JS code with cron expressions (UTC). Try <code style={{ fontFamily: "var(--font-mono)" }}>0 * * * *</code> for hourly.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: 130 }}>Schedule</th>
                  <th style={{ width: 110 }}>Last run</th>
                  <th style={{ width: 110 }}>Next run</th>
                  <th style={{ width: 80 }}>Status</th>
                  <th style={{ width: 80 }}>Enabled</th>
                  <th style={{ width: 130, textAlign: "right" }} />
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td onClick={() => setEditing(j)} style={{ cursor: "pointer" }}>
                      {j.name ? (
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{j.name}</span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>(unnamed)</span>
                      )}
                    </td>
                    <td className="mono-cell" style={{ fontSize: 12 }} onClick={() => setEditing(j)}>
                      {j.cron}
                    </td>
                    <td className="muted mono-cell" style={{ fontSize: 11 }}>
                      {fmtRelTime(j.last_run_at)}
                    </td>
                    <td className="mono-cell" style={{ fontSize: 11, color: "var(--accent-light)" }}>
                      {fmtRelTime(j.next_run_at)}
                    </td>
                    <td>
                      {j.last_status === "ok" ? (
                        <span className="badge success">ok</span>
                      ) : j.last_status === "error" ? (
                        <span className="badge danger" title={j.last_error ?? ""}>error</span>
                      ) : (
                        <span className="muted" style={{ fontSize: 11 }}>—</span>
                      )}
                    </td>
                    <td>
                      <Toggle on={!!j.enabled} onChange={() => toggleEnabled(j)} />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className="row-actions" style={{ opacity: 1, gap: 4 }}>
                        <button className="btn-icon" onClick={() => handleRunNow(j)} title="Run now">
                          <Icon name="play" size={11} />
                        </button>
                        <button className="btn-icon" onClick={() => setEditing(j)} title="Edit">
                          <Icon name="pencil" size={12} />
                        </button>
                        <button className="btn-icon danger" onClick={() => handleDelete(j)} title="Delete">
                          <Icon name="trash" size={12} />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <JobEditor
        job={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
        onSaved={() => { toast("Job saved"); load(); }}
      />
      <JobEditor
        job={null}
        open={showNew}
        onClose={() => setShowNew(false)}
        onSaved={() => { toast("Job created"); load(); }}
      />
    </>
  );
}

const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: "Every minute",       expr: "* * * * *" },
  { label: "Every 5 minutes",    expr: "*/5 * * * *" },
  { label: "Every hour",         expr: "0 * * * *" },
  { label: "Every day at 03:00", expr: "0 3 * * *" },
  { label: "Every Monday 09:00", expr: "0 9 * * 1" },
  { label: "First of month 00:00", expr: "0 0 1 * *" },
];

interface CronAnalysis {
  valid: boolean;
  description: string;
  nextRuns: string[];
  error: string | null;
}

function analyzeCron(expr: string): CronAnalysis {
  const trimmed = expr.trim();
  if (!trimmed) return { valid: false, description: "", nextRuns: [], error: "Empty expression" };
  let description = "";
  try {
    description = cronstrue.toString(trimmed, { use24HourTimeFormat: true, verbose: false });
  } catch (e) {
    return { valid: false, description: "", nextRuns: [], error: e instanceof Error ? e.message : "Invalid expression" };
  }
  try {
    const it = CronExpressionParser.parse(trimmed, { tz: "UTC" });
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) runs.push(it.next().toDate().toISOString().replace("T", " ").slice(0, 19) + " UTC");
    return { valid: true, description, nextRuns: runs, error: null };
  } catch (e) {
    return { valid: false, description, nextRuns: [], error: e instanceof Error ? e.message : "Invalid expression" };
  }
}

function JobEditor({
  job,
  open,
  onClose,
  onSaved,
}: {
  job: CronJob | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !job;
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [code, setCode] = useState(JOB_TEMPLATE);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cronAnalysis = useMemo(() => analyzeCron(cron), [cron]);

  useEffect(() => {
    if (!open) return;
    if (job) {
      setName(job.name ?? "");
      setCron(job.cron);
      setCode(job.code);
      setEnabled(!!job.enabled);
    } else {
      setName("");
      setCron("0 * * * *");
      setCode(JOB_TEMPLATE);
      setEnabled(true);
    }
    setError("");
    setSaving(false);
  }, [open, job]);

  async function handleSave() {
    if (!cron.trim()) { setError("Cron expression required"); return; }
    if (!cronAnalysis.valid) { setError(`Invalid cron: ${cronAnalysis.error ?? "unknown"}`); return; }
    setSaving(true);
    setError("");
    const body = { name: name.trim(), cron: cron.trim(), code, enabled };
    const res = isNew
      ? await api.post<ApiResponse<CronJob>>("/api/admin/jobs", body)
      : await api.patch<ApiResponse<CronJob>>(`/api/admin/jobs/${job!.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved();
    onClose();
  }

  const headerNode = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
      <span style={{ fontSize: 14, fontWeight: 600 }}>
        {isNew ? "New cron job" : (name || "Edit job")}
      </span>
      {!isNew && job && (
        <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)", background: "rgba(255,255,255,0.05)", padding: "2px 6px", borderRadius: 4 }}>
          {job.id.slice(0, 12)}…
        </span>
      )}
    </div>
  );

  return (
    <Dialog
      visible={open}
      onHide={onClose}
      header={headerNode}
      modal
      draggable={false}
      resizable={false}
      maximizable
      style={{ width: "92vw", height: "92vh", maxWidth: 1400 }}
      contentStyle={{ display: "flex", flexDirection: "column", padding: 0, height: "100%", background: "var(--bg-surface)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 18px",
            borderBottom: "0.5px solid var(--border-default)",
            background: "var(--bg-surface)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Name</span>
            <input
              className="input"
              style={{ height: 32, width: 220, fontSize: 13 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. nightly-cleanup"
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 220 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Cron expression <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>(UTC)</span>
            </span>
            <input
              className="input mono"
              style={{
                height: 32,
                fontSize: 12,
                borderColor: cron.trim() === "" ? undefined : (cronAnalysis.valid ? "var(--success)" : "var(--danger)"),
              }}
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 3 * * *"
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Preset</span>
            <Dropdown
              value={null}
              options={CRON_PRESETS.map((p) => ({ label: p.label, value: p.expr }))}
              onChange={(e) => setCron(e.value)}
              placeholder="—"
              style={{ width: 180, height: 32 }}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)", marginTop: 18 }}>
            <Toggle on={enabled} onChange={setEnabled} />
            <span>Enabled</span>
          </label>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 18px", background: "rgba(248,113,113,0.1)", borderBottom: "0.5px solid rgba(248,113,113,0.3)" }}>
            {error}
          </div>
        )}

        {/* Cron interpretation panel */}
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            gap: 0,
            padding: "10px 18px",
            borderBottom: "0.5px solid var(--border-default)",
            background: "rgba(255,255,255,0.015)",
            fontSize: 12,
          }}
        >
          {cronAnalysis.valid ? (
            <>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, paddingRight: 16, borderRight: "0.5px solid var(--border-default)" }}>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Schedule (cronstrue)
                </span>
                <span style={{ color: "var(--accent-light)" }}>{cronAnalysis.description}</span>
              </div>
              <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 4, paddingLeft: 16 }}>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Next 5 runs
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                  {cronAnalysis.nextRuns.map((r, i) => (
                    <span key={i}>{r}</span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--danger)" }}>
              <Icon name="alert" size={12} />
              <span>{cronAnalysis.error ?? "Invalid cron expression"}</span>
            </div>
          )}
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 6, background: "var(--bg-deep)" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CodeEditor
              value={code}
              onChange={setCode}
              language="javascript"
              jobContext
              height="100%"
            />
          </div>
          <div className="muted" style={{ fontSize: 11, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>Cron format: <span className="mono">min hour dom mon dow</span></span>
            <span>·</span>
            <span>Scheduler ticks every 30s</span>
            <span>·</span>
            <span>Errors logged to <span className="mono">last_error</span></span>
            <span>·</span>
            <a href="https://crontab.guru/" target="_blank" rel="noreferrer" style={{ color: "var(--accent-light)" }}>crontab.guru</a>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
