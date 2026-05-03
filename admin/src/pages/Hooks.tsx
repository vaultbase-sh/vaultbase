import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Dialog } from "primereact/dialog";
import cronstrue from "cronstrue";
import { CronExpressionParser } from "cron-parser";
import { api, type ApiResponse, type Collection, type FieldDef, parseFields } from "../api.ts";
import {
  VbPageHeader, VbTabs, type VbTab,
  VbBtn, VbInput, VbField, VbPill, VbTable, VbEmptyState,
  type VbTableColumn,
} from "../components/Vb.tsx";
import { Toggle } from "../components/UI.tsx";
import { CodeEditor } from "../components/CodeEditor.tsx";
import Icon from "../components/Icon.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";

type Tab = "hooks" | "routes" | "jobs" | "workers" | "joblog";

interface Worker {
  id: string;
  name: string;
  queue: string;
  code: string;
  enabled: number;
  concurrency: number;
  retry_max: number;
  retry_backoff: "exponential" | "fixed";
  retry_delay_ms: number;
  created_at: number;
  updated_at: number;
}

type JobLogStatus = "queued" | "running" | "succeeded" | "failed" | "dead";

interface JobLogRow {
  id: string;
  queue: string;
  worker_id: string | null;
  payload: string;
  unique_key: string | null;
  attempt: number;
  status: JobLogStatus;
  error: string | null;
  scheduled_at: number;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface QueueStat {
  queue: string;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
}

const WORKER_TEMPLATE = `// Worker — processes jobs from a named queue.
// Available context:
//   ctx.payload  — the enqueued payload (JSON-decoded)
//   ctx.attempt  — 1-indexed attempt (incremented on retry)
//   ctx.queue    — queue name
//   ctx.jobId    — job id (vaultbase_jobs_log row)
//   ctx.helpers  — slug, abort, find, query, fetch, log, email, enqueue,
//                  recordRule

ctx.helpers.log("processing", ctx.queue, "job", ctx.jobId, "attempt", ctx.attempt);

// Throw to fail (worker will retry per retry_max + backoff). Return any value
// to mark the job succeeded.
return { ok: true };
`;

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
  /** "inline" or "worker:<queue>" */
  mode: string;
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
//   ctx.path        — inner path after /api/v1/custom
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

const HOOKS_TABS: VbTab<Tab>[] = [
  { id: "hooks",   label: "Record hooks",  icon: "webhook" },
  { id: "routes",  label: "Custom routes", icon: "play" },
  { id: "jobs",    label: "Cron jobs",     icon: "refresh" },
  { id: "workers", label: "Workers",       icon: "zap" },
  { id: "joblog",  label: "Jobs log",      icon: "scroll" },
];

export default function Hooks() {
  const [tab, setTab] = useState<Tab>("hooks");
  return (
    <>
      <VbPageHeader
        breadcrumb={["Hooks"]}
        title="Hooks"
        sub="Server-side JS — record events, custom HTTP routes, cron jobs, queue workers."
      />
      <VbTabs<Tab> tabs={HOOKS_TABS} active={tab} onChange={setTab} />
      {tab === "hooks" && <HooksTab />}
      {tab === "routes" && <RoutesTab />}
      {tab === "jobs" && <JobsTab />}
      {tab === "workers" && <WorkersTab />}
      {tab === "joblog" && <JobsLogTab />}
    </>
  );
}

// ── Shared row-action button cluster ────────────────────────────────────────
function RowActions({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{ display: "inline-flex", gap: 4, justifyContent: "flex-end" }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </span>
  );
}

function NameCell({ name }: { name: string }) {
  return name ? (
    <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--vb-fg)" }}>{name}</span>
  ) : (
    <span style={{ fontSize: 11.5, color: "var(--vb-fg-3)", fontStyle: "italic" }}>(unnamed)</span>
  );
}

function CodePreview({ code }: { code: string }) {
  const line = code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim() ?? "(empty)";
  return (
    <span style={{
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--vb-fg-3)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    }}>{line}</span>
  );
}

// ── Hooks tab ───────────────────────────────────────────────────────────────

function HooksTab() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Hook | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setLoading(true);
    const [h, c] = await Promise.all([
      api.get<ApiResponse<Hook[]>>("/api/v1/admin/hooks"),
      api.get<ApiResponse<Collection[]>>("/api/v1/collections"),
    ]);
    if (h.data) setHooks(h.data);
    if (c.data) setCollections(c.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleEnabled(h: Hook) {
    const res = await api.patch<ApiResponse<Hook>>(`/api/v1/admin/hooks/${h.id}`, {
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
    const res = await api.delete<ApiResponse<null>>(`/api/v1/admin/hooks/${h.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Hook deleted", "trash");
    load();
  }

  const columns: VbTableColumn<Hook>[] = [
    { key: "name", label: "Name", flex: 1.2, render: (h) => <NameCell name={h.name} /> },
    { key: "collection", label: "Collection", flex: 1, render: (h) => (
      h.collection_name === ""
        ? <VbPill tone="accent">global</VbPill>
        : <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{h.collection_name}</span>
    )},
    { key: "event", label: "Event", width: 130, render: (h) => (
      <VbPill tone={h.event.startsWith("before") ? "warning" : "success"}>{h.event}</VbPill>
    )},
    { key: "code", label: "Code preview", flex: 2, render: (h) => <CodePreview code={h.code} /> },
    { key: "enabled", label: "On", width: 70, align: "center", render: (h) => (
      <span onClick={(e) => e.stopPropagation()}>
        <Toggle on={!!h.enabled} onChange={() => toggleEnabled(h)} />
      </span>
    )},
    { key: "actions", label: "", width: 88, align: "right", render: (h) => (
      <RowActions>
        <VbBtn kind="ghost" size="sm" icon="pencil" onClick={() => setEditing(h)} title="Edit" />
        <VbBtn kind="danger" size="sm" icon="trash" onClick={() => handleDelete(h)} title="Delete" />
      </RowActions>
    )},
  ];

  return (
    <>
      <div style={{ padding: "14px 28px 0", display: "flex", justifyContent: "flex-end" }}>
        <VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>New hook</VbBtn>
      </div>
      <div className="app-body">
        <VbTable<Hook>
          rows={hooks}
          columns={columns}
          rowKey={(h) => h.id}
          loading={loading}
          onRowClick={setEditing}
          emptyState={
            <VbEmptyState
              icon="webhook"
              title="No record hooks yet"
              body="Hooks run server-side JS on record events — beforeCreate, afterUpdate, etc."
              actions={<VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>New hook</VbBtn>}
            />
          }
        />
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

function EditorHeader({
  title, idHint,
}: { title: string; idHint?: string | null }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--vb-fg)" }}>{title}</span>
      {idHint && (
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--vb-fg-3)",
          background: "var(--vb-bg-3)",
          padding: "2px 6px",
          borderRadius: 4,
        }}>{idHint}</span>
      )}
    </div>
  );
}

function EditorErrorBar({ message }: { message: string }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      color: "var(--vb-status-danger)",
      fontSize: 12,
      padding: "8px 18px",
      background: "var(--vb-status-danger-bg)",
      borderBottom: "1px solid rgba(232,90,79,0.3)",
    }}>
      <Icon name="alert" size={12} />
      <span>{message}</span>
    </div>
  );
}

function EditorFootnote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11,
      color: "var(--vb-fg-3)",
      display: "flex",
      gap: 14,
      flexWrap: "wrap",
      alignItems: "center",
    }}>
      {children}
    </div>
  );
}

function ToggleField({ on, onChange, label = "Enabled" }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 12,
      color: "var(--vb-fg-2)",
      marginTop: 18,
      cursor: "pointer",
    }}>
      <Toggle on={on} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

const EDITOR_DIALOG_STYLE: React.CSSProperties = { width: "92vw", height: "92vh", maxWidth: 1400 };
const EDITOR_CONTENT_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: 0,
  height: "100%",
  background: "var(--vb-bg-2)",
};

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
      ? await api.post<ApiResponse<Hook>>("/api/v1/admin/hooks", body)
      : await api.patch<ApiResponse<Hook>>(`/api/v1/admin/hooks/${hook!.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved();
    onClose();
  }

  return (
    <Dialog
      visible={open}
      onHide={onClose}
      header={<EditorHeader title={isNew ? "New hook" : (name || "Edit hook")} idHint={hook ? `${hook.id.slice(0, 12)}…` : null} />}
      modal
      draggable={false}
      resizable={false}
      maximizable
      style={EDITOR_DIALOG_STYLE}
      contentStyle={EDITOR_CONTENT_STYLE}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1 }}>
        <div style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 14,
          padding: "14px 18px",
          borderBottom: "1px solid var(--vb-border)",
          background: "var(--vb-bg-2)",
          flexWrap: "wrap",
        }}>
          <div style={{ width: 240 }}>
            <VbField label="Name">
              <VbInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. auto-slug-posts" />
            </VbField>
          </div>
          <div style={{ width: 220 }}>
            <VbField label="Collection">
              <Dropdown
                value={collName}
                options={collOptions}
                onChange={(e) => setCollName(e.value)}
                filter
                style={{ width: "100%", height: 32 }}
              />
            </VbField>
          </div>
          <div style={{ width: 180 }}>
            <VbField label="Event">
              <Dropdown
                value={event}
                options={EVENTS.map((e) => ({ label: e, value: e }))}
                onChange={(e) => setEvent(e.value as HookEvent)}
                style={{ width: "100%", height: 32 }}
                panelStyle={{ fontFamily: "var(--font-mono)" }}
              />
            </VbField>
          </div>
          <ToggleField on={enabled} onChange={setEnabled} />
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <VbBtn kind="ghost" size="sm" onClick={onClose}>Cancel</VbBtn>
            <VbBtn kind="primary" size="sm" icon="check" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </VbBtn>
          </div>
        </div>

        {error && <EditorErrorBar message={error} />}

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 8, background: "var(--vb-bg-1)" }}>
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
          <EditorFootnote>
            <span>Type <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>ctx.</span> for autocomplete</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>ctx.helpers.abort(msg)</span>
              {" "}in{" "}
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>before*</span>
              {" "}→ 422
            </span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>after*</span>
              {" "}errors are logged, don't fail the request
            </span>
            {collName && fieldsForCtx.length > 0 && (
              <>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>ctx.record</span>
                  {" "}typed as{" "}
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-accent)" }}>{collName}Record</span>
                </span>
              </>
            )}
          </EditorFootnote>
        </div>
      </div>
    </Dialog>
  );
}

// ── Routes tab ──────────────────────────────────────────────────────────────

function methodTone(method: string): "success" | "warning" | "danger" | "accent" | "neutral" {
  switch (method.toUpperCase()) {
    case "GET":    return "success";
    case "POST":   return "accent";
    case "PATCH":
    case "PUT":    return "warning";
    case "DELETE": return "danger";
    default:       return "neutral";
  }
}

function RoutesTab() {
  const [routes, setRoutes] = useState<CustomRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CustomRoute | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setLoading(true);
    const r = await api.get<ApiResponse<CustomRoute[]>>("/api/v1/admin/routes");
    if (r.data) setRoutes(r.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleEnabled(r: CustomRoute) {
    const res = await api.patch<ApiResponse<CustomRoute>>(`/api/v1/admin/routes/${r.id}`, {
      enabled: !r.enabled,
    });
    if (res.error) { toast(res.error, "info"); return; }
    toast(`Route ${r.enabled ? "disabled" : "enabled"}`);
    load();
  }

  async function handleDelete(r: CustomRoute) {
    const ok = await confirm({
      title: "Delete custom route",
      message: `Delete the route ${r.method} /api/v1/custom${r.path}?`,
      danger: true,
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<null>>(`/api/v1/admin/routes/${r.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Route deleted", "trash");
    load();
  }

  const columns: VbTableColumn<CustomRoute>[] = [
    { key: "name", label: "Name", flex: 1.2, render: (r) => <NameCell name={r.name} /> },
    { key: "method", label: "Method", width: 90, render: (r) => <VbPill tone={methodTone(r.method)}>{r.method}</VbPill> },
    { key: "path", label: "Path", flex: 1.5, render: (r) => (
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
        <span style={{ color: "var(--vb-fg-3)" }}>/api/v1/custom</span>
        <span style={{ color: "var(--vb-accent)" }}>{r.path}</span>
      </span>
    )},
    { key: "code", label: "Code preview", flex: 2, render: (r) => <CodePreview code={r.code} /> },
    { key: "enabled", label: "On", width: 70, align: "center", render: (r) => (
      <span onClick={(e) => e.stopPropagation()}>
        <Toggle on={!!r.enabled} onChange={() => toggleEnabled(r)} />
      </span>
    )},
    { key: "actions", label: "", width: 88, align: "right", render: (r) => (
      <RowActions>
        <VbBtn kind="ghost" size="sm" icon="pencil" onClick={() => setEditing(r)} title="Edit" />
        <VbBtn kind="danger" size="sm" icon="trash" onClick={() => handleDelete(r)} title="Delete" />
      </RowActions>
    )},
  ];

  return (
    <>
      <div style={{ padding: "14px 28px 0", display: "flex", justifyContent: "flex-end" }}>
        <VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>New route</VbBtn>
      </div>
      <div className="app-body">
        <VbTable<CustomRoute>
          rows={routes}
          columns={columns}
          rowKey={(r) => r.id}
          loading={loading}
          onRowClick={setEditing}
          emptyState={
            <VbEmptyState
              icon="play"
              title="No custom routes"
              body={<>Routes mount under <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>/api/v1/custom/&lt;your-path&gt;</span>.</>}
              actions={<VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>New route</VbBtn>}
            />
          }
        />
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
      ? await api.post<ApiResponse<CustomRoute>>("/api/v1/admin/routes", body)
      : await api.patch<ApiResponse<CustomRoute>>(`/api/v1/admin/routes/${route!.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved();
    onClose();
  }

  return (
    <Dialog
      visible={open}
      onHide={onClose}
      header={<EditorHeader title={isNew ? "New route" : (name || `${method} ${path}`)} idHint={route ? `${route.id.slice(0, 12)}…` : null} />}
      modal
      draggable={false}
      resizable={false}
      maximizable
      style={EDITOR_DIALOG_STYLE}
      contentStyle={EDITOR_CONTENT_STYLE}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1 }}>
        <div style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 14,
          padding: "14px 18px",
          borderBottom: "1px solid var(--vb-border)",
          background: "var(--vb-bg-2)",
          flexWrap: "wrap",
        }}>
          <div style={{ width: 220 }}>
            <VbField label="Name">
              <VbInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. user-profile-endpoint" />
            </VbField>
          </div>
          <div style={{ width: 110 }}>
            <VbField label="Method">
              <Dropdown
                value={method}
                options={ROUTE_METHODS.map((m) => ({ label: m, value: m }))}
                onChange={(e) => setMethod(e.value)}
                style={{ width: "100%", height: 32 }}
              />
            </VbField>
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <VbField label="Path" hint="mounts under /api/v1/custom">
              <VbInput mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="/users/:id/profile" />
            </VbField>
          </div>
          <ToggleField on={enabled} onChange={setEnabled} />
          <div style={{ display: "flex", gap: 8 }}>
            <VbBtn kind="ghost" size="sm" onClick={onClose}>Cancel</VbBtn>
            <VbBtn kind="primary" size="sm" icon="check" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </VbBtn>
          </div>
        </div>

        {error && <EditorErrorBar message={error} />}

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 8, background: "var(--vb-bg-1)" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CodeEditor
              value={code}
              onChange={setCode}
              language="javascript"
              routeContext
              height="100%"
            />
          </div>
          <EditorFootnote>
            <span>Type <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>ctx.</span> for autocomplete</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>
              Mounts at{" "}
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-accent)" }}>{method} /api/v1/custom{path}</span>
            </span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>
              Throw or call{" "}
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>ctx.helpers.abort(msg)</span>
              {" "}→ 422
            </span>
          </EditorFootnote>
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
    const r = await api.get<ApiResponse<CronJob[]>>("/api/v1/admin/jobs");
    if (r.data) setJobs(r.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleEnabled(j: CronJob) {
    const res = await api.patch<ApiResponse<CronJob>>(`/api/v1/admin/jobs/${j.id}`, {
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
    const res = await api.delete<ApiResponse<null>>(`/api/v1/admin/jobs/${j.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Job deleted", "trash");
    load();
  }

  async function handleRunNow(j: CronJob) {
    const res = await api.post<ApiResponse<{ ok: boolean }>>(`/api/v1/admin/jobs/${j.id}/run`, {});
    if (res.error) { toast(`Run failed: ${res.error}`, "info"); return; }
    toast("Job ran", "check");
    load();
  }

  const columns: VbTableColumn<CronJob>[] = [
    { key: "name", label: "Name", flex: 1.2, render: (j) => <NameCell name={j.name} /> },
    { key: "cron", label: "Schedule", width: 140, mono: true, render: (j) => (
      <span style={{ fontSize: 12, color: "var(--vb-fg)" }}>{j.cron}</span>
    )},
    { key: "last", label: "Last run", width: 110, mono: true, render: (j) => (
      <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>{fmtRelTime(j.last_run_at)}</span>
    )},
    { key: "next", label: "Next run", width: 110, mono: true, render: (j) => (
      <span style={{ fontSize: 11, color: "var(--vb-accent)" }}>{fmtRelTime(j.next_run_at)}</span>
    )},
    { key: "status", label: "Status", width: 90, render: (j) => (
      j.last_status === "ok" ? <VbPill tone="success">ok</VbPill>
      : j.last_status === "error" ? <span title={j.last_error ?? ""}><VbPill tone="danger">error</VbPill></span>
      : <span style={{ color: "var(--vb-fg-3)", fontSize: 11 }}>—</span>
    )},
    { key: "enabled", label: "On", width: 70, align: "center", render: (j) => (
      <span onClick={(e) => e.stopPropagation()}>
        <Toggle on={!!j.enabled} onChange={() => toggleEnabled(j)} />
      </span>
    )},
    { key: "actions", label: "", width: 130, align: "right", render: (j) => (
      <RowActions>
        <VbBtn kind="ghost" size="sm" icon="play" onClick={() => handleRunNow(j)} title="Run now" />
        <VbBtn kind="ghost" size="sm" icon="pencil" onClick={() => setEditing(j)} title="Edit" />
        <VbBtn kind="danger" size="sm" icon="trash" onClick={() => handleDelete(j)} title="Delete" />
      </RowActions>
    )},
  ];

  return (
    <>
      <div style={{ padding: "14px 28px 0", display: "flex", justifyContent: "flex-end" }}>
        <VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>New job</VbBtn>
      </div>
      <div className="app-body">
        <VbTable<CronJob>
          rows={jobs}
          columns={columns}
          rowKey={(j) => j.id}
          loading={loading}
          onRowClick={setEditing}
          emptyState={
            <VbEmptyState
              icon="refresh"
              title="No cron jobs"
              body={<>Schedule JS code with cron expressions (UTC). Try <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>0 * * * *</span> for hourly.</>}
              actions={<VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>New job</VbBtn>}
            />
          }
        />
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
  const [modeKind, setModeKind] = useState<"inline" | "worker">("inline");
  const [modeQueue, setModeQueue] = useState("");
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
      const m = /^worker:(.+)$/.exec(job.mode ?? "inline");
      if (m) { setModeKind("worker"); setModeQueue(m[1]!.trim()); }
      else   { setModeKind("inline"); setModeQueue(""); }
    } else {
      setName("");
      setCron("0 * * * *");
      setCode(JOB_TEMPLATE);
      setEnabled(true);
      setModeKind("inline");
      setModeQueue("");
    }
    setError("");
    setSaving(false);
  }, [open, job]);

  async function handleSave() {
    if (!cron.trim()) { setError("Cron expression required"); return; }
    if (!cronAnalysis.valid) { setError(`Invalid cron: ${cronAnalysis.error ?? "unknown"}`); return; }
    if (modeKind === "worker" && !modeQueue.trim()) {
      setError("Queue name required for worker mode");
      return;
    }
    setSaving(true);
    setError("");
    const mode = modeKind === "worker" ? `worker:${modeQueue.trim()}` : "inline";
    const body = { name: name.trim(), cron: cron.trim(), code, enabled, mode };
    const res = isNew
      ? await api.post<ApiResponse<CronJob>>("/api/v1/admin/jobs", body)
      : await api.patch<ApiResponse<CronJob>>(`/api/v1/admin/jobs/${job!.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved();
    onClose();
  }

  const cronBorder = cron.trim() === ""
    ? undefined
    : cronAnalysis.valid ? "var(--vb-status-success)" : "var(--vb-status-danger)";

  return (
    <Dialog
      visible={open}
      onHide={onClose}
      header={<EditorHeader title={isNew ? "New cron job" : (name || "Edit job")} idHint={job ? `${job.id.slice(0, 12)}…` : null} />}
      modal
      draggable={false}
      resizable={false}
      maximizable
      style={EDITOR_DIALOG_STYLE}
      contentStyle={EDITOR_CONTENT_STYLE}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1 }}>
        <div style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 14,
          padding: "14px 18px",
          borderBottom: "1px solid var(--vb-border)",
          background: "var(--vb-bg-2)",
          flexWrap: "wrap",
        }}>
          <div style={{ width: 220 }}>
            <VbField label="Name">
              <VbInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. nightly-cleanup" />
            </VbField>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <VbField label="Cron expression" hint="UTC">
              <VbInput
                mono
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 3 * * *"
                style={cronBorder ? { borderColor: cronBorder } : undefined}
              />
            </VbField>
          </div>
          <div style={{ width: 200 }}>
            <VbField label="Preset">
              <Dropdown
                value={null}
                options={CRON_PRESETS.map((p) => ({ label: p.label, value: p.expr }))}
                onChange={(e) => setCron(e.value)}
                placeholder="—"
                style={{ width: "100%", height: 32 }}
              />
            </VbField>
          </div>
          <div style={{ width: 230 }}>
            <VbField label="Run mode">
              <Dropdown
                value={modeKind}
                options={[
                  { label: "Inline (in-process)", value: "inline" },
                  { label: "Enqueue onto worker queue", value: "worker" },
                ]}
                onChange={(e) => setModeKind(e.value)}
                style={{ width: "100%", height: 32 }}
              />
            </VbField>
          </div>
          {modeKind === "worker" && (
            <div style={{ width: 160 }}>
              <VbField label="Queue">
                <VbInput
                  mono
                  value={modeQueue}
                  onChange={(e) => setModeQueue(e.target.value.replace(/[^a-zA-Z0-9_:-]/g, ""))}
                  placeholder="default"
                />
              </VbField>
            </div>
          )}
          <ToggleField on={enabled} onChange={setEnabled} />
          <div style={{ display: "flex", gap: 8 }}>
            <VbBtn kind="ghost" size="sm" onClick={onClose}>Cancel</VbBtn>
            <VbBtn kind="primary" size="sm" icon="check" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </VbBtn>
          </div>
        </div>

        {error && <EditorErrorBar message={error} />}

        <div style={{
          display: "flex",
          alignItems: "stretch",
          gap: 0,
          padding: "12px 18px",
          borderBottom: "1px solid var(--vb-border)",
          background: "var(--vb-bg-2)",
          fontSize: 12,
        }}>
          {cronAnalysis.valid ? (
            <>
              <div style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                paddingRight: 16,
                borderRight: "1px solid var(--vb-border)",
              }}>
                <span style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: 1.2,
                  textTransform: "uppercase",
                  color: "var(--vb-fg-3)",
                  fontFamily: "var(--font-mono)",
                }}>Schedule</span>
                <span style={{ color: "var(--vb-accent)" }}>{cronAnalysis.description}</span>
              </div>
              <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 6, paddingLeft: 16 }}>
                <span style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: 1.2,
                  textTransform: "uppercase",
                  color: "var(--vb-fg-3)",
                  fontFamily: "var(--font-mono)",
                }}>Next 5 runs</span>
                <div style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 12,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--vb-fg-2)",
                }}>
                  {cronAnalysis.nextRuns.map((r, i) => (
                    <span key={i}>{r}</span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--vb-status-danger)" }}>
              <Icon name="alert" size={12} />
              <span>{cronAnalysis.error ?? "Invalid cron expression"}</span>
            </div>
          )}
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 8, background: "var(--vb-bg-1)" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CodeEditor
              value={code}
              onChange={setCode}
              language="javascript"
              jobContext
              height="100%"
            />
          </div>
          <EditorFootnote>
            <span>Cron format: <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>min hour dom mon dow</span></span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>Scheduler ticks every 30s</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>Errors logged to <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>last_error</span></span>
            <span style={{ opacity: 0.4 }}>·</span>
            <a href="https://crontab.guru/" target="_blank" rel="noreferrer" style={{ color: "var(--vb-accent)" }}>crontab.guru</a>
          </EditorFootnote>
        </div>
      </div>
    </Dialog>
  );
}

// ── Workers tab ────────────────────────────────────────────────────────────
function WorkersTab() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [stats, setStats] = useState<QueueStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Worker | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setLoading(true);
    const [w, s] = await Promise.all([
      api.get<ApiResponse<Worker[]>>("/api/v1/admin/workers"),
      api.get<ApiResponse<QueueStat[]>>("/api/v1/admin/queues/stats"),
    ]);
    if (w.data) setWorkers(w.data);
    if (s.data) setStats(s.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleEnabled(w: Worker) {
    const res = await api.patch<ApiResponse<Worker>>(`/api/v1/admin/workers/${w.id}`, { enabled: !w.enabled });
    if (res.error) { toast(res.error, "info"); return; }
    toast(`Worker ${w.enabled ? "disabled" : "enabled"}`);
    load();
  }

  async function handleDelete(w: Worker) {
    const ok = await confirm({
      title: "Delete worker",
      message: `Delete worker "${w.name || "(unnamed)"}" on queue "${w.queue}"?\n\nIn-flight jobs will finish; queued jobs stay in the log.`,
      danger: true,
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<null>>(`/api/v1/admin/workers/${w.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Worker deleted", "trash");
    load();
  }

  const statByQueue = useMemo(() => {
    const m = new Map<string, QueueStat>();
    for (const s of stats) m.set(s.queue, s);
    return m;
  }, [stats]);

  const columns: VbTableColumn<Worker>[] = [
    { key: "name", label: "Name", flex: 1.2, render: (w) => <NameCell name={w.name} /> },
    { key: "queue", label: "Queue", width: 140, mono: true, render: (w) => (
      <span style={{ fontSize: 12, color: "var(--vb-fg)" }}>{w.queue}</span>
    )},
    { key: "concurrency", label: "Concurrency", width: 110, mono: true, align: "right", render: (w) => (
      <span style={{ color: "var(--vb-fg)" }}>{w.concurrency}</span>
    )},
    { key: "retry", label: "Retry", width: 160, mono: true, render: (w) => (
      <span style={{ fontSize: 11, color: "var(--vb-fg-2)" }}>
        {w.retry_max} × {w.retry_backoff} ({w.retry_delay_ms}ms)
      </span>
    )},
    { key: "backlog", label: "Backlog", width: 220, render: (w) => {
      const s = statByQueue.get(w.queue);
      if (!s) return <span style={{ color: "var(--vb-fg-3)", fontSize: 11 }}>—</span>;
      return (
        <span style={{ display: "inline-flex", gap: 10, fontFamily: "var(--font-mono)", fontSize: 11 }}>
          <span style={{ color: "var(--vb-accent)" }}>{s.queued}q</span>
          <span style={{ color: "var(--vb-status-warning)" }}>{s.running}r</span>
          <span style={{ color: "var(--vb-status-success)" }}>{s.succeeded}✓</span>
          <span style={{ color: "var(--vb-status-danger)" }}>{s.dead}☠</span>
        </span>
      );
    }},
    { key: "enabled", label: "On", width: 70, align: "center", render: (w) => (
      <span onClick={(e) => e.stopPropagation()}>
        <Toggle on={!!w.enabled} onChange={() => toggleEnabled(w)} />
      </span>
    )},
    { key: "actions", label: "", width: 88, align: "right", render: (w) => (
      <RowActions>
        <VbBtn kind="ghost" size="sm" icon="pencil" onClick={() => setEditing(w)} title="Edit" />
        <VbBtn kind="danger" size="sm" icon="trash" onClick={() => handleDelete(w)} title="Delete" />
      </RowActions>
    )},
  ];

  return (
    <>
      <div style={{ padding: "14px 28px 0", display: "flex", justifyContent: "flex-end" }}>
        <VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>New worker</VbBtn>
      </div>
      <div className="app-body">
        <VbTable<Worker>
          rows={workers}
          columns={columns}
          rowKey={(w) => w.id}
          loading={loading}
          onRowClick={setEditing}
          emptyState={
            <VbEmptyState
              icon="zap"
              title="No workers"
              body={<>Workers process jobs from a named queue. Enqueue from hooks/routes/cron via{" "}
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>ctx.helpers.enqueue("queue-name", payload)</span>.</>}
              actions={<VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowNew(true)}>New worker</VbBtn>}
            />
          }
        />
      </div>

      <WorkerEditor
        worker={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
        onSaved={() => { toast("Worker saved"); load(); }}
      />
      <WorkerEditor
        worker={null}
        open={showNew}
        onClose={() => setShowNew(false)}
        onSaved={() => { toast("Worker created"); load(); }}
      />
    </>
  );
}

function WorkerEditor({
  worker,
  open,
  onClose,
  onSaved,
}: {
  worker: Worker | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !worker;
  const [name, setName] = useState("");
  const [queue, setQueue] = useState("default");
  const [code, setCode] = useState(WORKER_TEMPLATE);
  const [enabled, setEnabled] = useState(true);
  const [concurrency, setConcurrency] = useState(1);
  const [retryMax, setRetryMax] = useState(3);
  const [backoff, setBackoff] = useState<"exponential" | "fixed">("exponential");
  const [retryDelayMs, setRetryDelayMs] = useState(1000);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    if (worker) {
      setName(worker.name ?? "");
      setQueue(worker.queue);
      setCode(worker.code);
      setEnabled(!!worker.enabled);
      setConcurrency(worker.concurrency);
      setRetryMax(worker.retry_max);
      setBackoff(worker.retry_backoff);
      setRetryDelayMs(worker.retry_delay_ms);
    } else {
      setName("");
      setQueue("default");
      setCode(WORKER_TEMPLATE);
      setEnabled(true);
      setConcurrency(1);
      setRetryMax(3);
      setBackoff("exponential");
      setRetryDelayMs(1000);
    }
    setError("");
    setSaving(false);
  }, [open, worker]);

  async function handleSave() {
    if (!queue.trim()) { setError("Queue name required"); return; }
    setSaving(true);
    setError("");
    const body = {
      name: name.trim(),
      queue: queue.trim(),
      code,
      enabled,
      concurrency,
      retry_max: retryMax,
      retry_backoff: backoff,
      retry_delay_ms: retryDelayMs,
    };
    const res = isNew
      ? await api.post<ApiResponse<Worker>>("/api/v1/admin/workers", body)
      : await api.patch<ApiResponse<Worker>>(`/api/v1/admin/workers/${worker!.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved();
    onClose();
  }

  return (
    <Dialog
      visible={open}
      onHide={onClose}
      header={<EditorHeader title={isNew ? "New worker" : (name || "Edit worker")} idHint={worker ? `${worker.id.slice(0, 12)}…` : null} />}
      modal
      draggable={false}
      resizable={false}
      maximizable
      style={EDITOR_DIALOG_STYLE}
      contentStyle={EDITOR_CONTENT_STYLE}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1 }}>
        <div style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 14,
          padding: "14px 18px",
          borderBottom: "1px solid var(--vb-border)",
          background: "var(--vb-bg-2)",
          flexWrap: "wrap",
        }}>
          <div style={{ width: 200 }}>
            <VbField label="Name">
              <VbInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. send-emails" />
            </VbField>
          </div>
          <div style={{ width: 180 }}>
            <VbField label="Queue">
              <VbInput
                mono
                value={queue}
                onChange={(e) => setQueue(e.target.value.replace(/[^a-zA-Z0-9_:-]/g, ""))}
                placeholder="default"
              />
            </VbField>
          </div>
          <div style={{ width: 110 }}>
            <VbField label="Concurrency">
              <VbInput
                mono
                type="number"
                min={1}
                value={concurrency}
                onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value) || 1))}
              />
            </VbField>
          </div>
          <div style={{ width: 100 }}>
            <VbField label="Retries">
              <VbInput
                mono
                type="number"
                min={0}
                value={retryMax}
                onChange={(e) => setRetryMax(Math.max(0, Number(e.target.value) || 0))}
              />
            </VbField>
          </div>
          <div style={{ width: 150 }}>
            <VbField label="Backoff">
              <Dropdown
                value={backoff}
                options={[
                  { label: "Exponential", value: "exponential" },
                  { label: "Fixed",       value: "fixed" },
                ]}
                onChange={(e) => setBackoff(e.value)}
                style={{ width: "100%", height: 32 }}
              />
            </VbField>
          </div>
          <div style={{ width: 110 }}>
            <VbField label="Delay (ms)">
              <VbInput
                mono
                type="number"
                min={50}
                value={retryDelayMs}
                onChange={(e) => setRetryDelayMs(Math.max(50, Number(e.target.value) || 50))}
              />
            </VbField>
          </div>
          <ToggleField on={enabled} onChange={setEnabled} />
          <div style={{ display: "flex", gap: 8 }}>
            <VbBtn kind="ghost" size="sm" onClick={onClose}>Cancel</VbBtn>
            <VbBtn kind="primary" size="sm" icon="check" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </VbBtn>
          </div>
        </div>

        {error && <EditorErrorBar message={error} />}

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 8, background: "var(--vb-bg-1)" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CodeEditor
              value={code}
              onChange={setCode}
              language="javascript"
              workerContext
              height="100%"
            />
          </div>
          <EditorFootnote>
            <span>Throw to fail (counts as a retry attempt) · Return any value to mark succeeded</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>Scheduler polls every 500ms · Single worker per queue per tick</span>
          </EditorFootnote>
        </div>
      </div>
    </Dialog>
  );
}

// ── Jobs log tab ───────────────────────────────────────────────────────────
const JOB_STATUSES: Array<{ label: string; value: JobLogStatus | "" }> = [
  { label: "All",        value: "" },
  { label: "Queued",     value: "queued" },
  { label: "Running",    value: "running" },
  { label: "Succeeded",  value: "succeeded" },
  { label: "Failed",     value: "failed" },
  { label: "Dead",       value: "dead" },
];

function jobStatusTone(s: JobLogStatus): "success" | "warning" | "danger" | "accent" | "neutral" {
  if (s === "succeeded") return "success";
  if (s === "running") return "warning";
  if (s === "failed" || s === "dead") return "danger";
  return "accent";
}

function JobsLogTab() {
  const [rows, setRows] = useState<JobLogRow[]>([]);
  const [stats, setStats] = useState<QueueStat[]>([]);
  const [queueFilter, setQueueFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<JobLogStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<JobLogRow | null>(null);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (queueFilter) params.set("queue", queueFilter);
    if (statusFilter) params.set("status", statusFilter);
    params.set("page", String(page));
    params.set("perPage", "50");
    const [j, s] = await Promise.all([
      api.get<{ data: JobLogRow[] }>(`/api/v1/admin/queues/jobs?${params.toString()}`),
      api.get<ApiResponse<QueueStat[]>>("/api/v1/admin/queues/stats"),
    ]);
    setRows(j.data ?? []);
    if (s.data) setStats(s.data);
    setLoading(false);
  }
  useEffect(() => { void load(); }, [queueFilter, statusFilter, page]);

  async function handleRetry(j: JobLogRow) {
    const res = await api.post<ApiResponse<{ ok: boolean }>>(`/api/v1/admin/queues/jobs/${j.id}/retry`, {});
    if (res.error) { toast(res.error, "info"); return; }
    toast("Job re-queued", "check");
    load();
  }

  async function handleDiscard(j: JobLogRow) {
    const ok = await confirm({
      title: "Discard job",
      message: `Discard job ${j.id.slice(0, 8)}…? Audit trail will be lost.`,
      danger: true,
      confirmLabel: "Discard",
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<null>>(`/api/v1/admin/queues/jobs/${j.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Job discarded", "trash");
    load();
  }

  const queueOptions = [{ label: "All queues", value: "" }, ...stats.map((s) => ({ label: s.queue, value: s.queue }))];

  const columns: VbTableColumn<JobLogRow>[] = [
    { key: "status", label: "Status", width: 110, render: (j) => <VbPill tone={jobStatusTone(j.status)}>{j.status}</VbPill> },
    { key: "queue", label: "Queue", width: 140, mono: true, render: (j) => (
      <span style={{ fontSize: 12, color: "var(--vb-fg)" }}>{j.queue}</span>
    )},
    { key: "id", label: "Job id", flex: 1, mono: true, render: (j) => (
      <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>{j.id.slice(0, 16)}…</span>
    )},
    { key: "attempt", label: "Try", width: 60, mono: true, align: "right", render: (j) => (
      <span style={{ color: "var(--vb-fg)" }}>{j.attempt}</span>
    )},
    { key: "enqueued", label: "Enqueued", width: 130, mono: true, render: (j) => (
      <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>{fmtRelTime(j.enqueued_at)}</span>
    )},
    { key: "finished", label: "Finished", width: 130, mono: true, render: (j) => (
      <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>{fmtRelTime(j.finished_at)}</span>
    )},
    { key: "actions", label: "", width: 110, align: "right", render: (j) => (
      <RowActions>
        {(j.status === "failed" || j.status === "dead" || j.status === "succeeded") && (
          <VbBtn kind="ghost" size="sm" icon="refresh" onClick={() => handleRetry(j)} title="Re-queue" />
        )}
        {j.status !== "running" && (
          <VbBtn kind="danger" size="sm" icon="trash" onClick={() => handleDiscard(j)} title="Discard" />
        )}
      </RowActions>
    )},
  ];

  const totalPages = rows.length < 50 ? page : page + 1;

  return (
    <>
      <div style={{
        padding: "14px 28px 0",
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
      }}>
        <Dropdown
          value={queueFilter}
          options={queueOptions}
          onChange={(e) => { setPage(1); setQueueFilter(e.value); }}
          style={{ height: 32, minWidth: 180 }}
        />
        <Dropdown
          value={statusFilter}
          options={JOB_STATUSES}
          onChange={(e) => { setPage(1); setStatusFilter(e.value); }}
          style={{ height: 32, minWidth: 140 }}
        />
        <VbBtn kind="ghost" size="sm" icon="refresh" onClick={load}>Refresh</VbBtn>
        <div style={{ flex: 1 }} />
        <div style={{
          fontSize: 11,
          color: "var(--vb-fg-3)",
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          fontFamily: "var(--font-mono)",
        }}>
          {stats.map((s) => (
            <span key={s.queue}>
              <span style={{ color: "var(--vb-fg-2)" }}>{s.queue}:</span>{" "}
              <span style={{ color: "var(--vb-accent)" }}>{s.queued}q</span>{" "}
              <span style={{ color: "var(--vb-status-warning)" }}>{s.running}r</span>{" "}
              <span style={{ color: "var(--vb-status-danger)" }}>{s.dead}☠</span>
            </span>
          ))}
        </div>
      </div>
      <div className="app-body">
        <VbTable<JobLogRow>
          rows={rows}
          columns={columns}
          rowKey={(j) => j.id}
          loading={loading}
          onRowClick={setSelected}
          emptyState={
            <VbEmptyState
              icon="scroll"
              title="No jobs match the current filters"
              body="Adjust queue/status filters or run a job to populate the log."
            />
          }
        />
        <div style={{
          padding: "10px 4px 0",
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          alignItems: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          color: "var(--vb-fg-3)",
        }}>
          <VbBtn kind="ghost" size="sm" icon="chevronLeft" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            Prev
          </VbBtn>
          <span>page <span style={{ color: "var(--vb-fg)" }}>{page}</span></span>
          <VbBtn kind="ghost" size="sm" iconRight="chevronRight" onClick={() => setPage((p) => p + 1)} disabled={rows.length < 50}>
            Next
          </VbBtn>
          <span style={{ opacity: 0.5 }}>{totalPages > page ? "more available" : "end"}</span>
        </div>
      </div>

      <Dialog
        visible={!!selected}
        onHide={() => setSelected(null)}
        header={<EditorHeader title={selected ? `Job ${selected.id.slice(0, 12)}…` : ""} />}
        modal
        draggable={false}
        resizable={false}
        style={{ width: 680 }}
        contentStyle={{ background: "var(--vb-bg-2)" }}
      >
        {selected && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <KV k="status" v={selected.status} />
            <KV k="queue" v={selected.queue} />
            <KV k="worker_id" v={selected.worker_id ?? "—"} />
            <KV k="attempt" v={String(selected.attempt)} />
            <KV k="unique_key" v={selected.unique_key ?? "—"} />
            <KV k="enqueued_at"  v={fmtRelTime(selected.enqueued_at)} />
            <KV k="scheduled_at" v={fmtRelTime(selected.scheduled_at)} />
            <KV k="started_at"   v={fmtRelTime(selected.started_at)} />
            <KV k="finished_at"  v={fmtRelTime(selected.finished_at)} />
            <div>
              <KvLabel>payload</KvLabel>
              <pre style={{
                background: "var(--vb-bg-1)",
                border: "1px solid var(--vb-border)",
                color: "var(--vb-fg)",
                padding: 12,
                borderRadius: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                maxHeight: 240,
                overflow: "auto",
                margin: 0,
              }}>
                {tryPretty(selected.payload)}
              </pre>
            </div>
            {selected.error && (
              <div>
                <KvLabel>error</KvLabel>
                <pre style={{
                  background: "var(--vb-status-danger-bg)",
                  border: "1px solid rgba(232,90,79,0.3)",
                  color: "var(--vb-status-danger)",
                  padding: 12,
                  borderRadius: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  maxHeight: 240,
                  overflow: "auto",
                  margin: 0,
                }}>
                  {selected.error}
                </pre>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}

function tryPretty(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

function KvLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: 1.2,
      textTransform: "uppercase",
      color: "var(--vb-fg-3)",
      fontFamily: "var(--font-mono)",
      marginBottom: 6,
    }}>{children}</div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <span style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--vb-fg-3)",
        minWidth: 110,
        letterSpacing: 0.4,
      }}>{k}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vb-fg)" }}>{v}</span>
    </div>
  );
}
