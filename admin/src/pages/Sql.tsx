/**
 * /_/sql — Raw SQL workspace.
 *
 *   • Left rail: saved-queries list with search + "New".
 *   • Top right: Monaco SQL editor.
 *   • Bottom right: result table or error pane.
 *   • Toolbar: Run (⌘↵), mode toggle (Read-only / Sandbox), Save / Save As,
 *     Reset Sandbox, Copy SQL, Delete saved.
 *
 * Mode model:
 *   read-only — SELECT/EXPLAIN/PRAGMA against live DB.
 *   sandbox   — opt-in. Snapshot copy of the DB; mutations land there
 *               and never reach the live data.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import { CodeEditor, type SqlSchema, type SqlSchemaTable } from "../components/CodeEditor.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";
import {
  VbBtn,
  VbCode,
  VbEmptyState,
  VbField,
  VbInput,
  VbPageHeader,
  VbPill,
  FilterInput,
} from "../components/Vb.tsx";
import { Modal } from "../components/UI.tsx";

// ── types ────────────────────────────────────────────────────────────────

type Mode = "readonly" | "sandbox";

interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_run_ms: number | null;
  last_row_count: number | null;
  last_error: string | null;
}

interface RunResult {
  ok: boolean;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  error?: string;
  errorCode?: string;
  changes?: number;
}

interface SandboxInfo {
  exists: boolean;
  path: string;
  createdAt: number;
  sizeBytes: number;
  idleSec: number;
}

// ── helpers ──────────────────────────────────────────────────────────────

function relTime(unix: number | null): string {
  if (!unix) return "never";
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function renderCell(v: unknown): React.ReactNode {
  if (v === null || v === undefined) {
    return <span style={{ color: "var(--vb-text-3)", fontStyle: "italic" }}>null</span>;
  }
  if (v instanceof Uint8Array) {
    return <span style={{ color: "var(--vb-text-3)" }}>&lt;blob {v.byteLength} B&gt;</span>;
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" || typeof v === "bigint") {
    return <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-text-1)" }}>{String(v)}</span>;
  }
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.length > 200) {
    return <span title={s}>{s.slice(0, 199)}…</span>;
  }
  return s;
}

// ── Save modal ───────────────────────────────────────────────────────────

function SaveModal({ open, onClose, initial, sql, onSaved }: {
  open: boolean;
  onClose: () => void;
  /** When given, edit an existing query; otherwise create. */
  initial: SavedQuery | null;
  sql: string;
  onSaved: (q: SavedQuery) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setDescription(initial?.description ?? "");
      setBusy(false);
      setErr("");
    }
  }, [open, initial]);

  async function save(): Promise<void> {
    if (!name.trim()) { setErr("name is required"); return; }
    setBusy(true); setErr("");
    if (initial) {
      const res = await api.patch<ApiResponse<SavedQuery>>(
        `/api/v1/admin/sql/queries/${encodeURIComponent(initial.id)}`,
        { name: name.trim(), sql, description: description.trim() || null },
      );
      setBusy(false);
      if (res.error || !res.data) { setErr(res.error ?? "save failed"); return; }
      onSaved(res.data);
    } else {
      const body: { name: string; sql: string; description?: string } = {
        name: name.trim(), sql,
      };
      if (description.trim()) body.description = description.trim();
      const res = await api.post<ApiResponse<SavedQuery>>(
        `/api/v1/admin/sql/queries`, body,
      );
      setBusy(false);
      if (res.error || !res.data) { setErr(res.error ?? "save failed"); return; }
      onSaved(res.data);
    }
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={initial ? "Edit query" : "Save query"}>
      <div style={{ display: "grid", gap: 12 }}>
        <VbField label="Name">
          <VbInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Active users last 7 days"
            maxLength={100}
          />
        </VbField>
        <VbField label="Description" hint="Optional. Shown in the saved-queries list.">
          <VbInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this query answer?"
            maxLength={500}
          />
        </VbField>
        {err && (
          <div style={{ color: "var(--vb-status-danger)", fontSize: 12 }}>{err}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <VbBtn kind="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</VbBtn>
          <VbBtn kind="primary" size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : initial ? "Save changes" : "Save"}
          </VbBtn>
        </div>
      </div>
    </Modal>
  );
}

// ── Result pane ──────────────────────────────────────────────────────────

function ResultPane({ result, mode }: { result: RunResult | null; mode: Mode }) {
  if (!result) {
    return (
      <div style={{ padding: 24, color: "var(--vb-text-3)", fontSize: 13, textAlign: "center" }}>
        Run a query to see results here.
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div style={{ padding: 16, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vb-status-danger)" }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {result.errorCode ?? "ERROR"} ({result.durationMs}ms)
        </div>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{result.error}</pre>
      </div>
    );
  }

  if (result.columns.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--vb-text-2)" }}>
        ✓ Statement executed in {result.durationMs}ms
        {result.changes !== undefined && (
          <> — <strong>{result.changes}</strong> row{result.changes === 1 ? "" : "s"} changed (sandbox only)</>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{
        padding: "8px 14px",
        borderBottom: "1px solid var(--vb-border)",
        fontSize: 12, color: "var(--vb-text-3)",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <VbPill tone="success" dot>{result.rowCount} row{result.rowCount === 1 ? "" : "s"}</VbPill>
        <span>{result.durationMs}ms</span>
        <span>{result.columns.length} columns</span>
        {result.truncated && (
          <VbPill tone="warning">truncated</VbPill>
        )}
        {mode === "sandbox" && (
          <VbPill tone="accent">sandbox</VbPill>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
          fontFamily: "inherit",
        }}>
          <thead style={{ position: "sticky", top: 0, background: "var(--vb-bg-2)", zIndex: 1 }}>
            <tr>
              {result.columns.map((c) => (
                <th key={c} style={{
                  padding: "8px 12px",
                  textAlign: "left",
                  borderBottom: "1px solid var(--vb-border)",
                  color: "var(--vb-text-2)",
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "nowrap",
                }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--vb-border)" }}>
                {row.map((cell, j) => (
                  <td key={j} style={{
                    padding: "6px 12px",
                    color: "var(--vb-text-1)",
                    verticalAlign: "top",
                    maxWidth: 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}>{renderCell(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Sandbox status strip ─────────────────────────────────────────────────

function SandboxStrip({ info, busy, onReset, onDrop }: {
  info: SandboxInfo | null;
  busy: boolean;
  onReset: () => void;
  onDrop: () => void;
}) {
  if (!info?.exists) {
    return (
      <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--vb-text-3)", display: "flex", alignItems: "center", gap: 10 }}>
        No sandbox yet — first sandbox-mode run creates one. Or
        <VbBtn kind="ghost" size="sm" onClick={onReset} disabled={busy}>
          Create sandbox
        </VbBtn>
      </div>
    );
  }
  const ageMin = Math.floor(info.idleSec / 60);
  return (
    <div style={{
      padding: "8px 14px",
      fontSize: 12,
      color: "var(--vb-text-3)",
      display: "flex", alignItems: "center", gap: 10,
      flexWrap: "wrap",
    }}>
      <VbPill tone="accent" dot>
        sandbox · {formatBytes(info.sizeBytes)} · {ageMin < 1 ? "fresh" : `${ageMin}m old`}
      </VbPill>
      <span>Snapshot of live DB. Mutations land here and never persist.</span>
      <span style={{ flex: 1 }} />
      <VbBtn kind="ghost" size="sm" icon="refresh" onClick={onReset} disabled={busy}>
        Reset
      </VbBtn>
      <VbBtn kind="ghost" size="sm" icon="trash" onClick={onDrop} disabled={busy}>
        Drop
      </VbBtn>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────

const STARTER_SQL = `-- Read-only mode is the default. Switch to Sandbox to run mutations.
-- Press ⌘↵ (Ctrl+Enter) to run.

SELECT name, type FROM sqlite_master
WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
ORDER BY name;
`;

export default function SqlPage() {
  const [savedList, setSavedList] = useState<SavedQuery[]>([]);
  const [searchQ, setSearchQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sql, setSql] = useState<string>(STARTER_SQL);
  const [mode, setMode] = useState<Mode>("readonly");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTarget, setSaveTarget] = useState<SavedQuery | null>(null);
  const [sqlSchema, setSqlSchema] = useState<SqlSchema>({ tables: [] });
  const sqlRef = useRef(sql);
  const modeRef = useRef(mode);
  sqlRef.current = sql;
  modeRef.current = mode;

  // ── data load ─────────────────────────────────────────────────────────
  const loadSaved = useCallback(async () => {
    const res = await api.get<ApiResponse<SavedQuery[]>>("/api/v1/admin/sql/queries");
    if (res.data) setSavedList(res.data);
  }, []);

  const loadSandbox = useCallback(async () => {
    const res = await api.get<ApiResponse<SandboxInfo>>("/api/v1/admin/sql/sandbox");
    if (res.data) setSandbox(res.data);
  }, []);

  const loadSchema = useCallback(async () => {
    // Pull rich schema (tables + columns + indexes + FKs) from the SQL
    // endpoint. Drives Monaco's completion + hover providers.
    const res = await api.get<ApiResponse<{ tables: SqlSchemaTable[] }>>("/api/v1/admin/sql/schema");
    if (!res.data) return;
    setSqlSchema({ tables: res.data.tables });
  }, []);

  useEffect(() => {
    void loadSaved();
    void loadSandbox();
    void loadSchema();
  }, [loadSaved, loadSandbox, loadSchema]);

  // ── actions ───────────────────────────────────────────────────────────
  const run = useCallback(async () => {
    const currentSql = sqlRef.current.trim();
    if (!currentSql) return;
    setRunning(true);
    const res = await api.post<ApiResponse<RunResult>>("/api/v1/admin/sql/run", {
      sql: currentSql,
      mode: modeRef.current,
    });
    setRunning(false);
    if (res.data) {
      setResult(res.data);
      // After sandbox runs, refresh sandbox info (mtime changed).
      if (modeRef.current === "sandbox") void loadSandbox();
    } else if (res.error) {
      setResult({
        ok: false, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0,
        error: res.error,
      });
    }
  }, [loadSandbox]);

  const onRunSavedFromList = useCallback(async (q: SavedQuery) => {
    setSelectedId(q.id);
    setSql(q.sql);
    sqlRef.current = q.sql;
    setRunning(true);
    const res = await api.post<ApiResponse<RunResult>>(
      `/api/v1/admin/sql/queries/${encodeURIComponent(q.id)}/run`,
      { mode: modeRef.current },
    );
    setRunning(false);
    if (res.data) setResult(res.data);
    void loadSaved(); // last_run_* updated
  }, [loadSaved]);

  // Keyboard shortcut: ⌘↵ / Ctrl+↵ runs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  const selectQuery = useCallback((q: SavedQuery) => {
    setSelectedId(q.id);
    setSql(q.sql);
    setResult(null);
  }, []);

  const newQuery = useCallback(() => {
    setSelectedId(null);
    setSql("-- New query\nSELECT 1;\n");
    setResult(null);
  }, []);

  const onSaveClick = useCallback(() => {
    setSaveTarget(savedList.find((q) => q.id === selectedId) ?? null);
    setSaveOpen(true);
  }, [savedList, selectedId]);

  const onSaveAsClick = useCallback(() => {
    setSaveTarget(null);
    setSaveOpen(true);
  }, []);

  const onSaved = useCallback((q: SavedQuery) => {
    void loadSaved();
    setSelectedId(q.id);
    toast(`Saved “${q.name}”`, "check");
  }, [loadSaved]);

  const onDeleteSaved = useCallback(async (q: SavedQuery) => {
    const ok = await confirm({
      title: "Delete saved query",
      message: `Delete "${q.name}"? This can't be undone.`,
      danger: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<{ deleted: boolean }>>(
      `/api/v1/admin/sql/queries/${encodeURIComponent(q.id)}`,
    );
    if (res.error) { toast(`Delete failed: ${res.error}`, "info"); return; }
    if (selectedId === q.id) { setSelectedId(null); setSql(STARTER_SQL); }
    void loadSaved();
    toast("Deleted", "check");
  }, [loadSaved, selectedId]);

  const onCopySaved = useCallback((q: SavedQuery) => {
    void navigator.clipboard.writeText(q.sql);
    toast("SQL copied", "check");
  }, []);

  const resetSandbox = useCallback(async () => {
    setSandboxBusy(true);
    const res = await api.post<ApiResponse<SandboxInfo>>("/api/v1/admin/sql/sandbox/reset", {});
    setSandboxBusy(false);
    if (res.data) {
      setSandbox(res.data);
      toast("Sandbox refreshed from live DB", "check");
    } else if (res.error) {
      toast(`Sandbox reset failed: ${res.error}`, "info");
    }
  }, []);

  const dropSandbox = useCallback(async () => {
    setSandboxBusy(true);
    const res = await api.delete<ApiResponse<{ removed: boolean }>>("/api/v1/admin/sql/sandbox");
    setSandboxBusy(false);
    if (res.data) {
      void loadSandbox();
      toast("Sandbox dropped", "check");
    }
  }, [loadSandbox]);

  // ── render ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!searchQ.trim()) return savedList;
    const n = searchQ.toLowerCase();
    return savedList.filter((q) =>
      q.name.toLowerCase().includes(n) ||
      (q.description ?? "").toLowerCase().includes(n) ||
      q.sql.toLowerCase().includes(n),
    );
  }, [savedList, searchQ]);

  const selectedQuery = savedList.find((q) => q.id === selectedId) ?? null;

  return (
    <>
      <VbPageHeader
        title="SQL"
        sub="Run raw SQL against your database. Read-only against the live DB by default; switch to Sandbox to test mutations safely."
        right={
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {savedList.length > 0 && (
              <VbPill tone="neutral">{savedList.length} saved</VbPill>
            )}
          </span>
        }
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0, height: "calc(100vh - 110px)" }}>
        {/* Left rail */}
        <aside style={{
          width: 280,
          minWidth: 280,
          borderRight: "1px solid var(--vb-border)",
          background: "var(--vb-bg-1)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}>
          <div style={{ padding: "12px 12px 8px", display: "flex", gap: 6 }}>
            <FilterInput
              placeholder="Search saved…"
              value={searchQ}
              onChange={setSearchQ}
              width="100%"
            />
          </div>
          <div style={{ padding: "0 12px 8px" }}>
            <VbBtn kind="ghost" size="sm" icon="plus" onClick={newQuery}>
              New query
            </VbBtn>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 6px 12px" }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: "var(--vb-text-3)", textAlign: "center" }}>
                {savedList.length === 0 ? "No saved queries yet" : "No matches"}
              </div>
            ) : filtered.map((q) => (
              <div
                key={q.id}
                onClick={() => selectQuery(q)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 5,
                  cursor: "pointer",
                  display: "flex", flexDirection: "column", gap: 2,
                  background: selectedId === q.id ? "var(--vb-bg-3)" : "transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--vb-text-1)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {q.name}
                  </span>
                  <span style={{ display: "flex", gap: 2 }}>
                    <VbBtn
                      kind="ghost" size="sm" icon="play"
                      onClick={(e) => { e.stopPropagation(); void onRunSavedFromList(q); }}
                      title="Run"
                    />
                    <VbBtn
                      kind="ghost" size="sm" icon="copy"
                      onClick={(e) => { e.stopPropagation(); onCopySaved(q); }}
                      title="Copy SQL"
                    />
                    <VbBtn
                      kind="ghost" size="sm" icon="trash"
                      onClick={(e) => { e.stopPropagation(); void onDeleteSaved(q); }}
                      title="Delete"
                    />
                  </span>
                </div>
                <span style={{ fontSize: 11, color: "var(--vb-text-3)", display: "flex", gap: 8 }}>
                  <span>last run {relTime(q.last_run_at)}</span>
                  {q.last_error
                    ? <span style={{ color: "var(--vb-status-danger)" }}>err</span>
                    : q.last_row_count !== null
                    ? <span>{q.last_row_count} rows</span>
                    : null}
                </span>
              </div>
            ))}
          </div>
        </aside>

        {/* Right: editor + results */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* Toolbar */}
          <div style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--vb-border)",
            display: "flex", alignItems: "center", gap: 10,
            background: "var(--vb-bg-1)",
            flexWrap: "wrap",
          }}>
            <VbBtn
              kind="primary" size="sm" icon="play"
              onClick={() => void run()}
              disabled={running || !sql.trim()}
            >
              {running ? "Running…" : "Run"}
              <span style={{ marginLeft: 8, fontSize: 10, opacity: 0.7, fontFamily: "var(--font-mono)" }}>
                ⌘↵
              </span>
            </VbBtn>

            <ModeToggle mode={mode} onChange={setMode} />

            <span style={{ flex: 1 }} />

            {selectedQuery ? (
              <VbBtn kind="ghost" size="sm" icon="check" onClick={onSaveClick}>
                Save changes
              </VbBtn>
            ) : null}
            <VbBtn kind="ghost" size="sm" icon="plus" onClick={onSaveAsClick}>
              {selectedQuery ? "Save as…" : "Save"}
            </VbBtn>
          </div>

          {/* Sandbox strip — only when sandbox mode is active */}
          {mode === "sandbox" && (
            <div style={{ borderBottom: "1px solid var(--vb-border)", background: "var(--vb-bg-2)" }}>
              <SandboxStrip
                info={sandbox}
                busy={sandboxBusy}
                onReset={() => void resetSandbox()}
                onDrop={() => void dropSandbox()}
              />
            </div>
          )}

          {/* Editor + results: split vertically */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ flex: 1, minHeight: 200, borderBottom: "1px solid var(--vb-border)" }}>
              <CodeEditor
                value={sql}
                onChange={setSql}
                language="sql"
                sqlSchema={sqlSchema}
                height="100%"
              />
            </div>
            <div style={{ flex: 1, minHeight: 200, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              {result === null && !running ? (
                <div style={{ padding: 24, color: "var(--vb-text-3)", fontSize: 13, textAlign: "center" }}>
                  <VbEmptyState
                    icon="play"
                    title="No results yet"
                    body={<>Press <VbCode>⌘↵</VbCode> or click Run to execute the query.</>}
                  />
                </div>
              ) : (
                <ResultPane result={result} mode={mode} />
              )}
            </div>
          </div>
        </main>
      </div>

      <SaveModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        initial={saveTarget}
        sql={sql}
        onSaved={onSaved}
      />
    </>
  );
}

// ── Mode toggle (segmented control) ──────────────────────────────────────

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div style={{
      display: "inline-flex",
      border: "1px solid var(--vb-border)",
      borderRadius: 5,
      overflow: "hidden",
      fontSize: 12,
    }}>
      <button
        type="button"
        onClick={() => onChange("readonly")}
        style={{
          padding: "5px 10px",
          background: mode === "readonly" ? "var(--vb-bg-3)" : "transparent",
          color: mode === "readonly" ? "var(--vb-text-1)" : "var(--vb-text-3)",
          fontWeight: mode === "readonly" ? 600 : 400,
          border: 0, fontFamily: "inherit", cursor: "pointer",
        }}
        title="SELECT/EXPLAIN/PRAGMA against live DB. Mutations rejected."
      >
        Read-only
      </button>
      <button
        type="button"
        onClick={() => onChange("sandbox")}
        style={{
          padding: "5px 10px",
          background: mode === "sandbox" ? "var(--vb-accent-soft, rgba(232,90,79,0.16))" : "transparent",
          color: mode === "sandbox" ? "var(--vb-accent)" : "var(--vb-text-3)",
          fontWeight: mode === "sandbox" ? 600 : 400,
          border: 0, borderLeft: "1px solid var(--vb-border)",
          fontFamily: "inherit", cursor: "pointer",
        }}
        title="Snapshot copy of the DB. Mutations land in the sandbox, never persist."
      >
        Sandbox
      </button>
    </div>
  );
}
