/**
 * Webhooks admin. Two-pane editor identical to Hooks/Flags pattern.
 * Editor includes recent deliveries panel for the selected webhook.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, type ApiResponse } from "../api.ts";
import {
  VbBtn, VbField, VbInput, VbPageHeader, VbPill,
  VbTable, VbEmptyState, type VbTableColumn,
} from "../components/Vb.tsx";
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

const DELIVERY_COLUMNS: VbTableColumn<Delivery>[] = [
  {
    key: "when", label: "When", width: 110, mono: true,
    render: (d) => <span style={{ color: "var(--vb-fg-3)" }}>{relTime(d.created_at)}</span>,
  },
  {
    key: "event", label: "Event", flex: 1, mono: true,
    render: (d) => <span style={{ color: "var(--vb-fg)" }}>{d.event}</span>,
  },
  {
    key: "status", label: "Status", width: 110,
    render: (d) => {
      const tone = d.status === "succeeded" ? "success"
        : d.status === "failed" ? "warning"
        : d.status === "dead" ? "danger"
        : "neutral";
      return <VbPill tone={tone} dot>{d.status}</VbPill>;
    },
  },
  {
    key: "http", label: "HTTP", width: 80, mono: true, align: "right",
    render: (d) => <span style={{ color: "var(--vb-fg-3)" }}>{d.response_status ?? "—"}</span>,
  },
  {
    key: "attempt", label: "Attempt", width: 80, mono: true, align: "right",
    render: (d) => <span style={{ color: "var(--vb-fg-3)" }}>{d.attempt}</span>,
  },
];

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
    api.get<ApiResponse<Webhook[]>>("/api/v1/admin/webhooks").then((res) => {
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
      <VbPageHeader
        breadcrumb={["Webhooks"]}
        title="Webhooks"
        sub="Outbound HMAC-signed HTTP delivery on record events. Per-webhook event subscriptions, retry budget, dead-letter trail."
        right={
          <VbBtn
            kind="primary"
            size="sm"
            icon="plus"
            onClick={() => { setCreating(true); setSelectedId(null); }}
          >New webhook</VbBtn>
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
          <VbEmptyState
            icon="webhook"
            title="Pick a webhook to edit"
            body="Or create a new one to start broadcasting record events."
          />
        )}
      </div>
    </>
  );
}

function List({ list, selectedId, onSelect }: { list: Webhook[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (list.length === 0) {
    return (
      <div style={{
        padding: 24,
        background: "var(--vb-bg-2)",
        border: "1px solid var(--vb-border)",
        borderRadius: 8,
        textAlign: "center",
        fontSize: 12,
        color: "var(--vb-fg-3)",
      }}>
        No webhooks yet. Create one →
      </div>
    );
  }
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      background: "var(--vb-bg-2)",
      border: "1px solid var(--vb-border)",
      borderRadius: 8,
      overflow: "hidden",
      alignSelf: "start",
    }}>
      {list.map((w, i) => {
        const events = decodeArr(w.events);
        const isSel = selectedId === w.id;
        return (
          <button
            key={w.id}
            onClick={() => onSelect(w.id)}
            style={{
              appearance: "none",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 14px",
              border: "none",
              borderBottom: i === list.length - 1 ? "none" : "1px solid var(--vb-border)",
              borderLeft: isSel ? "2px solid var(--vb-accent)" : "2px solid transparent",
              background: isSel ? "var(--vb-accent-soft)" : "transparent",
              color: "var(--vb-fg)",
              textAlign: "left",
              cursor: "pointer",
              transition: "background 100ms",
            }}
            onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "var(--vb-bg-3)"; }}
            onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
              background: w.enabled ? "var(--vb-status-success)" : "var(--vb-fg-3)",
              boxShadow: w.enabled ? "0 0 0 3px rgba(98,204,156,0.16)" : "none",
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--vb-fg)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>{w.name || w.url}</div>
              <div style={{
                fontSize: 10.5,
                color: "var(--vb-fg-3)",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
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

function Section({
  title, meta, right, children,
}: { title: string; meta?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--vb-bg-2)",
      border: "1px solid var(--vb-border)",
      borderRadius: 8,
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: "1px solid var(--vb-border)",
        background: "var(--vb-bg-1)",
        gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--vb-fg)" }}>{title}</h3>
          {meta && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vb-fg-3)" }}>{meta}</span>
          )}
        </div>
        {right && <div style={{ display: "flex", gap: 8 }}>{right}</div>}
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.5, marginTop: 4 }}>{children}</div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code style={{
      fontFamily: "var(--font-mono)",
      fontSize: "0.86em",
      padding: "1px 5px",
      borderRadius: 4,
      background: "var(--vb-bg-3)",
      color: "var(--vb-fg)",
    }}>{children}</code>
  );
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
    api.get<ApiResponse<Delivery[]>>(`/api/v1/admin/webhooks/${encodeURIComponent(draft.id)}/deliveries?limit=50`).then((res) => {
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
      ? await api.post<ApiResponse<Webhook>>("/api/v1/admin/webhooks", body)
      : await api.patch<ApiResponse<Webhook>>(`/api/v1/admin/webhooks/${encodeURIComponent(draft.id)}`, body);
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    if (res.data) { toast(isNew ? "Webhook created" : "Webhook saved"); onSaved(res.data); }
  }

  async function remove() {
    const ok = await confirm({ title: "Delete webhook?", message: `"${draft.name || draft.url}" will stop receiving events.`, danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    const res = await api.delete<ApiResponse<{ deleted: string }>>(`/api/v1/admin/webhooks/${encodeURIComponent(draft.id)}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Webhook deleted");
    onDeleted?.();
  }

  async function fireTest() {
    if (isNew) { toast("Save first to fire a test", "info"); return; }
    const res = await api.post<ApiResponse<{ ok: boolean }>>(`/api/v1/admin/webhooks/${encodeURIComponent(draft.id)}/test`, {});
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <Section
        title={isNew ? "New webhook" : draft.name || draft.url}
        meta={!isNew ? `last updated ${new Date(draft.updated_at * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC` : undefined}
        right={
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle on={draft.enabled === 1} onChange={(v) => patch({ enabled: v ? 1 : 0 })} />
            <span style={{ fontSize: 12, color: draft.enabled === 1 ? "var(--vb-status-success)" : "var(--vb-fg-3)" }}>
              {draft.enabled === 1 ? "Enabled" : "Off"}
            </span>
          </span>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <VbField label="Name">
                <VbInput value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Stripe payment events" />
              </VbField>
            </div>
            <div style={{ flex: 2 }}>
              <VbField label="URL">
                <VbInput mono value={draft.url} onChange={(e) => patch({ url: e.target.value })} placeholder="https://api.example.com/webhooks/vaultbase" />
              </VbField>
            </div>
          </div>

          <div>
            <VbField label="Events" hint={
              <>Subscribe to record events: <Code>posts.create</Code>, <Code>posts.*</Code>, <Code>users.delete</Code>. Use <Code>*</Code> for everything. Custom events fired from hooks (<Code>helpers.webhooks.dispatch</Code>) also match here.</>
            }>
              <div />
            </VbField>
            <div style={{ marginTop: 8 }}>
              <EventEditor events={events} onChange={patchEvents} />
            </div>
          </div>

          <div>
            <VbField label="HMAC secret" hint={
              <>Sent as <Code>X-Vaultbase-Signature: sha256=&lt;hmac&gt;</Code>. Receivers verify with <Code>hmac(secret, "&lt;timestamp&gt;.&lt;body&gt;")</Code>.</>
            }>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <VbInput mono value={draft.secret} onChange={(e) => patch({ secret: e.target.value })} placeholder="(auto-generated on save)" />
                </div>
                <VbBtn kind="ghost" size="md" icon="refresh" onClick={regenerateSecret}>Generate</VbBtn>
              </div>
            </VbField>
          </div>

          <div>
            <VbField label="Custom headers" hint="Extra request headers (Authorization, X-API-Key, etc.).">
              <div />
            </VbField>
            <div style={{ marginTop: 8 }}>
              <HeaderEditor headers={headers} onChange={patchHeaders} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 120 }}>
              <VbField label="Retry max">
                <VbInput mono type="number" min={0} value={draft.retry_max} onChange={(e) => patch({ retry_max: parseInt(e.target.value) || 0 })} />
              </VbField>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <VbField label="Retry backoff">
                <Dropdown value={draft.retry_backoff} options={BACKOFF_OPTIONS} onChange={(e) => patch({ retry_backoff: e.value as "exponential" | "fixed" })} style={{ width: "100%", height: 32 }} />
              </VbField>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <VbField label="Retry delay (ms)">
                <VbInput mono type="number" min={100} value={draft.retry_delay_ms} onChange={(e) => patch({ retry_delay_ms: parseInt(e.target.value) || 1000 })} />
              </VbField>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <VbField label="Timeout (ms)">
                <VbInput mono type="number" min={1000} value={draft.timeout_ms} onChange={(e) => patch({ timeout_ms: parseInt(e.target.value) || 30000 })} />
              </VbField>
            </div>
          </div>
        </div>
      </Section>

      {!isNew && (
        <Section
          title="Recent deliveries"
          meta={`${deliveries.length} entries · pending → succeeded / failed / dead`}
          right={
            <>
              <VbBtn kind="ghost" size="sm" icon="refresh" onClick={loadDeliveries}>Refresh</VbBtn>
              <VbBtn kind="ghost" size="sm" icon="play" onClick={fireTest}>Fire test</VbBtn>
            </>
          }
        >
          <VbTable<Delivery>
            rows={deliveries}
            rowKey={(d) => d.id}
            onRowClick={(d) => setOpenDelivery(d)}
            columns={DELIVERY_COLUMNS}
            emptyState={
              <div style={{ padding: 32, textAlign: "center", fontSize: 12, color: "var(--vb-fg-3)" }}>
                No deliveries yet.
              </div>
            }
          />
        </Section>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
        {!isNew && onDeleted ? (
          <VbBtn kind="danger" size="md" icon="trash" onClick={remove}>Delete webhook</VbBtn>
        ) : <span />}
        <div style={{ display: "flex", gap: 8 }}>
          {isNew && onCancel && <VbBtn kind="ghost" size="md" onClick={onCancel}>Cancel</VbBtn>}
          <VbBtn kind="primary" size="md" icon="check" onClick={save} disabled={saving || !draft.url}>
            {saving ? "Saving…" : isNew ? "Create webhook" : "Save changes"}
          </VbBtn>
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
      {events.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {events.map((e, i) => (
            <span key={i} style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: 4,
              background: "var(--vb-accent-soft)",
              color: "var(--vb-accent)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}>
              {e}
              <button
                onClick={() => remove(i)}
                style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}
                title="Remove event"
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <VbInput
            mono
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder="posts.create — press Enter to add"
          />
        </div>
        <VbBtn kind="ghost" size="md" icon="plus" onClick={add} disabled={!draft.trim()}>Add</VbBtn>
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
        <Hint>No custom headers — add one below.</Hint>
      ) : entries.map(([k, v], i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <VbInput mono value={k} onChange={(e) => update(i, e.target.value, v)} placeholder="X-Header-Name" />
          </div>
          <div style={{ flex: 2 }}>
            <VbInput mono value={v} onChange={(e) => update(i, k, e.target.value)} placeholder="value" />
          </div>
          <VbBtn kind="danger" size="sm" icon="x" onClick={() => remove(i)} title="Remove header" />
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <VbBtn kind="ghost" size="sm" icon="plus" onClick={add}>Add header</VbBtn>
      </div>
    </>
  );
}

function DeliveryDetail({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const tone = delivery.status === "succeeded" ? "success"
    : delivery.status === "failed"  ? "warning"
    : delivery.status === "dead"    ? "danger" : "neutral";

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, display: "flex", justifyContent: "flex-end" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540,
          maxWidth: "100vw",
          height: "100vh",
          background: "var(--vb-bg-2)",
          borderLeft: "1px solid var(--vb-border)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "-8px 0 40px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 18px",
          borderBottom: "1px solid var(--vb-border)",
          background: "var(--vb-bg-1)",
          gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--vb-fg)" }}>Delivery</div>
            <div style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--vb-fg-3)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>{delivery.id}</div>
          </div>
          <VbBtn kind="ghost" size="sm" icon="x" onClick={onClose} title="Close" />
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <KvLabel>Event</KvLabel>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--vb-fg)" }}>{delivery.event}</div>
            </div>
            <div style={{ flex: 1 }}>
              <KvLabel>Status</KvLabel>
              <VbPill tone={tone} dot>{delivery.status}</VbPill>
            </div>
          </div>

          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <KvLabel>Attempt</KvLabel>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--vb-fg)" }}>{delivery.attempt}</div>
            </div>
            <div style={{ flex: 1 }}>
              <KvLabel>HTTP</KvLabel>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--vb-fg)" }}>{delivery.response_status ?? "—"}</div>
            </div>
          </div>

          <div>
            <KvLabel>Created</KvLabel>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vb-fg-3)" }}>
              {new Date(delivery.created_at * 1000).toISOString()}
            </div>
          </div>
          {delivery.delivered_at && (
            <div>
              <KvLabel>Finished</KvLabel>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vb-fg-3)" }}>
                {new Date(delivery.delivered_at * 1000).toISOString()}
              </div>
            </div>
          )}

          <div>
            <KvLabel>Payload</KvLabel>
            <pre style={{
              background: "var(--vb-bg-1)",
              border: "1px solid var(--vb-border)",
              color: "var(--vb-fg)",
              padding: 12,
              borderRadius: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              maxHeight: 220,
              overflow: "auto",
              margin: 0,
            }}>{tryFormat(delivery.payload)}</pre>
          </div>

          {delivery.response_body && (
            <div>
              <KvLabel>Response body</KvLabel>
              <pre style={{
                background: "var(--vb-bg-1)",
                border: "1px solid var(--vb-border)",
                color: "var(--vb-fg)",
                padding: 12,
                borderRadius: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                maxHeight: 180,
                overflow: "auto",
                margin: 0,
              }}>{tryFormat(delivery.response_body)}</pre>
            </div>
          )}

          {delivery.error && (
            <div>
              <KvLabel>Error</KvLabel>
              <div style={{
                padding: "10px 12px",
                borderRadius: 6,
                background: "var(--vb-status-danger-bg)",
                border: "1px solid rgba(232,90,79,0.3)",
                color: "var(--vb-status-danger)",
                fontSize: 12,
              }}>{delivery.error}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
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

function tryFormat(json: string): string {
  try { return JSON.stringify(JSON.parse(json), null, 2); }
  catch { return json; }
}
