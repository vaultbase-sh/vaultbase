/**
 * Webhooks admin. Two-pane editor identical to Hooks/Flags pattern.
 * Editor includes recent deliveries panel for the selected webhook.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, type ApiResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";

interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string;            // JSON
  secret: string;
  enabled: number;
  retry_max: number;
  retry_backoff: "exponential" | "fixed";
  retry_delay_ms: number;
  timeout_ms: number;
  custom_headers: string;    // JSON
  created_at: number;
  updated_at: number;
}

interface Delivery {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  attempt: number;
  status: "pending" | "succeeded" | "failed" | "dead";
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  scheduled_at: number;
  delivered_at: number | null;
  created_at: number;
}

const BACKOFF_OPTIONS = [
  { label: "Exponential", value: "exponential" },
  { label: "Fixed",       value: "fixed" },
];

function relTime(t: number): string {
  const diff = Math.floor(Date.now() / 1000) - t;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

function decodeArr(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}

function decodeObj(json: string): Record<string, string> {
  try { const v = JSON.parse(json); return v && typeof v === "object" ? v as Record<string, string> : {}; }
  catch { return {}; }
}

export default function Webhooks() {
  const [list, setList] = useState<Webhook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api.get<ApiResponse<Webhook[]>>("/api/admin/webhooks").then((res) => {
      if (res.data) setList(res.data);
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  const selected = useMemo(
    () => (creating ? null : list.find((w) => w.id === selectedId) ?? null),
    [creating, list, selectedId],
  );

  return (
    <>
      <Topbar
        crumbs={[{ label: "Webhooks" }]}
        actions={
          <button className="btn btn-primary" onClick={() => { setCreating(true); setSelectedId(null); }}>
            <Icon name="plus" size={12} /> New webhook
          </button>
        }
      />
      <div className="app-body" style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, alignItems: "stretch" }}>
        <List list={list} selectedId={creating ? null : selectedId} onSelect={(id) => { setCreating(false); setSelectedId(id); }} />
        {creating ? (
          <Editor
            key="__new"
            initial={empty()}
            isNew
            onSaved={(w) => { setCreating(false); setSelectedId(w.id); load(); }}
            onCancel={() => setCreating(false)}
          />
        ) : selected ? (
          <Editor
            key={selected.id}
            initial={selected}
            onSaved={() => load()}
            onDeleted={() => { setSelectedId(null); load(); }}
          />
        ) : (
          <div className="empty" style={{ padding: 60, textAlign: "center", color: "var(--text-muted)" }}>
            <Icon name="webhook" size={28} />
            <div style={{ marginTop: 12, fontSize: 13 }}>Pick a webhook to edit, or create a new one.</div>
          </div>
        )}
      </div>
    </>
  );
}

function List({ list, selectedId, onSelect }: { list: Webhook[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (list.length === 0) {
    return (
      <div className="empty" style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
        No webhooks yet. Create one →
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 4, alignContent: "start" }}>
      {list.map((w) => {
        const events = decodeArr(w.events);
        return (
          <button
            key={w.id}
            onClick={() => onSelect(w.id)}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
              borderRadius: 6, border: "0.5px solid var(--border-default)",
              background: selectedId === w.id ? "rgba(96,165,250,0.1)" : "var(--bg-panel)",
              color: "var(--text-primary)", textAlign: "left", cursor: "pointer",
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: 4, flexShrink: 0,
              background: w.enabled ? "var(--success)" : "var(--text-muted)",
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {w.name || w.url}
              </div>
              <div className="muted" style={{ fontSize: 10, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {events.length} event{events.length === 1 ? "" : "s"} · {w.url}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function empty(): Webhook {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "", name: "", url: "", events: "[]", secret: "", enabled: 1,
    retry_max: 3, retry_backoff: "exponential", retry_delay_ms: 1000, timeout_ms: 30000,
    custom_headers: "{}", created_at: now, updated_at: now,
  };
}

function Editor({
  initial, isNew, onSaved, onDeleted, onCancel,
}: {
  initial: Webhook;
  isNew?: boolean;
  onSaved: (w: Webhook) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<Webhook>(initial);
  const [saving, setSaving] = useState(false);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [openDelivery, setOpenDelivery] = useState<Delivery | null>(null);

  useEffect(() => { setDraft(initial); }, [initial.id, isNew]);

  const loadDeliveries = useCallback(() => {
    if (isNew || !draft.id) return;
    api.get<ApiResponse<Delivery[]>>(`/api/admin/webhooks/${encodeURIComponent(draft.id)}/deliveries?limit=50`).then((res) => {
      if (res.data) setDeliveries(res.data);
    });
  }, [isNew, draft.id]);
  useEffect(() => { loadDeliveries(); }, [loadDeliveries]);

  function patch(p: Partial<Webhook>) { setDraft((d) => ({ ...d, ...p })); }
  function patchEvents(events: string[]) { patch({ events: JSON.stringify(events) }); }
  function patchHeaders(h: Record<string, string>) { patch({ custom_headers: JSON.stringify(h) }); }

  async function save() {
    if (!/^https?:\/\//i.test(draft.url)) { toast("URL must be http(s)://", "info"); return; }
    setSaving(true);
    let body: Record<string, unknown> = {
      name: draft.name,
      url: draft.url,
      events: decodeArr(draft.events),
      enabled: draft.enabled === 1,
      retry_max: draft.retry_max,
      retry_backoff: draft.retry_backoff,
      retry_delay_ms: draft.retry_delay_ms,
      timeout_ms: draft.timeout_ms,
      custom_headers: decodeObj(draft.custom_headers),
    };
    if (draft.secret) body.secret = draft.secret;
    const res = isNew
      ? await api.post<ApiResponse<Webhook>>("/api/admin/webhooks", body)
      : await api.patch<ApiResponse<Webhook>>(`/api/admin/webhooks/${encodeURIComponent(draft.id)}`, body);
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    if (res.data) { toast(isNew ? "Webhook created" : "Webhook saved"); onSaved(res.data); }
  }

  async function remove() {
    const ok = await confirm({ title: "Delete webhook?", message: `"${draft.name || draft.url}" will stop receiving events.`, danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    const res = await api.delete<ApiResponse<{ deleted: string }>>(`/api/admin/webhooks/${encodeURIComponent(draft.id)}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Webhook deleted");
    onDeleted?.();
  }

  async function fireTest() {
    if (isNew) { toast("Save first to fire a test", "info"); return; }
    const res = await api.post<ApiResponse<{ ok: boolean }>>(`/api/admin/webhooks/${encodeURIComponent(draft.id)}/test`, {});
    if (res.error) { toast(res.error, "info"); return; }
    toast("Test event enqueued — refresh deliveries");
    setTimeout(loadDeliveries, 1500);
  }

  function regenerateSecret() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    patch({ secret: hex });
  }

  const events = decodeArr(draft.events);
  const headers = decodeObj(draft.custom_headers);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="settings-section">
        <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h3>{isNew ? "New webhook" : draft.name || draft.url}</h3>
            {!isNew && <span className="meta">last updated {new Date(draft.updated_at * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle on={draft.enabled === 1} onChange={(v) => patch({ enabled: v ? 1 : 0 })} />
            <span style={{ fontSize: 12, color: draft.enabled === 1 ? "var(--success)" : "var(--text-muted)" }}>
              {draft.enabled === 1 ? "Enabled" : "Off"}
            </span>
          </div>
        </div>
        <div className="settings-section-body">
          <div className="row" style={{ gap: 16 }}>
            <div style={{ flex: 1 }}>
              <label className="label">Name</label>
              <input className="input" value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Stripe payment events" />
            </div>
            <div style={{ flex: 2 }}>
              <label className="label">URL</label>
              <input className="input mono" value={draft.url} onChange={(e) => patch({ url: e.target.value })} placeholder="https://api.example.com/webhooks/vaultbase" />
            </div>
          </div>

          <div className="label-block" style={{ marginTop: 14 }}>
            <label className="label">Events</label>
            <div className="help">
              Subscribe to record events: <code>posts.create</code>, <code>posts.*</code>, <code>users.delete</code>.
              Use <code>*</code> for everything. Custom events fired from hooks (<code>helpers.webhooks.dispatch</code>)
              also match here.
            </div>
          </div>
          <EventEditor events={events} onChange={patchEvents} />

          <div className="row" style={{ gap: 16, marginTop: 16 }}>
            <div style={{ flex: 2 }}>
              <label className="label">HMAC secret</label>
              <div className="row" style={{ gap: 8 }}>
                <input className="input mono" value={draft.secret} onChange={(e) => patch({ secret: e.target.value })} placeholder="(auto-generated on save)" />
                <button className="btn btn-ghost" onClick={regenerateSecret}>Generate</button>
              </div>
              <div className="help" style={{ fontSize: 11, marginTop: 4 }}>
                Sent as <code>X-Vaultbase-Signature: sha256=&lt;hmac&gt;</code>. Receivers verify with{" "}
                <code>hmac(secret, "&lt;timestamp&gt;.&lt;body&gt;")</code>.
              </div>
            </div>
          </div>

          <div className="label-block" style={{ marginTop: 14 }}>
            <label className="label">Custom headers</label>
            <div className="help">Extra request headers (Authorization, X-API-Key, etc.).</div>
          </div>
          <HeaderEditor headers={headers} onChange={patchHeaders} />

          <div className="row" style={{ gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 120 }}>
              <label className="label">Retry max</label>
              <input className="input mono" type="number" min={0} value={draft.retry_max} onChange={(e) => patch({ retry_max: parseInt(e.target.value) || 0 })} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label className="label">Retry backoff</label>
              <Dropdown value={draft.retry_backoff} options={BACKOFF_OPTIONS} onChange={(e) => patch({ retry_backoff: e.value as "exponential" | "fixed" })} style={{ width: "100%" }} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label className="label">Retry delay (ms)</label>
              <input className="input mono" type="number" min={100} value={draft.retry_delay_ms} onChange={(e) => patch({ retry_delay_ms: parseInt(e.target.value) || 1000 })} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label className="label">Timeout (ms)</label>
              <input className="input mono" type="number" min={1000} value={draft.timeout_ms} onChange={(e) => patch({ timeout_ms: parseInt(e.target.value) || 30000 })} />
            </div>
          </div>
        </div>
      </div>

      {!isNew && (
        <div className="settings-section">
          <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h3>Recent deliveries</h3>
              <span className="meta">{deliveries.length} entries · pending → succeeded / failed / dead</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost" onClick={loadDeliveries}><Icon name="refresh" size={11} /> Refresh</button>
              <button className="btn btn-ghost" onClick={fireTest}><Icon name="play" size={11} /> Fire test</button>
            </div>
          </div>
          <div style={{ padding: "0 18px 18px" }}>
            {deliveries.length === 0 ? (
              <div className="empty" style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
                No deliveries yet.
              </div>
            ) : (
              <table style={{ width: "100%", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "0.5px solid var(--border-default)" }}>
                    <th style={{ padding: "8px 10px" }}>When</th>
                    <th style={{ padding: "8px 10px" }}>Event</th>
                    <th style={{ padding: "8px 10px" }}>Status</th>
                    <th style={{ padding: "8px 10px" }}>HTTP</th>
                    <th style={{ padding: "8px 10px" }}>Attempt</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => setOpenDelivery(d)}
                      style={{ cursor: "pointer", borderBottom: "0.5px solid rgba(255,255,255,0.04)" }}
                    >
                      <td style={{ padding: "8px 10px" }} className="mono muted">{relTime(d.created_at)}</td>
                      <td style={{ padding: "8px 10px" }} className="mono" >{d.event}</td>
                      <td style={{ padding: "8px 10px" }}>
                        <span className={`badge ${
                          d.status === "succeeded" ? "success"
                          : d.status === "failed"  ? "warning"
                          : d.status === "dead"    ? "danger" : "info"
                        }`}>{d.status}</span>
                      </td>
                      <td style={{ padding: "8px 10px" }} className="mono muted">{d.response_status ?? "—"}</td>
                      <td style={{ padding: "8px 10px" }} className="mono muted">{d.attempt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <div className="row" style={{ gap: 8, justifyContent: "space-between" }}>
        {!isNew && onDeleted ? (
          <button className="btn" style={{ borderColor: "var(--danger)", color: "var(--danger)" }} onClick={remove}>
            <Icon name="trash" size={12} /> Delete webhook
          </button>
        ) : <span />}
        <div style={{ display: "flex", gap: 8 }}>
          {isNew && onCancel && <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
          <button className="btn btn-primary" onClick={save} disabled={saving || !draft.url}>
            {saving ? "Saving…" : isNew ? "Create webhook" : "Save changes"}
          </button>
        </div>
      </div>

      {openDelivery && (
        <DeliveryDetail delivery={openDelivery} onClose={() => setOpenDelivery(null)} />
      )}
    </div>
  );
}

function EventEditor({ events, onChange }: { events: string[]; onChange: (e: string[]) => void }) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v) return;
    if (events.includes(v)) { setDraft(""); return; }
    onChange([...events, v]);
    setDraft("");
  }
  function remove(i: number) { onChange(events.filter((_, idx) => idx !== i)); }
  return (
    <>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {events.map((e, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 4, background: "rgba(96,165,250,0.1)", color: "var(--accent-light)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {e}
            <button onClick={() => remove(i)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}>
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input mono"
          style={{ flex: 1 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="posts.create — press Enter to add"
        />
        <button className="btn btn-ghost" onClick={add} disabled={!draft.trim()}>
          <Icon name="plus" size={11} /> Add
        </button>
      </div>
    </>
  );
}

function HeaderEditor({ headers, onChange }: { headers: Record<string, string>; onChange: (h: Record<string, string>) => void }) {
  const entries = Object.entries(headers);
  function update(i: number, key: string, value: string) {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], idx) => {
      if (idx === i) next[key] = value;
      else next[k] = v;
    });
    onChange(next);
  }
  function remove(i: number) {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], idx) => { if (idx !== i) next[k] = v; });
    onChange(next);
  }
  function add() { onChange({ ...headers, "X-Header": "" }); }
  return (
    <>
      {entries.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>No custom headers — add one below.</div>
      ) : entries.map(([k, v], i) => (
        <div key={i} className="row" style={{ gap: 6, marginBottom: 6 }}>
          <input className="input mono" style={{ flex: 1 }} value={k} onChange={(e) => update(i, e.target.value, v)} />
          <input className="input mono" style={{ flex: 2 }} value={v} onChange={(e) => update(i, k, e.target.value)} placeholder="value" />
          <button className="btn-icon danger" onClick={() => remove(i)}><Icon name="x" size={11} /></button>
        </div>
      ))}
      <button className="btn btn-ghost" onClick={add} style={{ marginTop: 6 }}>
        <Icon name="plus" size={11} /> Add header
      </button>
    </>
  );
}

function DeliveryDetail({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", justifyContent: "flex-end" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 520, maxWidth: "100vw", height: "100vh", background: "var(--bg-app)", borderLeft: "0.5px solid var(--border-default)", padding: 24, overflow: "auto" }}
      >
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 14 }}>Delivery</h3>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>{delivery.id}</div>
          </div>
          <button className="btn-icon" onClick={onClose}><Icon name="x" size={12} /></button>
        </div>

        <div className="row" style={{ gap: 16, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label className="label">Event</label>
            <div className="mono" style={{ fontSize: 13 }}>{delivery.event}</div>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">Status</label>
            <span className={`badge ${
              delivery.status === "succeeded" ? "success"
              : delivery.status === "failed"  ? "warning"
              : delivery.status === "dead"    ? "danger" : "info"
            }`}>{delivery.status}</span>
          </div>
        </div>

        <div className="row" style={{ gap: 16, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label className="label">Attempt</label>
            <div className="mono" style={{ fontSize: 13 }}>{delivery.attempt}</div>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">HTTP</label>
            <div className="mono" style={{ fontSize: 13 }}>{delivery.response_status ?? "—"}</div>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="label">Created</label>
          <div className="mono muted" style={{ fontSize: 12 }}>{new Date(delivery.created_at * 1000).toISOString()}</div>
        </div>
        {delivery.delivered_at && (
          <div style={{ marginBottom: 16 }}>
            <label className="label">Finished</label>
            <div className="mono muted" style={{ fontSize: 12 }}>{new Date(delivery.delivered_at * 1000).toISOString()}</div>
          </div>
        )}

        <label className="label">Payload</label>
        <pre className="code-block" style={{ margin: 0, marginBottom: 16, maxHeight: 220, overflow: "auto", fontSize: 11 }}>
          {tryFormat(delivery.payload)}
        </pre>

        {delivery.response_body && (
          <>
            <label className="label">Response body</label>
            <pre className="code-block" style={{ margin: 0, marginBottom: 16, maxHeight: 180, overflow: "auto", fontSize: 11 }}>
              {tryFormat(delivery.response_body)}
            </pre>
          </>
        )}

        {delivery.error && (
          <>
            <label className="label">Error</label>
            <div style={{ padding: "8px 10px", borderRadius: 4, background: "rgba(248,113,113,0.1)", color: "var(--danger)", fontSize: 12 }}>
              {delivery.error}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function tryFormat(json: string): string {
  try { return JSON.stringify(JSON.parse(json), null, 2); }
  catch { return json; }
}
