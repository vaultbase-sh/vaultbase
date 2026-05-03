/**
 * /_/mcp — MCP overview + integration helper.
 *
 *   • Connect tab — pick a token, get a copy-paste config snippet for
 *     Claude Desktop / Cursor / generic stdio bridge / direct HTTP.
 *   • Clients tab — currently-connected SSE clients (live agents).
 *   • Catalog tab — every tool / resource / prompt the LLM will see.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";
import { toast } from "../stores/toast.ts";
import {
  VbBtn,
  VbCode,
  VbEmptyState,
  VbField,
  VbPageHeader,
  VbPill,
  VbTabs,
  VbTable,
  FilterInput,
  type VbTableColumn,
  type VbTab,
} from "../components/Vb.tsx";

// ── types ────────────────────────────────────────────────────────────────

interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  expires_at: number;
  status: "active" | "revoked" | "expired";
}

interface McpClientRow {
  id: string;
  tokenId: string;
  tokenName: string;
  scopes: string[];
  adminEmail: string;
  ip: string | null;
  userAgent: string | null;
  connectedAt: number;
}

interface ToolDef {
  name: string;
  description: string;
}
interface ResourceDef {
  uri: string;
  name: string;
  description?: string;
}
interface ResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description?: string;
}
interface PromptDef {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required: boolean }>;
}

interface CatalogResp {
  tools: ToolDef[];
  resources: ResourceDef[];
  resourceTemplates: ResourceTemplateDef[];
  prompts: PromptDef[];
  counts: { tools: number; resources: number; templates: number; prompts: number };
}

type TabId = "connect" | "clients" | "catalog";

// ── helpers ──────────────────────────────────────────────────────────────

function relTime(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function copy(text: string, label: string): void {
  void navigator.clipboard.writeText(text);
  toast(`${label} copied`, "check");
}

function originUrl(): string {
  return window.location.origin;
}

function ScopePill({ scope }: { scope: string }) {
  const tone = scope.startsWith("mcp:")
    ? "accent"
    : scope === "admin" ? "danger"
    : scope === "write" ? "warning"
    : "neutral";
  return <VbPill tone={tone}>{scope}</VbPill>;
}

// ── Connect tab ──────────────────────────────────────────────────────────

function ConnectTab({ tokens }: { tokens: TokenRow[] }) {
  const mcpTokens = useMemo(
    () => tokens.filter(
      (t) => t.status === "active" && t.scopes.some((s) => s.startsWith("mcp:") || s === "admin"),
    ),
    [tokens],
  );

  const [selectedId, setSelectedId] = useState<string>("");
  const [tokenValue, setTokenValue] = useState<string>("");
  const [client, setClient] = useState<"claude" | "cursor" | "raw" | "http">("claude");

  useEffect(() => {
    if (!selectedId && mcpTokens[0]) setSelectedId(mcpTokens[0].id);
  }, [mcpTokens, selectedId]);

  const selected = mcpTokens.find((t) => t.id === selectedId);

  const tokenForSnippet = tokenValue.trim() || "PASTE_TOKEN_HERE";
  const url = originUrl();

  const snippet = useMemo(() => buildSnippet(client, url, tokenForSnippet), [client, url, tokenForSnippet]);

  if (mcpTokens.length === 0) {
    return (
      <div style={{ padding: 24 }}>
        <VbEmptyState
          icon="key"
          title="No MCP-capable tokens yet"
          body={
            <>
              Mint a token with at least one <VbCode>mcp:*</VbCode> scope on the{" "}
              <Link to="/_/api-tokens" style={{ color: "var(--vb-accent)" }}>API tokens</Link> page,
              then come back here for the integration snippet.
            </>
          }
          actions={
            <Link to="/_/api-tokens">
              <VbBtn kind="primary" size="sm" icon="plus">Mint token</VbBtn>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 18, maxWidth: 920 }}>
      <p style={{ margin: 0, color: "var(--vb-text-3)", fontSize: 13, lineHeight: 1.55 }}>
        Pick a token + client, then copy the snippet below into the client's MCP-server config.
        Your raw token is never stored — paste it once to render the snippet, then it lives
        only in the target client's config file.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <VbField label="MCP token">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={selectStyle}
          >
            {mcpTokens.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {selected && (
            <div style={{ marginTop: 8, display: "flex", gap: 4, flexWrap: "wrap" }}>
              {selected.scopes.map((s) => <ScopePill key={s} scope={s} />)}
            </div>
          )}
        </VbField>

        <VbField label="Client">
          <select
            value={client}
            onChange={(e) => setClient(e.target.value as typeof client)}
            style={selectStyle}
          >
            <option value="claude">Claude Desktop (npm bridge)</option>
            <option value="cursor">Cursor (npm bridge)</option>
            <option value="raw">Raw stdio (vaultbase binary)</option>
            <option value="http">Direct HTTP (curl / SDK)</option>
          </select>
        </VbField>
      </div>

      <VbField
        label="Token value"
        hint={
          <>
            Token is shown only once at mint time and is not stored — paste it back here to render
            the snippet. If you've lost it, revoke + mint a new one.
          </>
        }
      >
        <input
          type="password"
          value={tokenValue}
          onChange={(e) => setTokenValue(e.target.value)}
          placeholder="vbat_…"
          style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
          autoComplete="off"
          spellCheck={false}
        />
      </VbField>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--vb-text-2)" }}>
            {snippet.heading}
          </span>
          <VbBtn kind="ghost" size="sm" icon="copy" onClick={() => copy(snippet.body, "Snippet")}>
            Copy
          </VbBtn>
        </div>
        <pre style={preStyle}>{snippet.body}</pre>
        {snippet.footer && (
          <p style={{ margin: "8px 0 0", color: "var(--vb-text-3)", fontSize: 12, lineHeight: 1.55 }}>
            {snippet.footer}
          </p>
        )}
      </div>
    </div>
  );
}

interface Snippet {
  heading: string;
  body: string;
  footer?: React.ReactNode;
}

function buildSnippet(
  client: "claude" | "cursor" | "raw" | "http",
  url: string,
  token: string,
): Snippet {
  if (client === "claude") {
    return {
      heading: "claude_desktop_config.json",
      body: JSON.stringify(
        {
          mcpServers: {
            vaultbase: {
              command: "npx",
              args: ["-y", "@vaultbase/mcp"],
              env: {
                VAULTBASE_URL: url,
                VAULTBASE_MCP_TOKEN: token,
              },
            },
          },
        },
        null,
        2,
      ),
      footer: "Drop into ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows). Restart Claude Desktop.",
    };
  }
  if (client === "cursor") {
    return {
      heading: "Cursor MCP config",
      body: JSON.stringify(
        {
          mcpServers: {
            vaultbase: {
              command: "npx",
              args: ["-y", "@vaultbase/mcp"],
              env: {
                VAULTBASE_URL: url,
                VAULTBASE_MCP_TOKEN: token,
              },
            },
          },
        },
        null,
        2,
      ),
      footer: "Add under Cursor → Settings → MCP. Same shape works for Continue / Cline / Zed.",
    };
  }
  if (client === "raw") {
    return {
      heading: "claude_desktop_config.json (local binary)",
      body: JSON.stringify(
        {
          mcpServers: {
            vaultbase: {
              command: "vaultbase",
              args: ["mcp"],
              env: { VAULTBASE_MCP_TOKEN: token },
            },
          },
        },
        null,
        2,
      ),
      footer: "Use this when the vaultbase binary is on the same machine as the LLM client. No npm bridge needed.",
    };
  }
  return {
    heading: "HTTP — direct JSON-RPC",
    body:
      `curl -X POST ${url}/api/v1/mcp \\\n` +
      `  -H "Authorization: Bearer ${token}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    footer: "Stateless. SSE leg is GET /api/v1/mcp/events with the same Authorization header for server → client notifications.",
  };
}

// ── Clients tab ──────────────────────────────────────────────────────────

function ClientsTab({ rows, loading, onRefresh }: {
  rows: McpClientRow[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const columns: VbTableColumn<McpClientRow>[] = [
    {
      key: "tokenName", label: "Token", flex: 2,
      render: (r) => (
        <span style={{ fontWeight: 500 }}>{r.tokenName}</span>
      ),
    },
    {
      key: "scopes", label: "Scopes", flex: 2,
      render: (r) => (
        <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {r.scopes.map((s) => <ScopePill key={s} scope={s} />)}
        </span>
      ),
    },
    {
      key: "ip", label: "IP", width: 140,
      render: (r) => (
        <span style={{ color: "var(--vb-text-3)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
          {r.ip ?? "—"}
        </span>
      ),
    },
    {
      key: "ua", label: "User-Agent", flex: 2,
      render: (r) => (
        <span style={{ color: "var(--vb-text-3)", fontSize: 12 }}>
          {truncate(r.userAgent ?? "—", 60)}
        </span>
      ),
    },
    {
      key: "since", label: "Connected", width: 110,
      render: (r) => (
        <span style={{ color: "var(--vb-text-3)", fontSize: 12 }}>{relTime(r.connectedAt)}</span>
      ),
    },
  ];

  return (
    <div className="app-body">
      <div style={{ padding: "14px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--vb-text-3)" }}>
          Live SSE connections. Stateless POST clients (curl, the npm bridge mid-request) don't appear here — only ones with the events stream open.
        </span>
        <VbBtn kind="ghost" size="sm" icon="refresh" onClick={onRefresh}>
          Refresh
        </VbBtn>
      </div>
      <div style={{ paddingTop: 14 }}>
        {loading ? (
          <div style={{ padding: 24, color: "var(--vb-text-3)", fontSize: 13 }}>loading…</div>
        ) : rows.length === 0 ? (
          <VbEmptyState
            icon="zap"
            title="No live MCP clients"
            body="When an agent opens GET /api/v1/mcp/events with a valid token, it appears here. POST-only flows are stateless and don't show up."
          />
        ) : (
          <VbTable<McpClientRow> rows={rows} columns={columns} rowKey={(r) => r.id} />
        )}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── Catalog tab ──────────────────────────────────────────────────────────

function matches(q: string, ...fields: Array<string | undefined>): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  for (const f of fields) {
    if (f && f.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function CatalogTab({ catalog, loading }: { catalog: CatalogResp | null; loading: boolean }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!catalog) return null;
    const tools = catalog.tools.filter((t) => matches(query, t.name, t.description));
    const resources = catalog.resources.filter((r) => matches(query, r.uri, r.name, r.description));
    const resourceTemplates = catalog.resourceTemplates.filter((r) =>
      matches(query, r.uriTemplate, r.name, r.description));
    const prompts = catalog.prompts.filter((p) =>
      matches(query, p.name, p.description, ...(p.arguments?.map((a) => a.name) ?? [])));
    return { tools, resources, resourceTemplates, prompts };
  }, [catalog, query]);

  if (loading) {
    return <div style={{ padding: 24, color: "var(--vb-text-3)", fontSize: 13 }}>loading…</div>;
  }
  if (!catalog || !filtered) {
    return <div style={{ padding: 24, color: "var(--vb-text-3)", fontSize: 13 }}>catalog unavailable</div>;
  }

  const totalHits =
    filtered.tools.length +
    filtered.resources.length +
    filtered.resourceTemplates.length +
    filtered.prompts.length;

  return (
    <div className="app-body" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{
        position: "sticky",
        top: 0,
        zIndex: 1,
        background: "var(--vb-bg-1)",
        borderBottom: "1px solid var(--vb-border)",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}>
        <FilterInput
          placeholder="Search tools, resources, prompts…"
          value={query}
          onChange={setQuery}
          width={320}
          mono
        />
        {query && (
          <span style={{ fontSize: 12, color: "var(--vb-text-3)" }}>
            {totalHits} match{totalHits === 1 ? "" : "es"}
          </span>
        )}
        {query && (
          <VbBtn kind="ghost" size="sm" onClick={() => setQuery("")}>Clear</VbBtn>
        )}
      </div>

      <div style={{ padding: 24, display: "grid", gap: 24, overflowY: "auto", flex: 1, minHeight: 0 }}>
        {totalHits === 0 ? (
          <VbEmptyState
            icon="search"
            title="No matches"
            body={<>Nothing matched <VbCode>{query}</VbCode>. Try a shorter query.</>}
          />
        ) : (
          <>
            {filtered.tools.length > 0 && (
              <Section
                title="Tools"
                count={filtered.tools.length}
                total={catalog.tools.length}
                hint="Function-style calls. Auto-generated per collection (list/get/create/update/delete) + admin tools."
              >
                <ul style={listStyle}>
                  {filtered.tools.map((t) => (
                    <li key={t.name} style={listItemStyle}>
                      <code style={codeNameStyle}>{highlight(t.name, query)}</code>
                      <span style={descStyle}>{highlight(t.description, query)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {(filtered.resources.length + filtered.resourceTemplates.length) > 0 && (
              <Section
                title="Resources"
                count={filtered.resources.length + filtered.resourceTemplates.length}
                total={catalog.resources.length + catalog.resourceTemplates.length}
                hint="Read-only URIs the LLM can pull for passive context. Static + parameterised templates."
              >
                <ul style={listStyle}>
                  {filtered.resources.map((r) => (
                    <li key={r.uri} style={listItemStyle}>
                      <code style={codeNameStyle}>{highlight(r.uri, query)}</code>
                      <span style={descStyle}>{highlight(r.description ?? r.name, query)}</span>
                    </li>
                  ))}
                  {filtered.resourceTemplates.map((r) => (
                    <li key={r.uriTemplate} style={listItemStyle}>
                      <code style={codeNameStyle}>{highlight(r.uriTemplate, query)}</code>
                      <span style={descStyle}>{highlight(r.description ?? r.name, query)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {filtered.prompts.length > 0 && (
              <Section
                title="Prompts"
                count={filtered.prompts.length}
                total={catalog.prompts.length}
                hint="Slash-command templates the LLM client can offer. Args fill substitution slots."
              >
                <ul style={listStyle}>
                  {filtered.prompts.map((p) => (
                    <li key={p.name} style={listItemStyle}>
                      <code style={codeNameStyle}>{highlight(p.name, query)}</code>
                      <span style={descStyle}>{highlight(p.description, query)}</span>
                      {p.arguments && p.arguments.length > 0 && (
                        <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {p.arguments.map((a) => (
                            <VbPill key={a.name} tone={a.required ? "warning" : "neutral"}>
                              {a.name}{a.required ? "*" : ""}
                            </VbPill>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Wraps query matches in the input string with a styled <mark>. Case-insensitive. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{
        background: "var(--vb-accent-soft, rgba(232,90,79,0.18))",
        color: "inherit",
        padding: "0 2px",
        borderRadius: 2,
      }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {highlight(text.slice(idx + query.length), query)}
    </>
  );
}

function Section({ title, count, total, hint, children }: {
  title: string;
  count: number;
  total?: number;
  hint: string;
  children: React.ReactNode;
}) {
  const showTotal = total !== undefined && total !== count;
  return (
    <section>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h3>
        <VbPill tone="neutral">{showTotal ? `${count} / ${total}` : count}</VbPill>
      </div>
      <p style={{ margin: "0 0 10px", color: "var(--vb-text-3)", fontSize: 12, lineHeight: 1.55 }}>{hint}</p>
      {children}
    </section>
  );
}

// ── styles ───────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  width: "100%",
  height: 32,
  border: "1px solid var(--vb-border)",
  background: "var(--vb-bg-1)",
  color: "var(--vb-text-1)",
  borderRadius: 6,
  padding: "0 10px",
  fontFamily: "inherit",
  fontSize: 13,
};
const inputStyle: React.CSSProperties = {
  ...selectStyle,
  appearance: "none",
};
const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 14,
  background: "var(--vb-bg-2)",
  border: "1px solid var(--vb-border)",
  borderRadius: 6,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: "pre",
  overflowX: "auto",
};
const listStyle: React.CSSProperties = {
  margin: 0, padding: 0, listStyle: "none",
  border: "1px solid var(--vb-border)",
  borderRadius: 6,
  background: "var(--vb-bg-1)",
};
const listItemStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--vb-border)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const codeNameStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--vb-accent)",
  fontWeight: 500,
};
const descStyle: React.CSSProperties = {
  color: "var(--vb-text-3)",
  fontSize: 12,
  lineHeight: 1.55,
};

// ── page ─────────────────────────────────────────────────────────────────

export default function McpPage() {
  const [tab, setTab] = useState<TabId>("connect");
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [clients, setClients] = useState<McpClientRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogResp | null>(null);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [loadingClients, setLoadingClients] = useState(true);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  async function loadTokens(): Promise<void> {
    setLoadingTokens(true);
    const res = await api.get<ApiResponse<TokenRow[]>>("/api/v1/admin/api-tokens");
    setLoadingTokens(false);
    if (res.data) setTokens(res.data);
  }

  async function loadClients(): Promise<void> {
    setLoadingClients(true);
    const res = await api.get<ApiResponse<McpClientRow[]>>("/api/v1/admin/mcp/clients");
    setLoadingClients(false);
    if (res.data) setClients(res.data);
  }

  async function loadCatalog(): Promise<void> {
    setLoadingCatalog(true);
    const res = await api.get<ApiResponse<CatalogResp>>("/api/v1/admin/mcp/catalog");
    setLoadingCatalog(false);
    if (res.data) setCatalog(res.data);
  }

  useEffect(() => {
    void loadTokens();
    void loadClients();
    void loadCatalog();
  }, []);

  // Auto-refresh clients tab every 10s while it's the active tab.
  useEffect(() => {
    if (tab !== "clients") return;
    const id = setInterval(() => { void loadClients(); }, 10_000);
    return () => clearInterval(id);
  }, [tab]);

  const tabs: VbTab<TabId>[] = [
    { id: "connect", label: "Connect", icon: "play" },
    { id: "clients", label: "Live clients", icon: "zap", count: clients.length },
    { id: "catalog", label: "Catalog",     icon: "stack", count: catalog?.counts.tools ?? null },
  ];

  return (
    <>
      <VbPageHeader
        title="MCP"
        sub="Model Context Protocol — connect Claude / Cursor / any MCP client to this Vaultbase. See live clients and the full tool / resource / prompt catalog."
        right={
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--vb-text-3)" }}
          >
            Spec ↗
          </a>
        }
      />
      <VbTabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "connect" && (
        loadingTokens
          ? <div style={{ padding: 24, color: "var(--vb-text-3)", fontSize: 13 }}>loading…</div>
          : <ConnectTab tokens={tokens} />
      )}
      {tab === "clients" && (
        <ClientsTab rows={clients} loading={loadingClients} onRefresh={() => void loadClients()} />
      )}
      {tab === "catalog" && <CatalogTab catalog={catalog} loading={loadingCatalog} />}
    </>
  );
}
