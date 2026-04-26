import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Dialog } from "primereact/dialog";
import { api, type ApiResponse, type Collection, type FieldDef, parseFields } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Toggle } from "../components/UI.tsx";
import { CodeEditor } from "../components/CodeEditor.tsx";
import Icon from "../components/Icon.tsx";

interface Hook {
  id: string;
  collection_name: string;
  event: HookEvent;
  code: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

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

export default function Hooks({
  toast,
}: {
  toast: (text: string, icon?: string) => void;
}) {
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
    if (!confirm(`Delete this ${h.event} hook?`)) return;
    const res = await api.delete<ApiResponse<null>>(`/api/admin/hooks/${h.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Hook deleted", "trash");
    load();
  }

  return (
    <>
      <Topbar
        title="Hooks"
        subtitle={`${hooks.length} server-side script${hooks.length === 1 ? "" : "s"}`}
        actions={
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={12} /> New hook
          </button>
        }
      />
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
                        maxWidth: 360,
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
  const [collName, setCollName] = useState<string>("");
  const [event, setEvent] = useState<HookEvent>("beforeCreate");
  const [code, setCode] = useState<string>(HOOK_TEMPLATE);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    if (hook) {
      setCollName(hook.collection_name);
      setEvent(hook.event);
      setCode(hook.code);
      setEnabled(!!hook.enabled);
    } else {
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
    const body = { collection_name: collName, event, code, enabled };
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
        {isNew ? "New hook" : "Edit hook"}
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
