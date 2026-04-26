import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, type ApiResponse, type Collection } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Modal, Toggle } from "../components/UI.tsx";
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? "New hook" : "Edit hook"}
      width={680}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 12px", background: "rgba(248,113,113,0.1)", borderRadius: 6 }}>
            {error}
          </div>
        )}
        <div className="row" style={{ gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label className="label">Collection</label>
            <Dropdown
              value={collName}
              options={collOptions}
              onChange={(e) => setCollName(e.value)}
              filter
              style={{ width: "100%", height: 34 }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">Event</label>
            <Dropdown
              value={event}
              options={EVENTS.map((e) => ({ label: e, value: e }))}
              onChange={(e) => setEvent(e.value as HookEvent)}
              style={{ width: "100%", height: 34 }}
              panelStyle={{ fontFamily: "var(--font-mono)" }}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, alignSelf: "flex-end", paddingBottom: 8 }}>
            <Toggle on={enabled} onChange={setEnabled} />
            <span>Enabled</span>
          </label>
        </div>
        <div>
          <label className="label">Hook code · JavaScript (async, IntelliSense on <span className="mono">ctx</span>)</label>
          <CodeEditor
            value={code}
            onChange={setCode}
            language="javascript"
            hookContext
            height={360}
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Type <span className="mono">ctx.</span> to autocomplete. Throw or call <span className="mono">ctx.helpers.abort(msg)</span> in <span className="mono">before*</span> to abort with 422.
            <span className="mono"> after*</span> errors are logged but don't fail the request.
          </div>
        </div>
      </div>
    </Modal>
  );
}
