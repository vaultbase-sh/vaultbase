import React, { useEffect, useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import { Modal } from "../components/UI.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";
import Icon from "../components/Icon.tsx";
import {
  VbBtn,
  VbCode,
  VbEmptyState,
  VbField,
  VbInput,
  VbPageHeader,
  VbPill,
  VbTable,
  type VbTableColumn,
} from "../components/Vb.tsx";

interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  created_by: string;
  created_by_email: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  last_used_ua: string | null;
  use_count: number;
  status: "active" | "revoked" | "expired";
}

interface MintResponse {
  id: string;
  token: string;
  expires_at: number;
  warning: string;
}

const TTL_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "30 days",   seconds: 30 * 86400 },
  { label: "90 days",   seconds: 90 * 86400 },
  { label: "180 days",  seconds: 180 * 86400 },
  { label: "1 year",    seconds: 365 * 86400 },
  { label: "2 years",   seconds: 2 * 365 * 86400 },
  { label: "5 years",   seconds: 5 * 365 * 86400 },
];

const SCOPE_OPTIONS = [
  { id: "admin",     label: "admin",     description: "Full admin equivalent — use sparingly" },
  { id: "read",      label: "read",      description: "Any GET on records / files / logs" },
  { id: "write",     label: "write",     description: "POST/PATCH/DELETE on records" },
  { id: "mcp:read",  label: "mcp:read",  description: "MCP server: read-only tools" },
  { id: "mcp:write", label: "mcp:write", description: "MCP server: mutating tools" },
  { id: "mcp:admin", label: "mcp:admin", description: "MCP server: full admin tools" },
  { id: "mcp:sql",   label: "mcp:sql",   description: "MCP server: raw SQL tool" },
];

function relTime(unix: number | null): string {
  if (!unix) return "—";
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 0) {
    const f = -diff;
    if (f < 60) return `in ${f}s`;
    if (f < 3600) return `in ${Math.floor(f / 60)}m`;
    if (f < 86400) return `in ${Math.floor(f / 3600)}h`;
    return `in ${Math.floor(f / 86400)}d`;
  }
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function ModalErrorBar({ message }: { message: string }) {
  return (
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
      <span>{message}</span>
    </div>
  );
}

function ModalWarningBar({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      color: "var(--vb-status-warning)",
      fontSize: 12,
      padding: "8px 12px",
      background: "var(--vb-status-warning-bg)",
      border: "1px solid rgba(245,158,11,0.30)",
      borderRadius: 6,
      lineHeight: 1.5,
    }}>
      <Icon name="alert" size={12} />
      <span>{children}</span>
    </div>
  );
}

function ScopePills({ scopes }: { scopes: string[] }) {
  return (
    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {scopes.map((s) => <VbPill key={s} tone={s.startsWith("mcp:") ? "accent" : s === "admin" ? "danger" : s === "write" ? "warning" : "neutral"}>{s}</VbPill>)}
    </span>
  );
}

function StatusPill({ status }: { status: TokenRow["status"] }) {
  if (status === "active")  return <VbPill tone="success" dot>active</VbPill>;
  if (status === "expired") return <VbPill tone="neutral" dot>expired</VbPill>;
  return <VbPill tone="danger" dot>revoked</VbPill>;
}

// ── Mint modal ────────────────────────────────────────────────────────────

function MintTokenModal({ open, onClose, onMinted }: {
  open: boolean;
  onClose: () => void;
  onMinted: () => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [ttlSec, setTtlSec] = useState<number>(90 * 86400);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string>("");
  const [minted, setMinted] = useState<MintResponse | null>(null);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (open) {
      setName("");
      setScopes([]);
      setTtlSec(90 * 86400);
      setMinting(false);
      setError("");
      setMinted(null);
    }
  }, [open]);

  async function handleMint(): Promise<void> {
    if (!name.trim()) { setError("name is required"); return; }
    if (scopes.length === 0) { setError("pick at least one scope"); return; }
    setMinting(true);
    setError("");
    const res = await api.post<ApiResponse<MintResponse>>(`/api/v1/admin/api-tokens`, {
      name: name.trim(),
      scopes,
      ttl_seconds: ttlSec,
    });
    setMinting(false);
    if (res.error || !res.data) { setError(res.error ?? "mint failed"); return; }
    setMinted(res.data);
    onMinted();
  }

  function copyToken(): void {
    if (!minted) return;
    void navigator.clipboard.writeText(minted.token);
    toast("Token copied", "check");
  }

  function toggleScope(id: string): void {
    setScopes((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!minting) onClose(); }}
      title={minted ? "Token minted — save it now" : "Mint API token"}
      width={520}
      footer={
        minted ? (
          <VbBtn kind="primary" size="sm" icon="check" onClick={onClose}>Done</VbBtn>
        ) : (
          <>
            <VbBtn kind="ghost" size="sm" onClick={onClose} disabled={minting}>Cancel</VbBtn>
            <VbBtn kind="primary" size="sm" icon="key" onClick={handleMint} disabled={minting}>
              {minting ? "Minting…" : "Mint token"}
            </VbBtn>
          </>
        )
      }
    >
      {minted ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ModalWarningBar>
            This token will <strong>never be shown again</strong>. Save it now to your password manager / CI secret store.
          </ModalWarningBar>
          <div style={{
            background: "var(--vb-code-bg)",
            border: "1px solid var(--vb-border-2)",
            borderRadius: 6,
            padding: "12px 14px",
          }}>
            <code style={{
              wordBreak: "break-all",
              fontSize: 12,
              lineHeight: 1.55,
              display: "block",
              fontFamily: "var(--font-mono)",
              color: "var(--vb-code-fg)",
            }}>{minted.token}</code>
          </div>
          <div>
            <VbBtn kind="soft" size="sm" icon="copy" onClick={copyToken}>Copy token</VbBtn>
          </div>
          <div style={{ fontSize: 11, color: "var(--vb-text-3)" }}>
            Expires {new Date(minted.expires_at * 1000).toISOString()} · id <VbCode>{minted.id.slice(0, 12)}…</VbCode>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {error && <ModalErrorBar message={error} />}
          <VbField
            label="Name"
            hint="Shown in the audit log + token list. Use a name that names the consumer ('CI deploy bot', 'Cursor laptop')."
          >
            <VbInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="CI deploy bot"
              autoFocus
            />
          </VbField>

          <VbField
            label="Scopes"
            hint={<>Pick the narrowest set the consumer needs. <VbCode>admin</VbCode> implies every other scope; <VbCode>mcp:admin</VbCode> implies every <VbCode>mcp:*</VbCode>.</>}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {SCOPE_OPTIONS.map((s) => {
                const checked = scopes.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleScope(s.id)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 10px",
                      background: checked ? "var(--vb-accent-soft)" : "var(--vb-bg-3)",
                      border: `1px solid ${checked ? "var(--vb-accent)" : "var(--vb-border-2)"}`,
                      borderRadius: 6,
                      textAlign: "left",
                      cursor: "pointer",
                      transition: "background 120ms ease, border-color 120ms ease",
                    }}
                  >
                    <span style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      border: `1px solid ${checked ? "var(--vb-accent)" : "var(--vb-border-3)"}`,
                      background: checked ? "var(--vb-accent)" : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      marginTop: 2,
                    }}>
                      {checked && <Icon name="check" size={9} stroke={3} style={{ color: "white" }} />}
                    </span>
                    <span style={{ flex: 1, lineHeight: 1.4 }}>
                      <span style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        fontWeight: 500,
                        color: "var(--vb-text-1)",
                      }}>{s.label}</span>
                      <span style={{
                        fontSize: 11,
                        color: "var(--vb-text-3)",
                        marginLeft: 8,
                      }}>{s.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </VbField>

          <VbField
            label="Lifetime"
            hint="Maximum 10 years. Best practice: rotate annually for production tokens."
          >
            <select
              value={ttlSec}
              onChange={(e) => setTtlSec(parseInt(e.target.value, 10))}
              style={{
                width: "100%",
                height: 32,
                padding: "0 10px",
                background: "var(--vb-bg-3)",
                border: "1px solid var(--vb-border-2)",
                borderRadius: 6,
                color: "var(--vb-text-1)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {TTL_PRESETS.map((p) => <option key={p.seconds} value={p.seconds}>{p.label}</option>)}
            </select>
          </VbField>
        </div>
      )}
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function ApiTokensPage() {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mintOpen, setMintOpen] = useState(false);
  const [detail, setDetail] = useState<TokenRow | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await api.get<ApiResponse<TokenRow[]>>(`/api/v1/admin/api-tokens`);
    if (res.data) setRows(res.data);
    setLoading(false);
  }
  useEffect(() => { void reload(); }, []);

  async function handleRevoke(r: TokenRow): Promise<void> {
    const ok = await confirm({
      title: `Revoke ${r.name}?`,
      message: `Revocation is immediate. The next request bearing this token returns 401.`,
      danger: true,
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<{ revoked: boolean }>>(`/api/v1/admin/api-tokens/${encodeURIComponent(r.id)}`);
    if (res.error) { toast(`Revoke failed: ${res.error}`, "info"); return; }
    toast(`Revoked ${r.name}`, "check");
    setDetail(null);
    void reload();
  }

  const columns: VbTableColumn<TokenRow>[] = [
    {
      key: "name",
      label: "Name",
      flex: 2,
      render: (r) => <span style={{ fontWeight: 500, color: "var(--vb-text-1)" }}>{r.name}</span>,
    },
    {
      key: "scopes",
      label: "Scopes",
      flex: 2,
      render: (r) => <ScopePills scopes={r.scopes} />,
    },
    {
      key: "status",
      label: "Status",
      width: 110,
      render: (r) => <StatusPill status={r.status} />,
    },
    {
      key: "last_used",
      label: "Last used",
      width: 110,
      render: (r) => <span style={{ color: "var(--vb-text-3)", fontSize: 12 }}>{relTime(r.last_used_at)}</span>,
    },
    {
      key: "expires",
      label: "Expires",
      width: 110,
      render: (r) => <span style={{ color: "var(--vb-text-3)", fontSize: 12 }}>{relTime(r.expires_at)}</span>,
    },
    {
      key: "actions",
      label: "",
      width: 60,
      render: (r) => (
        r.status === "active" ? (
          <VbBtn
            kind="ghost"
            size="sm"
            icon="trash"
            onClick={(e) => { e.stopPropagation(); void handleRevoke(r); }}
            title="Revoke"
          />
        ) : null
      ),
    },
  ];

  const activeCount = rows.filter((r) => r.status === "active").length;

  return (
    <>
      <VbPageHeader
        title="API tokens"
        sub="Long-lived scoped bearer tokens for non-human principals — CI, cron, integrations, AI agents."
        right={
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {rows.length > 0 && <VbPill tone="success" dot>{activeCount} active</VbPill>}
            <VbBtn kind="primary" size="sm" icon="plus" onClick={() => setMintOpen(true)}>
              Mint token
            </VbBtn>
          </span>
        }
      />

      <div className="app-body">
        {loading ? (
          <div style={{ padding: 24, color: "var(--vb-text-3)", fontSize: 13 }}>loading…</div>
        ) : rows.length === 0 ? (
          <VbEmptyState
            icon="key"
            title="No API tokens yet"
            body="Mint long-lived bearer tokens for CI, cron jobs, automation tools (n8n / Zapier), AI agents over MCP, or any service-to-service integration."
            actions={
              <VbBtn kind="primary" size="sm" icon="plus" onClick={() => setMintOpen(true)}>
                Mint token
              </VbBtn>
            }
          />
        ) : (
          <VbTable<TokenRow>
            rows={rows}
            columns={columns}
            onRowClick={(r) => setDetail(r)}
            rowKey={(r) => r.id}
          />
        )}
      </div>

      <MintTokenModal
        open={mintOpen}
        onClose={() => setMintOpen(false)}
        onMinted={reload}
      />

      {/* Detail drawer — same Modal primitive, different shape */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name ?? ""}
        width={500}
        footer={
          detail?.status === "active" ? (
            <VbBtn kind="danger" size="sm" icon="trash" onClick={() => detail && handleRevoke(detail)}>
              Revoke token
            </VbBtn>
          ) : (
            <VbBtn kind="ghost" size="sm" onClick={() => setDetail(null)}>Close</VbBtn>
          )
        }
      >
        {detail && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <DetailRow label="ID"        value={<VbCode>{detail.id}</VbCode>} />
            <DetailRow label="Status"    value={<StatusPill status={detail.status} />} />
            <DetailRow label="Scopes"    value={<ScopePills scopes={detail.scopes} />} />
            <DetailRow label="Minted by" value={detail.created_by_email} />
            <DetailRow label="Created"
              value={<>{new Date(detail.created_at * 1000).toLocaleString()} <span style={{ color: "var(--vb-text-3)" }}>· {relTime(detail.created_at)}</span></>}
            />
            <DetailRow label="Expires"
              value={<>{new Date(detail.expires_at * 1000).toLocaleString()} <span style={{ color: "var(--vb-text-3)" }}>· {relTime(detail.expires_at)}</span></>}
            />
            {detail.revoked_at && (
              <DetailRow label="Revoked"
                value={<>{new Date(detail.revoked_at * 1000).toLocaleString()} <span style={{ color: "var(--vb-text-3)" }}>· {relTime(detail.revoked_at)}</span></>}
              />
            )}

            <div style={{ height: 1, background: "var(--vb-border-1)", margin: "4px 0" }} />

            <DetailRow label="Use count" value={<span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{detail.use_count.toLocaleString()}</span>} />
            <DetailRow label="Last used"
              value={detail.last_used_at
                ? <>{new Date(detail.last_used_at * 1000).toLocaleString()} <span style={{ color: "var(--vb-text-3)" }}>· {relTime(detail.last_used_at)}</span></>
                : <span style={{ color: "var(--vb-text-3)" }}>never</span>
              }
            />
            <DetailRow label="Last IP" value={detail.last_used_ip ?? <span style={{ color: "var(--vb-text-3)" }}>—</span>} />
            <DetailRow label="Last User-Agent"
              value={detail.last_used_ua
                ? <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-all", color: "var(--vb-text-2)" }}>{detail.last_used_ua}</span>
                : <span style={{ color: "var(--vb-text-3)" }}>—</span>
              }
            />
          </div>
        )}
      </Modal>
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      <div style={{
        fontSize: 10.5,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontWeight: 600,
        color: "var(--vb-text-3)",
        width: 110,
        paddingTop: 2,
        flexShrink: 0,
      }}>{label}</div>
      <div style={{ fontSize: 13, color: "var(--vb-text-2)", flex: 1 }}>{value}</div>
    </div>
  );
}
