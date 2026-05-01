/**
 * Feature flags admin.
 *
 * Two-pane layout: list on the left, editor on the right. Same pattern
 * as Hooks/Settings — no modal hopping. Editor handles new + existing
 * via key === "" sentinel.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, type ApiResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";

type FlagType = "bool" | "string" | "number" | "json";

interface Variation { name: string; value: unknown }

type Operator =
  | "eq" | "neq" | "in" | "not_in"
  | "contains" | "starts_with" | "ends_with"
  | "gt" | "gte" | "lt" | "lte"
  | "between" | "exists" | "regex";

interface Condition {
  attr: string;
  op: Operator;
  value: unknown;
}
interface Rule {
  id: string;
  when?: { all: Condition[] };
  rollout?: { value: number; sticky: string };
  variation: string;
}

interface Flag {
  key: string;
  description: string;
  type: FlagType;
  enabled: boolean;
  default_value: unknown;
  variations: Variation[];
  rules: Rule[];
  created_at: number;
  updated_at: number;
}

interface EvalResult {
  value: unknown;
  variation: string | null;
  reason: string;
  rule_id?: string;
}

const OP_OPTIONS: { label: string; value: Operator }[] = [
  { label: "= equals",          value: "eq" },
  { label: "≠ not equals",      value: "neq" },
  { label: "in list",           value: "in" },
  { label: "not in list",       value: "not_in" },
  { label: "contains",          value: "contains" },
  { label: "starts with",       value: "starts_with" },
  { label: "ends with",         value: "ends_with" },
  { label: ">",                 value: "gt" },
  { label: "≥",                 value: "gte" },
  { label: "<",                 value: "lt" },
  { label: "≤",                 value: "lte" },
  { label: "between [min,max]", value: "between" },
  { label: "exists",            value: "exists" },
  { label: "regex match",       value: "regex" },
];

const TYPE_OPTIONS = [
  { label: "Boolean", value: "bool" as FlagType },
  { label: "String",  value: "string" as FlagType },
  { label: "Number",  value: "number" as FlagType },
  { label: "JSON",    value: "json" as FlagType },
];

function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

export default function Flags() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api.get<ApiResponse<Flag[]>>("/api/v1/admin/flags").then((res) => {
      if (res.data) setFlags(res.data);
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  const selected = useMemo(
    () => (creating ? null : flags.find((f) => f.key === selectedKey) ?? null),
    [creating, flags, selectedKey],
  );

  return (
    <>
      <Topbar
        crumbs={[{ label: "Feature flags" }]}
        actions={
          <button
            className="btn btn-primary"
            onClick={() => { setCreating(true); setSelectedKey(null); }}
          >
            <Icon name="plus" size={12} /> New flag
          </button>
        }
      />
      <div className="app-body" style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, alignItems: "stretch" }}>
        <FlagList
          flags={flags}
          selectedKey={creating ? null : selectedKey}
          onSelect={(key) => { setCreating(false); setSelectedKey(key); }}
        />
        {creating ? (
          <FlagEditor
            key="__new"
            flag={emptyFlag()}
            isNew
            onSaved={(saved) => { setCreating(false); setSelectedKey(saved.key); load(); }}
            onCancel={() => setCreating(false)}
          />
        ) : selected ? (
          <FlagEditor
            key={selected.key}
            flag={selected}
            onSaved={() => load()}
            onDeleted={() => { setSelectedKey(null); load(); }}
          />
        ) : (
          <div className="empty" style={{ padding: 60, textAlign: "center", color: "var(--text-muted)" }}>
            <Icon name="webhook" size={28} />
            <div style={{ marginTop: 12, fontSize: 13 }}>Pick a flag to edit, or create a new one.</div>
          </div>
        )}
      </div>
    </>
  );
}

function FlagList({ flags, selectedKey, onSelect }: { flags: Flag[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  if (flags.length === 0) {
    return (
      <div className="empty" style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
        No flags yet. Create one →
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 4, alignContent: "start" }}>
      {flags.map((f) => (
        <button
          key={f.key}
          onClick={() => onSelect(f.key)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 6,
            border: "0.5px solid var(--border-default)",
            background: selectedKey === f.key ? "rgba(96,165,250,0.1)" : "var(--bg-panel)",
            color: "var(--text-primary)",
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <span
            style={{
              width: 8, height: 8, borderRadius: 4, flexShrink: 0,
              background: f.enabled ? "var(--success)" : "var(--text-muted)",
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.key}</div>
            <div className="muted" style={{ fontSize: 10, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {f.type} · {f.rules.length} rule{f.rules.length === 1 ? "" : "s"}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function emptyFlag(): Flag {
  const now = Math.floor(Date.now() / 1000);
  return {
    key: "",
    description: "",
    type: "bool",
    enabled: true,
    default_value: false,
    variations: [],
    rules: [],
    created_at: now,
    updated_at: now,
  };
}

function FlagEditor({
  flag, isNew, onSaved, onDeleted, onCancel,
}: {
  flag: Flag;
  isNew?: boolean;
  onSaved: (flag: Flag) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<Flag>(flag);
  const [saving, setSaving] = useState(false);
  const [testCtx, setTestCtx] = useState<string>('{ "user": { "id": "u1", "plan": "pro" } }');
  const [testResult, setTestResult] = useState<EvalResult | null>(null);

  useEffect(() => { setDraft(flag); setTestResult(null); }, [flag.key, isNew]);

  function patchDraft(patch: Partial<Flag>) { setDraft((d) => ({ ...d, ...patch })); }

  async function save() {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(draft.key)) {
      toast("Key: lowercase alphanumerics + . _ -, max 64", "info");
      return;
    }
    setSaving(true);
    const body = {
      description:   draft.description,
      type:          draft.type,
      enabled:       draft.enabled,
      default_value: draft.default_value,
      variations:    draft.variations,
      rules:         draft.rules,
    };
    const res = isNew
      ? await api.post<ApiResponse<Flag>>("/api/v1/admin/flags", { key: draft.key, ...body })
      : await api.patch<ApiResponse<Flag>>(`/api/v1/admin/flags/${encodeURIComponent(draft.key)}`, body);
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    if (res.data) { toast(isNew ? "Flag created" : "Flag saved"); onSaved(res.data); }
  }

  async function remove() {
    const ok = await confirm({ title: "Delete flag?", message: `Permanently remove "${draft.key}". Code paths reading this flag will fall back to their hardcoded defaults.`, danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    const res = await api.delete<ApiResponse<{ deleted: string }>>(`/api/v1/admin/flags/${encodeURIComponent(draft.key)}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Flag deleted");
    onDeleted?.();
  }

  async function runTest() {
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(testCtx) as Record<string, unknown>; }
    catch { toast("Test context: not valid JSON", "info"); return; }
    if (isNew) { toast("Save the flag first to evaluate", "info"); return; }
    const res = await api.post<ApiResponse<EvalResult>>(
      `/api/v1/admin/flags/${encodeURIComponent(draft.key)}/evaluate`,
      { context: ctx },
    );
    if (res.error) { toast(res.error, "info"); return; }
    if (res.data) setTestResult(res.data);
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="settings-section">
        <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h3>{isNew ? "New flag" : draft.key}</h3>
            {!isNew && <span className="meta">last updated {new Date(draft.updated_at * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle on={draft.enabled} onChange={(v) => patchDraft({ enabled: v })} />
            <span style={{ fontSize: 12, color: draft.enabled ? "var(--success)" : "var(--text-muted)" }}>
              {draft.enabled ? "Enabled" : "Off (kill switch)"}
            </span>
          </div>
        </div>
        <div className="settings-section-body">
          <div className="row" style={{ gap: 16 }}>
            <div style={{ flex: 1 }}>
              <label className="label">Key</label>
              <input
                className="input mono"
                value={draft.key}
                onChange={(e) => patchDraft({ key: e.target.value })}
                placeholder="new_checkout"
                disabled={!isNew}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label">Type</label>
              <Dropdown
                value={draft.type}
                options={TYPE_OPTIONS}
                onChange={(e) => patchDraft({ type: e.value as FlagType, default_value: typeDefault(e.value as FlagType) })}
                style={{ width: "100%" }}
              />
            </div>
          </div>
          <div className="label-block" style={{ marginTop: 14 }}>
            <label className="label">Description</label>
          </div>
          <input className="input" value={draft.description} onChange={(e) => patchDraft({ description: e.target.value })} placeholder="What this flag controls" />

          <div className="label-block" style={{ marginTop: 14 }}>
            <label className="label">Default value (when no rule matches)</label>
          </div>
          <ValueEditor
            type={draft.type}
            value={draft.default_value}
            variations={draft.variations}
            onChange={(v) => patchDraft({ default_value: v })}
          />
        </div>
      </div>

      {draft.type !== "bool" && (
        <VariationsEditor
          type={draft.type}
          variations={draft.variations}
          onChange={(variations) => patchDraft({ variations })}
        />
      )}

      <RulesEditor
        type={draft.type}
        variations={draft.variations}
        rules={draft.rules}
        onChange={(rules) => patchDraft({ rules })}
      />

      <div className="settings-section">
        <div className="settings-section-head">
          <h3>Test context</h3>
          <span className="meta">paste JSON · evaluate · trace which rule matched</span>
        </div>
        <div className="settings-section-body">
          <textarea
            className="input mono"
            rows={5}
            value={testCtx}
            onChange={(e) => setTestCtx(e.target.value)}
            style={{ width: "100%", fontSize: 12, resize: "vertical" }}
          />
          {testResult && (
            <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 6, border: "0.5px solid var(--border-default)", background: "var(--bg-panel)" }}>
              <div className="row" style={{ gap: 14, alignItems: "baseline" }}>
                <div>
                  <span className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>value</span>
                  <div className="mono" style={{ fontSize: 14, color: "var(--accent-light)" }}>{JSON.stringify(testResult.value)}</div>
                </div>
                <div>
                  <span className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>variation</span>
                  <div className="mono" style={{ fontSize: 12 }}>{testResult.variation ?? "—"}</div>
                </div>
                <div>
                  <span className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>reason</span>
                  <div className="mono" style={{ fontSize: 12 }}>{testResult.reason}</div>
                </div>
                {testResult.rule_id && (
                  <div>
                    <span className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>rule</span>
                    <div className="mono muted" style={{ fontSize: 11 }}>{testResult.rule_id}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={runTest} disabled={isNew}>
            <Icon name="play" size={11} /> Evaluate
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 8, justifyContent: "space-between" }}>
        {!isNew && onDeleted ? (
          <button className="btn" style={{ borderColor: "var(--danger)", color: "var(--danger)" }} onClick={remove}>
            <Icon name="trash" size={12} /> Delete flag
          </button>
        ) : <span />}
        <div style={{ display: "flex", gap: 8 }}>
          {isNew && onCancel && <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
          <button className="btn btn-primary" onClick={save} disabled={saving || (isNew && !draft.key)}>
            {saving ? "Saving…" : isNew ? "Create flag" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function typeDefault(t: FlagType): unknown {
  switch (t) {
    case "bool":   return false;
    case "string": return "";
    case "number": return 0;
    case "json":   return {};
  }
}

function ValueEditor({ type, value, variations, onChange }: {
  type: FlagType; value: unknown; variations: Variation[]; onChange: (v: unknown) => void;
}) {
  if (type === "bool") {
    return (
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <Toggle on={Boolean(value)} onChange={onChange} />
        <span className="mono" style={{ fontSize: 12 }}>{String(Boolean(value))}</span>
      </div>
    );
  }
  if (type === "string") {
    return <input className="input mono" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
  if (type === "number") {
    return <input className="input mono" type="number" value={Number(value ?? 0)} onChange={(e) => onChange(parseFloat(e.target.value) || 0)} />;
  }
  // json
  return (
    <textarea
      className="input mono"
      rows={3}
      value={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      onChange={(e) => {
        try { onChange(JSON.parse(e.target.value)); }
        catch { onChange(e.target.value); /* will validate on save */ }
      }}
      style={{ width: "100%", fontSize: 12, resize: "vertical" }}
    />
  );
  void variations;
}

function VariationsEditor({ type, variations, onChange }: {
  type: FlagType; variations: Variation[]; onChange: (v: Variation[]) => void;
}) {
  function update(i: number, patch: Partial<Variation>) {
    onChange(variations.map((v, idx) => idx === i ? { ...v, ...patch } : v));
  }
  function add() {
    onChange([...variations, { name: `v${variations.length + 1}`, value: typeDefault(type) }]);
  }
  function remove(i: number) {
    onChange(variations.filter((_, idx) => idx !== i));
  }
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Variations</h3>
        <span className="meta">named buckets the rule's "variation" picks from</span>
      </div>
      <div className="settings-section-body">
        {variations.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>No variations yet — add one to enable multivariate targeting.</div>
        ) : (
          variations.map((v, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input className="input mono" style={{ flex: "0 0 160px" }} value={v.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="treatment_a" />
              <div style={{ flex: 1 }}>
                <ValueEditor type={type} value={v.value} variations={[]} onChange={(val) => update(i, { value: val })} />
              </div>
              <button className="btn-icon danger" onClick={() => remove(i)} title="Remove variation">
                <Icon name="x" size={12} />
              </button>
            </div>
          ))
        )}
        <button className="btn btn-ghost" onClick={add}>
          <Icon name="plus" size={11} /> Add variation
        </button>
      </div>
    </div>
  );
}

function RulesEditor({ type, variations, rules, onChange }: {
  type: FlagType; variations: Variation[]; rules: Rule[]; onChange: (rules: Rule[]) => void;
}) {
  function patch(i: number, p: Partial<Rule>) { onChange(rules.map((r, idx) => idx === i ? { ...r, ...p } : r)); }
  function remove(i: number) { onChange(rules.filter((_, idx) => idx !== i)); }
  function move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i]!, next[j]!] = [next[j]!, next[i]!];
    onChange(next);
  }
  function add() {
    const next: Rule = {
      id: uid(),
      when: { all: [{ attr: "user.id", op: "exists", value: null }] },
      variation: type === "bool" ? "true" : (variations[0]?.name ?? "v1"),
    };
    onChange([...rules, next]);
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>Targeting rules</h3>
          <span className="meta">first matching rule wins · evaluated top to bottom</span>
        </div>
        <button className="btn btn-ghost" onClick={add}>
          <Icon name="plus" size={11} /> Add rule
        </button>
      </div>
      <div className="settings-section-body">
        {rules.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>No rules — every evaluation returns the default value.</div>
        ) : rules.map((r, i) => (
          <div key={r.id} style={{ padding: 12, borderRadius: 6, border: "0.5px solid var(--border-default)", background: "var(--bg-panel)", marginBottom: 10 }}>
            <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 8 }}>
              <span className="mono muted" style={{ fontSize: 11, minWidth: 24 }}>#{i + 1}</span>
              <span className="mono muted" style={{ fontSize: 10 }}>{r.id}</span>
              <span style={{ flex: 1 }} />
              <button className="btn-icon" onClick={() => move(i, -1)} disabled={i === 0} title="Move up"><Icon name="arrowUp" size={11} /></button>
              <button className="btn-icon" onClick={() => move(i, 1)} disabled={i === rules.length - 1} title="Move down"><Icon name="arrowDown" size={11} /></button>
              <button className="btn-icon danger" onClick={() => remove(i)} title="Remove"><Icon name="x" size={11} /></button>
            </div>

            <ConditionsEditor
              conds={r.when?.all ?? []}
              onChange={(conds) => patch(i, conds.length === 0
                ? { when: { all: [] } }
                : { when: { all: conds } })}
            />

            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <label className="label" style={{ marginBottom: 2 }}>Variation</label>
                {type === "bool" ? (
                  <Dropdown
                    value={r.variation}
                    options={[{ label: "true", value: "true" }, { label: "false", value: "false" }]}
                    onChange={(e) => patch(i, { variation: String(e.value) })}
                    style={{ minWidth: 100, height: 30, fontSize: 12 }}
                  />
                ) : variations.length > 0 ? (
                  <Dropdown
                    value={r.variation}
                    options={variations.map((v) => ({ label: v.name, value: v.name }))}
                    onChange={(e) => patch(i, { variation: String(e.value) })}
                    style={{ minWidth: 140, height: 30, fontSize: 12 }}
                  />
                ) : (
                  <input className="input mono" style={{ minWidth: 140, height: 30 }} value={r.variation} onChange={(e) => patch(i, { variation: e.target.value })} />
                )}
              </div>
              <div>
                <label className="label" style={{ marginBottom: 2 }}>Rollout %</label>
                <input
                  className="input mono"
                  type="number"
                  min={0}
                  max={100}
                  style={{ width: 80, height: 30, fontSize: 12 }}
                  value={r.rollout?.value ?? 100}
                  onChange={(e) => {
                    const n = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
                    patch(i, { rollout: { value: n, sticky: r.rollout?.sticky ?? "user.id" } });
                  }}
                />
              </div>
              <div>
                <label className="label" style={{ marginBottom: 2 }}>Sticky attr</label>
                <input
                  className="input mono"
                  style={{ width: 140, height: 30, fontSize: 12 }}
                  value={r.rollout?.sticky ?? "user.id"}
                  onChange={(e) => patch(i, { rollout: { value: r.rollout?.value ?? 100, sticky: e.target.value } })}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConditionsEditor({ conds, onChange }: { conds: Condition[]; onChange: (conds: Condition[]) => void }) {
  function update(i: number, patch: Partial<Condition>) { onChange(conds.map((c, idx) => idx === i ? { ...c, ...patch } : c)); }
  function remove(i: number) { onChange(conds.filter((_, idx) => idx !== i)); }
  function add() { onChange([...conds, { attr: "user.id", op: "eq", value: "" }]); }
  return (
    <>
      {conds.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>No conditions — rule matches every context.</div>
      ) : conds.map((c, i) => (
        <div key={i} className="row" style={{ gap: 6, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 11, minWidth: 30 }}>{i === 0 ? "where" : "and"}</span>
          <input className="input mono" style={{ flex: "0 0 160px", height: 28, fontSize: 12 }} value={c.attr} onChange={(e) => update(i, { attr: e.target.value })} placeholder="user.plan" />
          <Dropdown
            value={c.op}
            options={OP_OPTIONS}
            onChange={(e) => update(i, { op: e.value as Operator })}
            style={{ minWidth: 160, height: 28, fontSize: 12 }}
          />
          {c.op !== "exists" && (
            <input
              className="input mono"
              style={{ flex: 1, minWidth: 140, height: 28, fontSize: 12 }}
              value={typeof c.value === "string" ? c.value : JSON.stringify(c.value)}
              onChange={(e) => {
                const raw = e.target.value;
                let parsed: unknown = raw;
                if (c.op === "in" || c.op === "not_in" || c.op === "between") {
                  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
                } else if (raw === "true") parsed = true;
                else if (raw === "false") parsed = false;
                else if (!isNaN(Number(raw)) && raw.trim() !== "") parsed = Number(raw);
                update(i, { value: parsed });
              }}
              placeholder={c.op === "in" || c.op === "not_in" ? '["pro","enterprise"]' : c.op === "between" ? "[0, 100]" : "value"}
            />
          )}
          <button className="btn-icon danger" onClick={() => remove(i)} title="Remove condition">
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
      <button className="btn btn-ghost" onClick={add} style={{ fontSize: 11 }}>
        <Icon name="plus" size={10} /> Add condition
      </button>
    </>
  );
}
