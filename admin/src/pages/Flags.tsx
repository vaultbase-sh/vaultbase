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
import {
  VbBtn, VbField, VbInput, VbPageHeader, VbPill, VbEmptyState,
} from "../components/Vb.tsx";
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
      <VbPageHeader
        breadcrumb={["Feature flags"]}
        title="Feature flags"
        sub="Bool / string / number / json flags with rule-based targeting and sticky percentage rollout."
        right={
          <VbBtn
            kind="primary"
            size="sm"
            icon="plus"
            onClick={() => { setCreating(true); setSelectedKey(null); }}
          >New flag</VbBtn>
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
          <VbEmptyState
            icon="webhook"
            title="Pick a flag to edit"
            body="Or create a new one. Rules are evaluated top to bottom — first match wins."
          />
        )}
      </div>
    </>
  );
}

function FlagList({ flags, selectedKey, onSelect }: { flags: Flag[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  if (flags.length === 0) {
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
        No flags yet. Create one →
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
      {flags.map((f, i) => {
        const isSel = selectedKey === f.key;
        return (
          <button
            key={f.key}
            onClick={() => onSelect(f.key)}
            style={{
              appearance: "none",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 14px",
              border: "none",
              borderBottom: i === flags.length - 1 ? "none" : "1px solid var(--vb-border)",
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
              background: f.enabled ? "var(--vb-status-success)" : "var(--vb-fg-3)",
              boxShadow: f.enabled ? "0 0 0 3px rgba(98,204,156,0.16)" : "none",
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--vb-fg)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>{f.key}</div>
              <div style={{
                fontSize: 10.5,
                color: "var(--vb-fg-3)",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {f.type} · {f.rules.length} rule{f.rules.length === 1 ? "" : "s"}
              </div>
            </div>
          </button>
        );
      })}
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
        {right && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{right}</div>}
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <Section
        title={isNew ? "New flag" : draft.key}
        meta={!isNew ? `last updated ${new Date(draft.updated_at * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC` : undefined}
        right={
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle on={draft.enabled} onChange={(v) => patchDraft({ enabled: v })} />
            <span style={{ fontSize: 12, color: draft.enabled ? "var(--vb-status-success)" : "var(--vb-fg-3)" }}>
              {draft.enabled ? "Enabled" : "Off (kill switch)"}
            </span>
          </span>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <VbField label="Key">
                <VbInput
                  mono
                  value={draft.key}
                  onChange={(e) => patchDraft({ key: e.target.value })}
                  placeholder="new_checkout"
                  disabled={!isNew}
                />
              </VbField>
            </div>
            <div style={{ flex: 1 }}>
              <VbField label="Type">
                <Dropdown
                  value={draft.type}
                  options={TYPE_OPTIONS}
                  onChange={(e) => patchDraft({ type: e.value as FlagType, default_value: typeDefault(e.value as FlagType) })}
                  style={{ width: "100%", height: 32 }}
                />
              </VbField>
            </div>
          </div>

          <VbField label="Description">
            <VbInput value={draft.description} onChange={(e) => patchDraft({ description: e.target.value })} placeholder="What this flag controls" />
          </VbField>

          <VbField label="Default value" hint="returned when no rule matches">
            <ValueEditor
              type={draft.type}
              value={draft.default_value}
              variations={draft.variations}
              onChange={(v) => patchDraft({ default_value: v })}
            />
          </VbField>
        </div>
      </Section>

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

      <Section
        title="Test context"
        meta="paste JSON · evaluate · trace which rule matched"
        right={
          <VbBtn kind="ghost" size="sm" icon="play" onClick={runTest} disabled={isNew}>Evaluate</VbBtn>
        }
      >
        <textarea
          rows={5}
          value={testCtx}
          onChange={(e) => setTestCtx(e.target.value)}
          style={{
            width: "100%",
            background: "var(--vb-bg-3)",
            border: "1px solid var(--vb-border-2)",
            borderRadius: 5,
            color: "var(--vb-fg)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            padding: "8px 10px",
            resize: "vertical",
            outline: "none",
          }}
        />
        {testResult && (
          <div style={{
            marginTop: 14,
            padding: "12px 14px",
            borderRadius: 6,
            border: "1px solid var(--vb-border)",
            background: "var(--vb-bg-1)",
          }}>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline" }}>
              <KvBlock label="value" mono accent>{JSON.stringify(testResult.value)}</KvBlock>
              <KvBlock label="variation" mono>{testResult.variation ?? "—"}</KvBlock>
              <KvBlock label="reason" mono>{testResult.reason}</KvBlock>
              {testResult.rule_id && (
                <KvBlock label="rule" mono muted>{testResult.rule_id}</KvBlock>
              )}
            </div>
          </div>
        )}
      </Section>

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
        {!isNew && onDeleted ? (
          <VbBtn kind="danger" size="md" icon="trash" onClick={remove}>Delete flag</VbBtn>
        ) : <span />}
        <div style={{ display: "flex", gap: 8 }}>
          {isNew && onCancel && <VbBtn kind="ghost" size="md" onClick={onCancel}>Cancel</VbBtn>}
          <VbBtn kind="primary" size="md" icon="check" onClick={save} disabled={saving || (isNew && !draft.key)}>
            {saving ? "Saving…" : isNew ? "Create flag" : "Save changes"}
          </VbBtn>
        </div>
      </div>
    </div>
  );
}

function KvBlock({ label, children, mono, accent, muted }: {
  label: string; children: React.ReactNode; mono?: boolean; accent?: boolean; muted?: boolean;
}) {
  return (
    <div>
      <div style={{
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        color: "var(--vb-fg-3)",
        fontFamily: "var(--font-mono)",
      }}>{label}</div>
      <div style={{
        fontFamily: mono ? "var(--font-mono)" : "inherit",
        fontSize: accent ? 14 : 12,
        marginTop: 2,
        color: accent ? "var(--vb-accent)" : muted ? "var(--vb-fg-3)" : "var(--vb-fg)",
      }}>{children}</div>
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
      <div style={{ display: "flex", gap: 10, alignItems: "center", paddingTop: 4 }}>
        <Toggle on={Boolean(value)} onChange={onChange} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vb-fg)" }}>
          {String(Boolean(value))}
        </span>
      </div>
    );
  }
  if (type === "string") {
    return <VbInput mono value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
  if (type === "number") {
    return <VbInput mono type="number" value={Number(value ?? 0)} onChange={(e) => onChange(parseFloat(e.target.value) || 0)} />;
  }
  // json
  return (
    <textarea
      rows={3}
      value={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      onChange={(e) => {
        try { onChange(JSON.parse(e.target.value)); }
        catch { onChange(e.target.value); /* will validate on save */ }
      }}
      style={{
        width: "100%",
        background: "var(--vb-bg-3)",
        border: "1px solid var(--vb-border-2)",
        borderRadius: 5,
        color: "var(--vb-fg)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        padding: "8px 10px",
        resize: "vertical",
        outline: "none",
      }}
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
    <Section
      title="Variations"
      meta={`named buckets the rule's "variation" picks from`}
      right={<VbBtn kind="ghost" size="sm" icon="plus" onClick={add}>Add variation</VbBtn>}
    >
      {variations.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>
          No variations yet — add one to enable multivariate targeting.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {variations.map((v, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ width: 160 }}>
                <VbInput
                  mono
                  value={v.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="treatment_a"
                />
              </div>
              <div style={{ flex: 1 }}>
                <ValueEditor type={type} value={v.value} variations={[]} onChange={(val) => update(i, { value: val })} />
              </div>
              <VbBtn kind="danger" size="sm" icon="x" onClick={() => remove(i)} title="Remove variation" />
            </div>
          ))}
        </div>
      )}
    </Section>
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
    <Section
      title="Targeting rules"
      meta="first matching rule wins · evaluated top to bottom"
      right={<VbBtn kind="ghost" size="sm" icon="plus" onClick={add}>Add rule</VbBtn>}
    >
      {rules.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>
          No rules — every evaluation returns the default value.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rules.map((r, i) => (
            <div key={r.id} style={{
              padding: 14,
              borderRadius: 6,
              border: "1px solid var(--vb-border)",
              background: "var(--vb-bg-1)",
            }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <VbPill tone="accent">#{i + 1}</VbPill>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--vb-fg-3)" }}>{r.id}</span>
                <span style={{ flex: 1 }} />
                <VbBtn kind="ghost" size="sm" icon="arrowUp" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" />
                <VbBtn kind="ghost" size="sm" icon="arrowDown" onClick={() => move(i, 1)} disabled={i === rules.length - 1} title="Move down" />
                <VbBtn kind="danger" size="sm" icon="x" onClick={() => remove(i)} title="Remove rule" />
              </div>

              <ConditionsEditor
                conds={r.when?.all ?? []}
                onChange={(conds) => patch(i, conds.length === 0
                  ? { when: { all: [] } }
                  : { when: { all: conds } })}
              />

              <div style={{ display: "flex", gap: 14, marginTop: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ minWidth: 140 }}>
                  <VbField label="Variation">
                    {type === "bool" ? (
                      <Dropdown
                        value={r.variation}
                        options={[{ label: "true", value: "true" }, { label: "false", value: "false" }]}
                        onChange={(e) => patch(i, { variation: String(e.value) })}
                        style={{ width: "100%", height: 32 }}
                      />
                    ) : variations.length > 0 ? (
                      <Dropdown
                        value={r.variation}
                        options={variations.map((v) => ({ label: v.name, value: v.name }))}
                        onChange={(e) => patch(i, { variation: String(e.value) })}
                        style={{ width: "100%", height: 32 }}
                      />
                    ) : (
                      <VbInput mono value={r.variation} onChange={(e) => patch(i, { variation: e.target.value })} />
                    )}
                  </VbField>
                </div>
                <div style={{ width: 100 }}>
                  <VbField label="Rollout %">
                    <VbInput
                      mono
                      type="number"
                      min={0}
                      max={100}
                      value={r.rollout?.value ?? 100}
                      onChange={(e) => {
                        const n = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
                        patch(i, { rollout: { value: n, sticky: r.rollout?.sticky ?? "user.id" } });
                      }}
                    />
                  </VbField>
                </div>
                <div style={{ width: 160 }}>
                  <VbField label="Sticky attr">
                    <VbInput
                      mono
                      value={r.rollout?.sticky ?? "user.id"}
                      onChange={(e) => patch(i, { rollout: { value: r.rollout?.value ?? 100, sticky: e.target.value } })}
                    />
                  </VbField>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ConditionsEditor({ conds, onChange }: { conds: Condition[]; onChange: (conds: Condition[]) => void }) {
  function update(i: number, patch: Partial<Condition>) { onChange(conds.map((c, idx) => idx === i ? { ...c, ...patch } : c)); }
  function remove(i: number) { onChange(conds.filter((_, idx) => idx !== i)); }
  function add() { onChange([...conds, { attr: "user.id", op: "eq", value: "" }]); }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {conds.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>
          No conditions — rule matches every context.
        </div>
      ) : conds.map((c, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--vb-fg-3)",
            minWidth: 36,
            textAlign: "right",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}>{i === 0 ? "where" : "and"}</span>
          <div style={{ width: 160 }}>
            <VbInput mono value={c.attr} onChange={(e) => update(i, { attr: e.target.value })} placeholder="user.plan" />
          </div>
          <Dropdown
            value={c.op}
            options={OP_OPTIONS}
            onChange={(e) => update(i, { op: e.value as Operator })}
            style={{ minWidth: 170, height: 32 }}
          />
          {c.op !== "exists" && (
            <div style={{ flex: 1, minWidth: 160 }}>
              <VbInput
                mono
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
            </div>
          )}
          <VbBtn kind="danger" size="sm" icon="x" onClick={() => remove(i)} title="Remove condition" />
        </div>
      ))}
      <div style={{ marginTop: 4 }}>
        <VbBtn kind="ghost" size="sm" icon="plus" onClick={add}>Add condition</VbBtn>
      </div>
    </div>
  );
}
