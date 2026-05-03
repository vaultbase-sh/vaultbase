import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Chips } from "primereact/chips";
import { api, AUTH_IMPLICIT_FIELDS, AUTH_RESERVED_FIELD_NAMES, type ApiResponse, type Collection, type FieldDef, parseFields } from "../api.ts";
import { Modal, Toggle } from "../components/UI.tsx";
import { VbBtn, VbField, VbInput, VbPill, FieldTypePill } from "../components/Vb.tsx";
import Icon from "../components/Icon.tsx";
import { CodeEditor, type SqlSchema } from "../components/CodeEditor.tsx";

const FIELD_TYPES: FieldDef["type"][] = ["text", "number", "bool", "email", "url", "date", "file", "relation", "select", "json"];

const SYSTEM_FIELDS: FieldDef[] = [
  { name: "id",      type: "text",     required: true, system: true },
  { name: "created", type: "autodate", required: true, system: true },
  { name: "updated", type: "autodate", required: true, system: true },
];

function cleanFieldName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function cleanCollName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

const TYPE_DESCRIPTIONS: Record<"base" | "auth" | "view", (name: string) => React.ReactNode> = {
  base: (name) => <>Standard records collection. CRUD via <Code>/api/{name || "name"}</Code>.</>,
  auth: (name) => <>Email + password sign-up via <Code>/api/v1/auth/{name || "name"}/register</Code>. Field names <Code>email</Code>, <Code>password</Code>, <Code>verified</Code> are managed by the implicit auth schema and cannot be redefined.</>,
  view: () => <>Read-only collection backed by a SQL <Code>SELECT</Code>. Defaults to admin-only access — open it up via the API rules after creation. Writes return 405.</>,
};

export default function NewCollectionModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"base" | "auth" | "view">("base");
  const [fields, setFields] = useState<FieldDef[]>(SYSTEM_FIELDS);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [allCollections, setAllCollections] = useState<Collection[]>([]);
  const [viewQuery, setViewQuery] = useState("");
  const [viewError, setViewError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const sqlSchema: SqlSchema = useMemo(() => ({
    tables: allCollections.map((c) => {
      const cols = ["id", "created_at", "updated_at"];
      for (const f of parseFields(c.fields)) {
        if (f.implicit && c.type === "auth") continue;
        if (f.system) continue;
        cols.push(f.name);
      }
      return { name: `vb_${c.name}`, collectionName: c.name, columns: cols };
    }),
  }), [allCollections]);

  async function validateView() {
    if (!viewQuery.trim()) { setViewError("Empty query"); return; }
    setValidating(true);
    const res = await api.post<ApiResponse<{ columns: string[]; fields: FieldDef[] }>>(
      "/api/v1/admin/collections/preview-view",
      { view_query: viewQuery.trim() }
    );
    setValidating(false);
    if (res.error) { setViewError(res.error); return; }
    setViewError(null);
  }

  useEffect(() => {
    if (open) {
      setName("");
      setType("base");
      setFields(SYSTEM_FIELDS);
      setExpanded(null);
      setError("");
      setLoading(false);
      setViewQuery("");
      api.get<ApiResponse<Collection[]>>("/api/v1/collections").then((res) => {
        if (res.data) setAllCollections(res.data);
      });
    }
  }, [open]);

  useEffect(() => {
    setFields((prev) => {
      const userFields = prev.filter((f) => !f.system && !f.implicit);
      if (type === "auth") {
        return [...AUTH_IMPLICIT_FIELDS, ...userFields, ...SYSTEM_FIELDS];
      }
      if (type === "view") {
        return SYSTEM_FIELDS;
      }
      return [...userFields, ...SYSTEM_FIELDS];
    });
    setExpanded(null);
  }, [type]);

  const collectionNames = useMemo(
    () => allCollections.map((c) => c.name),
    [allCollections]
  );

  function addField(t: FieldDef["type"]) {
    const newField: FieldDef = { name: "", type: t, required: false, options: {} };
    setFields((fs) => [...fs.slice(0, -2), newField, ...fs.slice(-2)]);
    setExpanded(fields.length - 2);
  }

  function patchField(i: number, patch: Partial<FieldDef>) {
    setFields((fs) => fs.map((f, xi) => (xi === i ? { ...f, ...patch } : f)));
  }

  function patchOptions(i: number, patch: Record<string, unknown>) {
    setFields((fs) =>
      fs.map((f, xi) =>
        xi === i ? { ...f, options: { ...(f.options ?? {}), ...patch } } : f
      )
    );
  }

  function removeField(i: number) {
    setFields((fs) => fs.filter((_, xi) => xi !== i));
    if (expanded === i) setExpanded(null);
    else if (expanded !== null && expanded > i) setExpanded(expanded - 1);
  }

  async function handleCreate() {
    const collName = cleanCollName(name);
    if (!collName) return;

    if (type === "view") {
      if (!viewQuery.trim()) { setError("View collections require a SELECT query."); return; }
      setError("");
      setLoading(true);
      const res = await api.post<ApiResponse<Collection>>("/api/v1/collections", {
        name: collName,
        type,
        view_query: viewQuery.trim(),
      });
      setLoading(false);
      if (res.error) { setError(res.error); return; }
      onCreate(collName);
      return;
    }

    const userFields = fields.filter((f) => !f.system);
    const unnamed = userFields.filter((f) => !f.name);
    if (unnamed.length > 0) { setError("All fields must have a name."); return; }
    const badSelect = userFields.find(
      (f) => f.type === "select" && (!Array.isArray(f.options?.values) || (f.options?.values as string[]).length === 0)
    );
    if (badSelect) { setError(`Select field '${badSelect.name}' must have at least one allowed value.`); return; }
    const badRelation = userFields.find((f) => f.type === "relation" && !f.collection);
    if (badRelation) { setError(`Relation field '${badRelation.name}' must have a target collection.`); return; }
    if (type === "auth") {
      const reserved = new Set<string>(AUTH_RESERVED_FIELD_NAMES);
      const clash = userFields.find((f) => !f.implicit && reserved.has(f.name));
      if (clash) {
        setError(`'${clash.name}' is reserved on auth collections — managed by the implicit auth schema.`);
        return;
      }
    }
    setError("");
    setLoading(true);
    const res = await api.post<ApiResponse<Collection>>("/api/v1/collections", {
      name: collName,
      type,
      fields: userFields,
    });
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    onCreate(collName);
  }

  const collName = cleanCollName(name);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New collection"
      width={680}
      footer={
        <>
          <VbBtn kind="ghost" size="md" onClick={onClose}>Cancel</VbBtn>
          <VbBtn
            kind="primary"
            size="md"
            icon="check"
            disabled={!collName || loading}
            onClick={handleCreate}
          >
            {loading ? "Creating…" : "Create collection"}
          </VbBtn>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {error && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--vb-status-danger)",
            fontSize: 12,
            padding: "8px 12px",
            background: "var(--vb-status-danger-bg)",
            border: "1px solid rgba(232,90,79,0.3)",
            borderRadius: 6,
          }}>
            <Icon name="alert" size={12} />
            <span>{error}</span>
          </div>
        )}

        <VbField
          label="Name"
          hint={
            <>
              {name && collName !== name && (
                <span>Stored as <Code>{collName}</Code> · </span>
              )}
              API path: <Code>/api/{collName || "name"}</Code>
            </>
          }
        >
          <VbInput
            mono
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my_collection"
            autoFocus
          />
        </VbField>

        <VbField label="Type" hint={TYPE_DESCRIPTIONS[type](collName)}>
          <div style={{ display: "flex", gap: 8 }}>
            {(["base", "auth", "view"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                style={{
                  appearance: "none",
                  flex: 1,
                  height: 36,
                  borderRadius: 5,
                  border: "1px solid",
                  borderColor: type === t ? "transparent" : "var(--vb-border-2)",
                  background: type === t ? "var(--vb-accent)" : "var(--vb-bg-3)",
                  color: type === t ? "#fff" : "var(--vb-fg-2)",
                  fontFamily: "inherit",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  textTransform: "capitalize",
                  transition: "background 100ms",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </VbField>

        {type === "view" && (
          <VbField label="SELECT query" hint={
            <>Single SELECT only · autocomplete for <Code>vb_*</Code> tables and columns · backed by VIEW <Code>vb_{collName || "name"}</Code>.</>
          } right={
            <VbBtn kind="ghost" size="sm" icon="play" onClick={validateView} disabled={validating}>
              {validating ? "Validating…" : "Validate"}
            </VbBtn>
          }>
            <div style={{
              border: "1px solid var(--vb-border-2)",
              borderRadius: 5,
              overflow: "hidden",
              background: "var(--vb-bg-3)",
            }}>
              <CodeEditor
                language="sql"
                value={viewQuery}
                onChange={(v) => { setViewQuery(v); setViewError(null); }}
                sqlSchema={sqlSchema}
                markers={viewError ? [{ message: viewError, line: 1, severity: "error" }] : []}
                height={200}
              />
            </div>
          </VbField>
        )}

        {type !== "view" && (
          <div>
            <div style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <span style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color: "var(--vb-fg-2)",
                fontFamily: "var(--font-mono)",
              }}>Schema</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vb-fg-3)" }}>
                {fields.length} fields
              </span>
            </div>

            <div style={{
              border: "1px solid var(--vb-border)",
              borderRadius: 8,
              overflow: "hidden",
              background: "var(--vb-bg-2)",
            }}>
              {fields.map((f, i) => {
                const locked = f.system || f.implicit;
                const isExpanded = expanded === i;
                return (
                  <div
                    key={i}
                    style={{
                      borderBottom: i === fields.length - 1 ? "none" : "1px solid var(--vb-border)",
                    }}
                  >
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "9px 12px",
                      background: isExpanded ? "var(--vb-bg-3)" : "transparent",
                      opacity: locked ? 0.7 : 1,
                    }}>
                      <span style={{ color: "var(--vb-fg-3)", flexShrink: 0, display: "inline-flex" }}>
                        <Icon name="grip" size={12} />
                      </span>

                      {locked ? (
                        <span style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          color: "var(--vb-fg)",
                          minWidth: 130,
                        }}>{f.name}</span>
                      ) : (
                        <div style={{ width: 150 }}>
                          <input
                            value={f.name}
                            onChange={(e) => patchField(i, { name: cleanFieldName(e.target.value) })}
                            onClick={(e) => e.stopPropagation()}
                            placeholder="field_name"
                            style={{
                              width: "100%",
                              height: 28,
                              padding: "0 8px",
                              background: "var(--vb-bg-1)",
                              border: "1px solid var(--vb-border-2)",
                              borderRadius: 4,
                              color: "var(--vb-fg)",
                              fontFamily: "var(--font-mono)",
                              fontSize: 12,
                              outline: "none",
                            }}
                          />
                        </div>
                      )}

                      {locked ? (
                        <FieldTypePill type={f.type} />
                      ) : (
                        <Dropdown
                          value={f.type}
                          options={FIELD_TYPES}
                          onChange={(e) => { e.originalEvent?.stopPropagation(); patchField(i, { type: e.value as FieldDef["type"], options: {} }); }}
                          style={{ height: 28, minWidth: 110, fontSize: 12 }}
                          panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                        />
                      )}

                      {!locked && (
                        <label
                          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--vb-fg-2)", cursor: "pointer" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Toggle on={f.required ?? false} onChange={(v) => patchField(i, { required: v })} />
                          <span>req</span>
                        </label>
                      )}

                      {locked ? (
                        <span style={{
                          marginLeft: "auto",
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          color: "var(--vb-fg-3)",
                          textTransform: "uppercase",
                          letterSpacing: 0.6,
                        }}>{f.implicit ? "implicit" : "system"}</span>
                      ) : (
                        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
                          <VbBtn
                            kind="ghost"
                            size="sm"
                            icon={isExpanded ? "chevronDown" : "chevronRight"}
                            onClick={() => setExpanded(isExpanded ? null : i)}
                            title={isExpanded ? "Hide options" : "Show options"}
                          />
                          <VbBtn
                            kind="danger"
                            size="sm"
                            icon="x"
                            onClick={() => removeField(i)}
                            title="Remove field"
                          />
                        </span>
                      )}
                    </div>

                    {isExpanded && !locked && (
                      <FieldOptionsPanel
                        field={f}
                        onPatchOptions={(patch) => patchOptions(i, patch)}
                        onPatchField={(patch) => patchField(i, patch)}
                        collectionNames={collectionNames}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{
              marginTop: 8,
              border: "1px solid var(--vb-border)",
              borderRadius: 8,
              padding: "10px 12px",
              background: "var(--vb-bg-2)",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}>
              <span style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color: "var(--vb-fg-3)",
                fontFamily: "var(--font-mono)",
                marginRight: 4,
              }}>Add field</span>
              {FIELD_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => addField(t)}
                  style={{
                    appearance: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "4px 9px",
                    borderRadius: 4,
                    border: "1px dashed var(--vb-border-2)",
                    background: "transparent",
                    color: "var(--vb-fg-2)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    cursor: "pointer",
                    transition: "background 100ms, border-color 100ms",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--vb-bg-3)";
                    e.currentTarget.style.borderColor = "var(--vb-accent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "var(--vb-border-2)";
                  }}
                >
                  <Icon name="plus" size={10} />{t}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
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

// ── Per-field options panel ──────────────────────────────────────────────────
function FieldOptionsPanel({
  field,
  onPatchOptions,
  onPatchField,
  collectionNames,
}: {
  field: FieldDef;
  onPatchOptions: (patch: Record<string, unknown>) => void;
  onPatchField: (patch: Partial<FieldDef>) => void;
  collectionNames: string[];
}) {
  const opts = (field.options ?? {}) as Record<string, unknown>;

  function numOrUndef(v: string): number | undefined {
    if (v === "") return undefined;
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  }

  return (
    <div style={{
      padding: "12px 14px 14px 38px",
      background: "var(--vb-bg-1)",
      borderTop: "1px solid var(--vb-border)",
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}>
      {/* Text / Email / URL */}
      {(field.type === "text" || field.type === "email" || field.type === "url") && (
        <>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <VbField label="Min length">
                <VbInput
                  mono
                  type="number"
                  min={0}
                  value={(opts["min"] as number | undefined) ?? ""}
                  onChange={(e) => onPatchOptions({ min: numOrUndef(e.target.value) })}
                  placeholder="0"
                />
              </VbField>
            </div>
            <div style={{ flex: 1 }}>
              <VbField label="Max length">
                <VbInput
                  mono
                  type="number"
                  min={0}
                  value={(opts["max"] as number | undefined) ?? ""}
                  onChange={(e) => onPatchOptions({ max: numOrUndef(e.target.value) })}
                  placeholder="—"
                />
              </VbField>
            </div>
          </div>
          {field.type === "text" && (
            <VbField label="Regex pattern">
              <VbInput
                mono
                value={(opts["pattern"] as string | undefined) ?? ""}
                onChange={(e) => onPatchOptions({ pattern: e.target.value || undefined })}
                placeholder="^[a-z0-9-]+$"
              />
            </VbField>
          )}
          <UniqueToggle opts={opts} onPatchOptions={onPatchOptions} />
        </>
      )}

      {/* Number */}
      {field.type === "number" && (
        <>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <VbField label="Min value">
                <VbInput
                  mono
                  type="number"
                  value={(opts["min"] as number | undefined) ?? ""}
                  onChange={(e) => onPatchOptions({ min: numOrUndef(e.target.value) })}
                  placeholder="—"
                />
              </VbField>
            </div>
            <div style={{ flex: 1 }}>
              <VbField label="Max value">
                <VbInput
                  mono
                  type="number"
                  value={(opts["max"] as number | undefined) ?? ""}
                  onChange={(e) => onPatchOptions({ max: numOrUndef(e.target.value) })}
                  placeholder="—"
                />
              </VbField>
            </div>
          </div>
          <UniqueToggle opts={opts} onPatchOptions={onPatchOptions} />
        </>
      )}

      {/* Select */}
      {field.type === "select" && (
        <>
          <VbField label="Allowed values">
            <Chips
              value={Array.isArray(opts["values"]) ? (opts["values"] as string[]) : []}
              onChange={(e) => onPatchOptions({ values: e.value ?? [] })}
              placeholder="Type a value and press Enter"
              separator=","
              style={{ width: "100%" }}
            />
          </VbField>
          <ToggleRow
            on={!!opts["multiple"]}
            onChange={(v) => onPatchOptions({ multiple: v })}
            label="Allow multiple values"
          />
        </>
      )}

      {/* Relation */}
      {field.type === "relation" && (
        <VbField label="Target collection">
          {collectionNames.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
              No other collections yet. Create the target collection first.
            </div>
          ) : (
            <Dropdown
              value={field.collection ?? null}
              options={collectionNames}
              onChange={(e) => onPatchField({ collection: e.value })}
              placeholder="Select a collection…"
              filter
              showClear
              style={{ width: "100%", height: 32 }}
              panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
          )}
        </VbField>
      )}

      {/* File */}
      {field.type === "file" && (
        <>
          <VbField label="Max size (bytes)">
            <VbInput
              mono
              type="number"
              min={0}
              value={(opts["maxSize"] as number | undefined) ?? ""}
              onChange={(e) => onPatchOptions({ maxSize: numOrUndef(e.target.value) })}
              placeholder="5242880 = 5MB"
            />
          </VbField>
          <VbField label="Allowed MIME types">
            <Chips
              value={Array.isArray(opts["mimeTypes"]) ? (opts["mimeTypes"] as string[]) : []}
              onChange={(e) => onPatchOptions({ mimeTypes: e.value ?? [] })}
              placeholder="image/* — press Enter"
              separator=","
              style={{ width: "100%" }}
            />
          </VbField>
        </>
      )}

      {(field.type === "bool" || field.type === "date" || field.type === "json") && (
        <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
          No additional options for this type.
          {field.type === "bool" && <> <VbPill tone="neutral">true / false</VbPill></>}
        </div>
      )}
    </div>
  );
}

function ToggleRow({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--vb-fg-2)", cursor: "pointer" }}>
      <Toggle on={on} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function UniqueToggle({
  opts,
  onPatchOptions,
}: {
  opts: Record<string, unknown>;
  onPatchOptions: (patch: Record<string, unknown>) => void;
}) {
  return (
    <ToggleRow
      on={!!opts["unique"]}
      onChange={(v) => onPatchOptions({ unique: v })}
      label="Unique — reject duplicate values"
    />
  );
}
