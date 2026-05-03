import { useEffect, useRef, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Tag } from "primereact/tag";
import { api, getMemoryToken, type ApiResponse } from "../api.ts";
import { Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";
import ProviderLogo from "../components/ProviderLogo.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";
import { useAuth } from "../stores/auth.ts";
import {
  VbBtn,
  VbCode,
  VbField,
  VbInput,
  VbPageHeader,
  VbPill,
  VbStat,
  VbStatusDot,
} from "../components/Vb.tsx";

type RuleAudience = "all" | "guest" | "auth";
interface RateLimitRule {
  label: string;
  max: number;
  windowMs: number;
  audience: RuleAudience;
}

const DEFAULT_RULES: RateLimitRule[] = [
  { label: "*:auth",   max: 10,  windowMs: 3000,  audience: "all" },
  { label: "*:create", max: 60,  windowMs: 5000,  audience: "all" },
  { label: "/api/v1/*",   max: 300, windowMs: 10000, audience: "all" },
];

type SettingsTabId =
  | "application" | "theme" | "rate-limit" | "egress" | "cors" | "security"
  | "smtp" | "templates" | "auth" | "password-policy" | "oauth2"
  | "storage" | "backup" | "migrations" | "notifications"
  | "metrics" | "updates" | "danger";

interface SettingsTab {
  id: SettingsTabId;
  label: string;
  subtitle: string;
}

interface SettingsGroup {
  /** Empty string = no group label (used for the trailing Danger zone). */
  group: string;
  items: SettingsTab[];
}

// Semantic grouping per the redesign handoff (vaultbase/project/shell.jsx).
const SETTINGS_GROUPS: SettingsGroup[] = [
  { group: "General", items: [
    { id: "application", label: "Application", subtitle: "runtime configuration" },
    { id: "theme",       label: "Theme",       subtitle: "admin UI accent + surface colors" },
    { id: "updates",     label: "Updates",     subtitle: "GitHub release checker" },
  ]},
  { group: "Traffic", items: [
    { id: "rate-limit",  label: "Rate limiting", subtitle: "per-IP token bucket" },
    { id: "egress",      label: "Hook egress",   subtitle: "outbound HTTP allow / deny CIDRs" },
    { id: "cors",        label: "CORS",          subtitle: "cross-origin allow-list for the HTTP API" },
  ]},
  { group: "Identity", items: [
    { id: "security",        label: "Security",        subtitle: "sessions · lockout · proxies · fingerprints" },
    { id: "auth",            label: "Auth features",   subtitle: "OTP · MFA · anonymous · impersonation" },
    { id: "password-policy", label: "Password policy", subtitle: "length · character classes · HIBP" },
    { id: "oauth2",          label: "OAuth2",          subtitle: "third-party sign-in providers" },
  ]},
  { group: "Comms", items: [
    { id: "smtp",          label: "SMTP / Email",    subtitle: "outbound email server" },
    { id: "templates",     label: "Email templates", subtitle: "verify + reset emails" },
    { id: "notifications", label: "Notifications",   subtitle: "OneSignal · FCM push providers" },
  ]},
  { group: "Infrastructure", items: [
    { id: "storage",    label: "File storage",     subtitle: "local FS · S3 · Cloudflare R2" },
    { id: "backup",     label: "Backup & restore", subtitle: "SQLite snapshot" },
    { id: "migrations", label: "Migrations",       subtitle: "schema snapshot · environment sync" },
    { id: "metrics",    label: "Health & metrics", subtitle: "Prometheus exposition" },
  ]},
  { group: "", items: [
    { id: "danger", label: "Danger zone", subtitle: "irreversible actions" },
  ]},
];

const SETTINGS_TABS: SettingsTab[] = SETTINGS_GROUPS.flatMap((g) => g.items);

/**
 * Wraps a Settings section with the design's in-body page header
 * (breadcrumb · h1 · sub · optional right-slot). Replaces the legacy
 * `.settings-section / .settings-section-head / -body / -foot` chrome.
 */
const SectionShell: React.FC<{
  id: SettingsTabId;
  /** Override the auto-derived sub from SETTINGS_GROUPS. */
  sub?: React.ReactNode;
  /** Right-aligned header slot (status pill, enable toggle, etc.). */
  right?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, sub, right, children }) => {
  const tab = SETTINGS_TABS.find((t) => t.id === id);
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <VbPageHeader
        breadcrumb={["Settings", tab?.label ?? id]}
        title={tab?.label ?? id}
        sub={sub ?? tab?.subtitle}
        right={right}
      />
      <div style={{
        padding: "20px 28px 32px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
        minWidth: 0,
      }}>
        {children}
      </div>
    </div>
  );
};

/**
 * Card-style container used by sub-sections inside a SectionShell. Keeps the
 * card's title bar visually distinct from the page-level VbPageHeader and
 * still uses the design tokens.
 */
const SubCard: React.FC<{
  title: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, meta, right, children }) => (
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
      padding: "12px 14px",
      borderBottom: "1px solid var(--vb-border)",
      background: "var(--vb-bg-1)",
      gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--vb-fg)" }}>{title}</span>
        {meta && (
          <span style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>{meta}</span>
        )}
      </div>
      {right && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{right}</div>}
    </div>
    <div style={{ padding: "14px" }}>{children}</div>
  </div>
);

/**
 * Right-aligned save/reset footer pair used by every editable section.
 * Sits at the bottom of the SectionShell body.
 */
const SaveBar: React.FC<{
  saving?: boolean;
  dirty?: boolean;
  onSave: () => void;
  onReset?: () => void;
  saveLabel?: string;
}> = ({ saving, dirty = true, onSave, onReset, saveLabel = "Save changes" }) => (
  <div style={{
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    paddingTop: 4,
    borderTop: "1px solid var(--vb-border)",
    marginTop: 4,
  }}>
    {onReset && (
      <VbBtn kind="ghost" size="sm" onClick={onReset} disabled={saving || !dirty}>
        Reset
      </VbBtn>
    )}
    <VbBtn
      kind="primary"
      size="sm"
      icon="check"
      onClick={onSave}
      disabled={saving || !dirty}
    >
      {saving ? "Saving…" : saveLabel}
    </VbBtn>
  </div>
);

export default function Settings() {
  const [active, setActive] = useState<SettingsTabId>("application");
  // activeTab still drives the (unused for now) page title; sections render
  // their own VbPageHeader so we no longer surface a global topbar.
  void SETTINGS_TABS.find((t) => t.id === active);

  return (
    <>
      <div className="app-body settings-layout" style={{ paddingTop: 0 }}>
        <aside className="settings-nav">
          <div className="settings-nav-heading">Settings</div>
          {SETTINGS_GROUPS.map((g, gi) => (
            <div className="settings-nav-group" key={gi}>
              {g.group && (
                <div className="settings-nav-group-title">{g.group}</div>
              )}
              <ul className="settings-nav-list">
                {g.items.map((t) => (
                  <li
                    key={t.id}
                    className={`settings-nav-item ${active === t.id ? "active" : ""} ${t.id === "danger" ? "danger" : ""}`}
                    onClick={() => setActive(t.id)}
                  >
                    {active === t.id && <span className="settings-nav-bar" />}
                    <span>{t.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>
        <div className="settings-content">
          {active === "application" && <ApplicationSection />}
          {active === "theme" && <ThemeSection />}
          {active === "rate-limit" && <RateLimitSection />}
          {active === "egress" && <EgressSection />}
          {active === "cors" && <CorsSection />}
          {active === "security" && <SecuritySection />}
          {active === "smtp" && <SmtpSection />}
          {active === "templates" && <EmailTemplatesSection />}
          {active === "auth" && (
            <>
              <AuthFeaturesSection />
              <SessionLifetimesSection />
            </>
          )}
          {active === "password-policy" && <PasswordPolicySection />}
          {active === "oauth2" && <OAuth2Section />}
          {active === "storage" && <StorageSection />}
          {active === "backup" && <BackupSection />}
          {active === "migrations" && <MigrationsSection />}
          {active === "notifications" && <NotificationsSection />}
          {active === "metrics" && <MetricsSection />}
          {active === "updates" && <UpdatesSection />}
          {active === "danger" && <DangerZone />}
        </div>
      </div>
    </>
  );
}

// ── Application config ───────────────────────────────────────────────────────
function ApplicationSection() {
  return (
    <SectionShell id="application">
      <VbField label="Port" hint={<>Set via <VbCode>VAULTBASE_PORT</VbCode></>}>
        <VbInput mono defaultValue="8091" disabled />
      </VbField>
      <VbField label="Data directory" hint={<>Set via <VbCode>VAULTBASE_DATA_DIR</VbCode></>}>
        <VbInput mono defaultValue="./vaultbase_data" disabled />
      </VbField>
      <VbField label="JWT secret" hint={<>Auto-generated. Stored in <VbCode>data_dir/.secret</VbCode></>}>
        <VbInput mono value="••••••••••••••••••••••••••••••••" disabled />
      </VbField>
      <div style={{
        fontSize: 11, color: "var(--vb-fg-3)", paddingTop: 4,
        borderTop: "1px solid var(--vb-border)",
      }}>
        Runtime config is set via environment variables.
      </div>
    </SectionShell>
  );
}

// ── Rate limit ──────────────────────────────────────────────────────────────
const AUDIENCE_OPTIONS = [
  { label: "All",   value: "all"   },
  { label: "Guest", value: "guest" },
  { label: "Auth",  value: "auth"  },
];

function RateLimitSection() {
  const [enabled, setEnabled] = useState(true);
  const [rules, setRules] = useState<RateLimitRule[]>(DEFAULT_RULES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        if (res.data["rate_limit.enabled"] !== undefined) {
          setEnabled(res.data["rate_limit.enabled"] === "1" || res.data["rate_limit.enabled"] === "true");
        }
        const raw = res.data["rate_limit.rules"];
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) setRules(parsed as RateLimitRule[]);
          } catch { /* keep defaults */ }
        } else if (res.data["rate_limit.max"] && res.data["rate_limit.window_ms"]) {
          // Migrate legacy single-rule to new format
          const max = parseInt(res.data["rate_limit.max"]);
          const ms = parseInt(res.data["rate_limit.window_ms"]);
          if (!isNaN(max) && !isNaN(ms)) {
            setRules([{ label: "*", max, windowMs: ms, audience: "all" }]);
          }
        }
      }
      setLoading(false);
    });
  }, []);

  function updateRule(idx: number, patch: Partial<RateLimitRule>) {
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeRule(idx: number) {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  }
  function addRule() {
    setRules((prev) => [...prev, { label: "/api/v1/", max: 60, windowMs: 5000, audience: "all" }]);
  }

  async function handleSave() {
    for (const r of rules) {
      if (!r.label.trim()) { toast("Rule label cannot be empty", "info"); return; }
      if (!Number.isFinite(r.max) || r.max < 1) { toast(`Invalid max for "${r.label}"`, "info"); return; }
      if (!Number.isFinite(r.windowMs) || r.windowMs < 1) { toast(`Invalid window for "${r.label}"`, "info"); return; }
    }
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "rate_limit.enabled": enabled ? "1" : "0",
      "rate_limit.rules": JSON.stringify(rules),
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Rate limit rules saved");
  }

  return (
    <SectionShell
      id="rate-limit"
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{
            fontSize: 11, fontFamily: "var(--font-mono)",
            color: enabled ? "var(--vb-status-success)" : "var(--vb-fg-3)",
          }}>{enabled ? "enabled" : "bypass"}</span>
        </span>
      }
    >
      <div style={{ opacity: enabled ? 1 : 0.5, display: "flex", flexDirection: "column", gap: 0,
        background: "var(--vb-bg-2)",
        border: "1px solid var(--vb-border)",
        borderRadius: 8, overflow: "hidden",
      }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 110px 110px 110px 28px",
          gap: 10, padding: "9px 14px", alignItems: "center",
          background: "var(--vb-bg-1)",
          borderBottom: "1px solid var(--vb-border)",
          fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2,
          textTransform: "uppercase", color: "var(--vb-fg-3)",
          fontFamily: "var(--font-mono)",
        }}>
          <span>Rule label</span>
          <span>Max / IP</span>
          <span>Interval (s)</span>
          <span>Audience</span>
          <span />
        </div>
        {rules.map((r, i) => (
          <div key={i} style={{
            display: "grid",
            gridTemplateColumns: "1.4fr 110px 110px 110px 28px",
            gap: 10, padding: "9px 14px", alignItems: "center",
            borderBottom: i === rules.length - 1 ? "none" : "1px solid var(--vb-border)",
          }}>
            <VbInput mono value={r.label} placeholder="*:auth"
              onChange={(e) => updateRule(i, { label: e.target.value })}
              disabled={!enabled || loading} />
            <VbInput mono type="number" min={1} value={r.max}
              onChange={(e) => updateRule(i, { max: parseInt(e.target.value) || 0 })}
              disabled={!enabled || loading} />
            <VbInput mono type="number" min={1} value={Math.round(r.windowMs / 1000)}
              onChange={(e) => updateRule(i, { windowMs: (parseInt(e.target.value) || 0) * 1000 })}
              disabled={!enabled || loading} />
            <Dropdown
              value={r.audience}
              options={AUDIENCE_OPTIONS}
              onChange={(e) => updateRule(i, { audience: e.value as RuleAudience })}
              disabled={!enabled || loading}
              style={{ height: 32, fontSize: 12 }}
            />
            <button
              onClick={() => removeRule(i)}
              disabled={!enabled || loading}
              title="Remove rule"
              style={{
                appearance: "none", border: 0, background: "transparent",
                color: "var(--vb-status-danger)", cursor: "pointer", padding: 4,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <VbBtn kind="ghost" size="sm" icon="plus" onClick={addRule} disabled={!enabled || loading}>
          Add rate limit rule
        </VbBtn>
        <span style={{ fontSize: 11, color: "var(--vb-fg-3)", fontStyle: "italic" }}>
          Label = <VbCode>{`<path>[:<action>]`}</VbCode> · path: exact, prefix*, or *
        </span>
      </div>

      <div style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>
        Actions: <VbCode>auth</VbCode> <VbCode>create</VbCode> <VbCode>list</VbCode>{" "}
        <VbCode>view</VbCode> <VbCode>update</VbCode> <VbCode>delete</VbCode>
      </div>

      <SaveBar saving={saving} dirty={!loading} onSave={handleSave} />
    </SectionShell>
  );
}

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  background: "rgba(255,255,255,0.05)",
  padding: "1px 5px",
  borderRadius: 3,
  color: "var(--text-secondary)",
};

// ── Hook egress (SSRF guard) ────────────────────────────────────────────────
const DEFAULT_DENY_HUMAN =
  "0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, " +
  "172.16.0.0/12, 192.168.0.0/16, ::1/128, fc00::/7, fe80::/10";

function EgressSection() {
  const [deny, setDeny] = useState("");
  const [allow, setAllow] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        setDeny(res.data["hooks.http.deny"] ?? "");
        setAllow(res.data["hooks.http.allow"] ?? "");
      }
      setLoaded(true);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "hooks.http.deny": deny.trim(),
      "hooks.http.allow": allow.trim(),
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Egress filters saved");
  }

  const off = deny.trim().toLowerCase() === "off";

  return (
    <SectionShell
      id="egress"
      sub={<>Filters <VbCode>helpers.http(...)</VbCode> outbound calls.</>}
    >
      <VbField
        label="Deny CIDRs (comma-separated)"
        hint={
          <>
            Default deny when blank:{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{DEFAULT_DENY_HUMAN}</span>.
            Set <VbCode>off</VbCode> to disable filtering entirely (NOT recommended for public
            deployments).
          </>
        }
      >
        <textarea
          rows={3} value={deny} onChange={(e) => setDeny(e.target.value)}
          placeholder="(blank = use default deny)" disabled={!loaded}
          style={{
            width: "100%", padding: "8px 10px",
            background: "var(--vb-bg-3)", border: "1px solid var(--vb-border-2)",
            borderRadius: 5, color: "var(--vb-fg)",
            fontFamily: "var(--font-mono)", fontSize: 12,
            outline: "none", resize: "vertical",
          }}
        />
      </VbField>

      {off && (
        <div style={{
          padding: "8px 10px", borderRadius: 5,
          background: "var(--vb-status-danger-bg)",
          color: "var(--vb-status-danger)",
          fontSize: 12, display: "flex", alignItems: "center", gap: 8,
        }}>
          <Icon name="alert" size={13} />
          Egress filtering is OFF — hooks can reach any IP including private RFC1918 ranges.
        </div>
      )}

      <VbField
        label="Allow CIDRs (comma-separated)"
        hint={
          <>
            Punches a hole in deny — e.g. <VbCode>10.5.0.0/16</VbCode> to permit one internal
            subnet without disabling the rest of the deny list. Empty by default.
          </>
        }
      >
        <textarea
          rows={2} value={allow} onChange={(e) => setAllow(e.target.value)}
          placeholder="(blank = no allow exceptions)" disabled={!loaded}
          style={{
            width: "100%", padding: "8px 10px",
            background: "var(--vb-bg-3)", border: "1px solid var(--vb-border-2)",
            borderRadius: 5, color: "var(--vb-fg)",
            fontFamily: "var(--font-mono)", fontSize: 12,
            outline: "none", resize: "vertical",
          }}
        />
      </VbField>

      <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.6 }}>
        <strong style={{ color: "var(--vb-fg-2)" }}>Known limitation:</strong> filtering happens
        after DNS resolution; a malicious DNS server can still race-rebind a host between
        resolution and connect. Defense-in-depth alongside an operator-level firewall (iptables /
        VPC NACL) is recommended.
      </div>

      <SaveBar saving={saving} dirty={loaded} onSave={save} />
    </SectionShell>
  );
}

// ── Theme ───────────────────────────────────────────────────────────────────
interface ThemeKnob { key: string; label: string; defaultValue: string; cssVar: string }

const THEME_KNOBS: ThemeKnob[] = [
  // Brand
  { key: "accent",         label: "Primary accent",     defaultValue: "#e85a4f", cssVar: "--accent" },
  { key: "accent_hover",   label: "Accent (hover)",     defaultValue: "#f06f64", cssVar: "--accent-hover" },
  { key: "accent_light",   label: "Accent (light)",     defaultValue: "#f5807a", cssVar: "--accent-light" },
  // Surfaces
  { key: "bg_app",         label: "Page background",    defaultValue: "#0e0f12", cssVar: "--bg-app" },
  { key: "bg_sidebar",     label: "Sidebar background", defaultValue: "#131418", cssVar: "--bg-sidebar" },
  { key: "bg_panel",       label: "Card background",    defaultValue: "#181a1f", cssVar: "--bg-panel" },
  // Text
  { key: "text_primary",   label: "Primary text",       defaultValue: "#e6e8ed", cssVar: "--text-primary" },
  { key: "text_secondary", label: "Secondary text",     defaultValue: "#9aa0ac", cssVar: "--text-secondary" },
  // Status
  { key: "success",        label: "Success",            defaultValue: "#22c55e", cssVar: "--success" },
  { key: "warning",        label: "Warning",            defaultValue: "#f59e0b", cssVar: "--warning" },
  { key: "danger",         label: "Danger",             defaultValue: "#ef4444", cssVar: "--danger" },
];

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function ThemeSection() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        const seed: Record<string, string> = {};
        for (const k of THEME_KNOBS) {
          seed[k.key] = res.data[`theme.${k.key}`] ?? "";
        }
        setValues(seed);
      }
      setLoaded(true);
    });
  }, []);

  function update(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function liveStyle(): React.CSSProperties {
    const out: Record<string, string> = {};
    for (const k of THEME_KNOBS) {
      const v = (values[k.key] ?? "").trim();
      if (v) out[k.cssVar] = v;
    }
    return out as React.CSSProperties;
  }

  async function save() {
    for (const k of THEME_KNOBS) {
      const v = (values[k.key] ?? "").trim();
      if (v && !HEX_RE.test(v)) {
        toast(`${k.label} must be a #RRGGBB / #RGB / #RRGGBBAA hex color`, "info");
        return;
      }
    }
    setSaving(true);
    const patch: Record<string, string> = {};
    for (const k of THEME_KNOBS) patch[`theme.${k.key}`] = (values[k.key] ?? "").trim();
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", patch);
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Theme saved — refresh to apply everywhere");
    // Apply immediately to the live page so the change is visible without
    // a full reload. Other tabs / pages pick it up on next mount.
    const root = document.documentElement;
    for (const k of THEME_KNOBS) {
      const v = (values[k.key] ?? "").trim();
      if (v) root.style.setProperty(k.cssVar, v);
      else root.style.removeProperty(k.cssVar);
    }
  }

  function reset() {
    const next: Record<string, string> = {};
    for (const k of THEME_KNOBS) next[k.key] = "";
    setValues(next);
  }

  return (
    <SectionShell id="theme">
      <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.6 }}>
        Hex colors: <VbCode>#e85a4f</VbCode>, <VbCode>#fff</VbCode>, <VbCode>#e85a4f80</VbCode>{" "}
        (alpha). Empty falls back to the built-in default. Changes apply on next page load — and
        immediately once you save.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {THEME_KNOBS.map((k) => {
          const v = values[k.key] ?? "";
          const effective = v.trim() || k.defaultValue;
          const isHex = HEX_RE.test(effective);
          return (
            <div key={k.key} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="color"
                value={isHex && effective.length === 7 ? effective : k.defaultValue}
                onChange={(e) => update(k.key, e.target.value)}
                disabled={!loaded}
                style={{
                  width: 32, height: 32, padding: 0, cursor: "pointer",
                  background: "transparent",
                  border: "1px solid var(--vb-border-2)",
                  borderRadius: 5,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2,
                  textTransform: "uppercase", color: "var(--vb-fg-2)",
                  fontFamily: "var(--font-mono)", marginBottom: 4,
                }}>{k.label}</div>
                <VbInput
                  mono
                  value={v}
                  onChange={(e) => update(k.key, e.target.value)}
                  placeholder={k.defaultValue}
                  disabled={!loaded}
                  style={{ height: 28 }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div style={{
        padding: 16, borderRadius: 8,
        background: "var(--vb-bg-2)",
        border: "1px solid var(--vb-border)",
        ...liveStyle(),
      }}>
        <div style={{
          fontSize: 9.5, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)",
          textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10,
        }}>
          Live preview
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <VbBtn kind="primary" size="sm">Primary action</VbBtn>
          <VbBtn kind="ghost" size="sm">Secondary</VbBtn>
          <VbPill tone="success" dot>success</VbPill>
          <VbPill tone="warning" dot>warning</VbPill>
          <VbPill tone="danger" dot>danger</VbPill>
        </div>
      </div>

      <div style={{
        display: "flex", justifyContent: "space-between", gap: 8,
        paddingTop: 4, borderTop: "1px solid var(--vb-border)", marginTop: 4,
      }}>
        <VbBtn kind="ghost" size="sm" onClick={reset} disabled={!loaded || saving}>
          Reset to defaults
        </VbBtn>
        <VbBtn kind="primary" size="sm" icon="check" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </VbBtn>
      </div>
    </SectionShell>
  );
}

// ── CORS ────────────────────────────────────────────────────────────────────
function CorsSection() {
  const [origins, setOrigins] = useState("");
  const [methods, setMethods] = useState("");
  const [headers, setHeaders] = useState("");
  const [credentials, setCredentials] = useState(false);
  const [maxAge, setMaxAge] = useState("600");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        setOrigins(res.data["cors.origins"] ?? "");
        setMethods(res.data["cors.methods"] ?? "");
        setHeaders(res.data["cors.headers"] ?? "");
        setCredentials((res.data["cors.credentials"] ?? "0") === "1");
        setMaxAge(res.data["cors.max_age"] ?? "600");
      }
      setLoaded(true);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "cors.origins":     origins.trim(),
      "cors.methods":     methods.trim(),
      "cors.headers":     headers.trim(),
      "cors.credentials": credentials ? "1" : "0",
      "cors.max_age":     maxAge.trim() || "600",
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("CORS saved");
  }

  const wildcardWithCreds = credentials && origins.split(",").map((s) => s.trim()).includes("*");

  return (
    <SectionShell id="cors">
      <VbField
        label="Allowed origins (comma-separated)"
        hint={
          <>
            Empty blocks all cross-origin requests. <VbCode>*</VbCode> permits any origin
            (incompatible with credentials — silently downgraded). Otherwise list each origin
            verbatim, e.g. <VbCode>https://app.example.com,https://admin.example.com</VbCode>.
          </>
        }
      >
        <textarea
          rows={2}
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          placeholder="(blank = block cross-origin)"
          disabled={!loaded}
          style={{
            width: "100%", padding: "8px 10px",
            background: "var(--vb-bg-3)", border: "1px solid var(--vb-border-2)",
            borderRadius: 5, color: "var(--vb-fg)",
            fontFamily: "var(--font-mono)", fontSize: 12,
            outline: "none", resize: "vertical",
          }}
        />
      </VbField>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <VbField label="Allowed methods">
          <VbInput
            mono value={methods} onChange={(e) => setMethods(e.target.value)}
            placeholder="GET,POST,PUT,PATCH,DELETE,OPTIONS" disabled={!loaded}
          />
        </VbField>
        <VbField label="Allowed headers">
          <VbInput
            mono value={headers} onChange={(e) => setHeaders(e.target.value)}
            placeholder="Authorization,Content-Type,If-Match,X-VB-Idempotency-Key" disabled={!loaded}
          />
        </VbField>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "center" }}>
        <VbField label="Preflight cache (seconds)">
          <VbInput
            mono type="number" min={0} value={maxAge}
            onChange={(e) => setMaxAge(e.target.value)} disabled={!loaded}
          />
        </VbField>
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 18 }}>
          <Toggle on={credentials} onChange={setCredentials} />
          <span style={{ fontSize: 12, color: "var(--vb-fg-2)" }}>
            Allow credentials (cookies / Authorization)
          </span>
        </div>
      </div>

      {wildcardWithCreds && (
        <div style={{
          padding: "8px 10px", borderRadius: 5,
          background: "var(--vb-status-danger-bg)",
          color: "var(--vb-status-danger)",
          fontSize: 12, display: "flex", alignItems: "center", gap: 8,
        }}>
          <Icon name="alert" size={13} />
          <span>
            <VbCode>*</VbCode> origin + credentials is not permitted by browsers.
            Vaultbase will echo the matched origin instead.
          </span>
        </div>
      )}

      <SaveBar saving={saving} dirty={loaded} onSave={save} />
    </SectionShell>
  );
}

// ── Security ────────────────────────────────────────────────────────────────
interface AdminSession {
  jti: string;
  admin_id: string;
  admin_email: string;
  issued_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  revoked: boolean;
}
interface Fingerprints {
  jwt_secret_fingerprint: string;
  encryption_key_fingerprint: string;
  encryption_key_present: boolean;
}
interface HeadersPreview {
  api: Record<string, string>;
  ui: Record<string, string>;
}

function shortRel(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 0) return `in ${Math.abs(diff) < 3600 ? Math.ceil(Math.abs(diff)/60) + "m" : Math.ceil(Math.abs(diff)/3600) + "h"}`;
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function SecuritySection() {
  return (
    <SectionShell id="security">
      {/* The five cards below keep their existing legacy chrome. They render
          as stacked card-style sections within the shared shell — only one
          page-level header per tab. */}
      <ActiveSessionsCard />
      <BruteForceCard />
      <TrustedProxiesCard />
      <FingerprintsCard />
      <HeadersPreviewCard />
    </SectionShell>
  );
}

function ActiveSessionsCard() {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    api.get<ApiResponse<AdminSession[]>>("/api/v1/admin/security/sessions?activeOnly=1").then((res) => {
      if (res.data) setSessions(res.data);
      setLoading(false);
    });
  }

  useEffect(() => { load(); }, []);

  async function revoke(jti: string) {
    const ok = await confirm({ title: "Revoke session?", message: `Adds ${jti.slice(0, 8)}… to the revocation list immediately.`, confirmLabel: "Revoke", danger: true });
    if (!ok) return;
    const res = await api.delete<ApiResponse<{ revoked: string }>>(`/api/v1/admin/security/sessions/${encodeURIComponent(jti)}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Session revoked");
    load();
  }

  async function logoutAll() {
    const ok = await confirm({ title: "Force-logout every admin?", message: "Every existing admin JWT is rejected immediately. You will be signed out — sign back in with your password.", confirmLabel: "Force logout all", danger: true });
    if (!ok) return;
    const res = await api.post<ApiResponse<{ count: number }>>("/api/v1/admin/security/force-logout-all", {});
    if (res.error) { toast(res.error, "info"); return; }
    toast(`${res.data?.count ?? 0} admin(s) signed out — your session ends now`);
    setTimeout(() => { window.location.href = "/_/login"; }, 600);
  }

  return (
    <SubCard
      title="Active admin sessions"
      meta={`${sessions.length} active · revoke individually or all at once`}
      right={
        <>
          <VbBtn kind="ghost" size="sm" icon="refresh" onClick={load} disabled={loading}>Refresh</VbBtn>
          <VbBtn kind="danger" size="sm" onClick={logoutAll}>Force logout all</VbBtn>
        </>
      }
    >
      {sessions.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--vb-fg-3)", fontSize: 12 }}>
          No active admin sessions.
        </div>
      ) : (
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{
              textAlign: "left",
              color: "var(--vb-fg-3)",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              borderBottom: "1px solid var(--vb-border)",
            }}>
              <th style={{ padding: "8px 10px" }}>Admin</th>
              <th style={{ padding: "8px 10px" }}>Issued</th>
              <th style={{ padding: "8px 10px" }}>Expires</th>
              <th style={{ padding: "8px 10px" }}>IP</th>
              <th style={{ padding: "8px 10px" }}>User-Agent</th>
              <th style={{ padding: "8px 10px" }}>jti</th>
              <th style={{ padding: "8px 10px", width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.jti} style={{
                borderBottom: "1px solid var(--vb-border)",
                opacity: s.revoked ? 0.5 : 1,
              }}>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--vb-fg)" }}>{s.admin_email}</td>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--vb-fg-3)" }}>{shortRel(s.issued_at)}</td>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--vb-fg-3)" }}>{shortRel(s.expires_at)}</td>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--vb-fg-3)" }}>{s.ip ?? "—"}</td>
                <td style={{ padding: "8px 10px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--vb-fg-3)" }} title={s.user_agent ?? ""}>{s.user_agent ?? "—"}</td>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--vb-fg-3)" }}>{s.jti.slice(0, 8)}…</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>
                  {s.revoked ? (
                    <VbPill tone="neutral">revoked</VbPill>
                  ) : (
                    <VbBtn kind="ghost" size="sm" onClick={() => revoke(s.jti)}>Revoke</VbBtn>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SubCard>
  );
}

function BruteForceCard() {
  const [enabled, setEnabled] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState("5");
  const [duration, setDuration] = useState("900");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        const m = parseInt(res.data["auth.lockout.max_attempts"] ?? "0", 10);
        setEnabled(m > 0);
        setMaxAttempts(m > 0 ? String(m) : "5");
        setDuration(res.data["auth.lockout.duration_seconds"] ?? "900");
      }
      setLoaded(true);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "auth.lockout.max_attempts":     enabled ? maxAttempts.trim() || "0" : "0",
      "auth.lockout.duration_seconds": duration.trim() || "900",
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Lockout policy saved");
  }

  return (
    <SubCard
      title="Brute-force lockout"
      meta="per-email + per-IP failed-login throttle"
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{
            fontSize: 11, fontFamily: "var(--font-mono)",
            color: enabled ? "var(--vb-status-success)" : "var(--vb-fg-3)",
          }}>{enabled ? "enabled" : "off"}</span>
        </span>
      }
    >
      <div style={{ opacity: enabled ? 1 : 0.6, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <VbField label="Max failed attempts">
            <VbInput mono type="number" min={1} value={maxAttempts}
              onChange={(e) => setMaxAttempts(e.target.value)}
              disabled={!enabled || !loaded} />
          </VbField>
          <VbField label="Lockout duration (seconds)" hint="Default 900 (15 minutes). Min 60.">
            <VbInput mono type="number" min={60} value={duration}
              onChange={(e) => setDuration(e.target.value)}
              disabled={!enabled || !loaded} />
          </VbField>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.55 }}>
          Tracks both <VbCode>email:&lt;addr&gt;</VbCode> and <VbCode>ip:&lt;addr&gt;</VbCode> keys so a
          spray attack across emails from one IP gets caught alongside a single-account attack.
          Per-IP keying requires <VbCode>VAULTBASE_TRUSTED_PROXIES</VbCode> (or the proxies card below)
          to surface real client IPs through your reverse proxy.
        </div>
        <div style={{
          display: "flex", justifyContent: "flex-end",
          paddingTop: 12, borderTop: "1px solid var(--vb-border)",
        }}>
          <VbBtn kind="primary" size="sm" icon="check" onClick={save} disabled={!loaded || saving}>
            {saving ? "Saving…" : "Save changes"}
          </VbBtn>
        </div>
      </div>
    </SubCard>
  );
}

function TrustedProxiesCard() {
  const [value, setValue] = useState("");
  const [envFallback, setEnvFallback] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        setValue(res.data["security.trusted_proxies"] ?? "");
        setEnvFallback(res.data["security.trusted_proxies_env_view"] ?? "");
      }
      setLoaded(true);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "security.trusted_proxies": value.trim(),
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Trusted proxies saved");
  }

  return (
    <SubCard
      title="Trusted proxies"
      meta={<>CIDRs allowed to set <VbCode>X-Forwarded-For</VbCode></>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <VbField
          label="Allowed proxy CIDRs (comma-separated)"
          hint={
            <>
              Empty + no <VbCode>VAULTBASE_TRUSTED_PROXIES</VbCode> env → vaultbase ignores{" "}
              <VbCode>X-Forwarded-For</VbCode> entirely (defensive default). Set this when your
              reverse proxy / load balancer sits in front of vaultbase.
            </>
          }
        >
          <VbInput mono value={value} onChange={(e) => setValue(e.target.value)}
            placeholder="10.0.0.0/8,127.0.0.1/32" disabled={!loaded} />
        </VbField>
        {envFallback && !value.trim() && (
          <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
            Currently effective via env: <VbCode>{envFallback}</VbCode>
          </div>
        )}
        <div style={{
          display: "flex", justifyContent: "flex-end",
          paddingTop: 12, borderTop: "1px solid var(--vb-border)",
        }}>
          <VbBtn kind="primary" size="sm" icon="check" onClick={save} disabled={!loaded || saving}>
            {saving ? "Saving…" : "Save changes"}
          </VbBtn>
        </div>
      </div>
    </SubCard>
  );
}

function FingerprintsCard() {
  const [fp, setFp] = useState<Fingerprints | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<ApiResponse<Fingerprints>>("/api/v1/admin/security/fingerprints").then((res) => {
      if (res.data) setFp(res.data);
      setLoading(false);
    });
  }, []);

  return (
    <SubCard title="Secrets fingerprints" meta="read-only · SHA-256 first 8 bytes">
      {loading ? (
        <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>loading…</div>
      ) : !fp ? (
        <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>—</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <VbField label="JWT signing secret">
              <div style={{ fontSize: 13, color: "var(--vb-fg)", fontFamily: "var(--font-mono)" }}>
                {fp.jwt_secret_fingerprint}
              </div>
            </VbField>
            <VbField label="AES encryption key">
              <div style={{
                fontSize: 13,
                color: fp.encryption_key_present ? "var(--vb-fg)" : "var(--vb-fg-3)",
                fontFamily: "var(--font-mono)",
              }}>
                {fp.encryption_key_present
                  ? fp.encryption_key_fingerprint
                  : "(not set — encrypted fields disabled)"}
              </div>
            </VbField>
          </div>
          {!fp.encryption_key_present && (
            <div style={{
              padding: "8px 10px", borderRadius: 5,
              background: "var(--vb-status-warning-bg)",
              color: "var(--vb-status-warning)",
              fontSize: 12, display: "flex", alignItems: "center", gap: 8,
            }}>
              <Icon name="alert" size={13} />
              <span>
                No <VbCode>VAULTBASE_ENCRYPTION_KEY</VbCode> set — fields marked{" "}
                <VbCode>encrypted</VbCode> store plaintext.
              </span>
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.55 }}>
            Compare these across hosts in a fleet to confirm they share the same secrets. A
            mismatch means JWTs from one host won't verify on the other and encrypted fields
            written on one will be unreadable on the other.
          </div>
        </div>
      )}
    </SubCard>
  );
}

function HeadersPreviewCard() {
  const [preview, setPreview] = useState<HeadersPreview | null>(null);

  useEffect(() => {
    api.get<ApiResponse<HeadersPreview>>("/api/v1/admin/security/headers-preview").then((res) => {
      if (res.data) setPreview(res.data);
    });
  }, []);

  function renderTable(headers: Record<string, string> | undefined) {
    if (!headers) return <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>—</div>;
    const entries = Object.entries(headers);
    if (entries.length === 0) return <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>(no headers)</div>;
    return (
      <table style={{ width: "100%", fontSize: 11, fontFamily: "var(--font-mono)", borderCollapse: "collapse" }}>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} style={{ borderBottom: "1px solid var(--vb-border)" }}>
              <td style={{ padding: "5px 8px", color: "var(--vb-accent)", whiteSpace: "nowrap", verticalAlign: "top" }}>{k}</td>
              <td style={{ padding: "5px 8px", wordBreak: "break-all", color: "var(--vb-fg)" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <SubCard title="Security headers" meta="read-only · what vaultbase emits per response">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <VbField label="API responses">{renderTable(preview?.api)}</VbField>
        <VbField
          label="Admin UI / non-API responses"
          hint="CSP applies here only — the API surface returns JSON and doesn't need it."
        >
          {renderTable(preview?.ui)}
        </VbField>
      </div>
    </SubCard>
  );
}

// ── Password policy ─────────────────────────────────────────────────────────
function PasswordPolicySection() {
  const [minLen, setMinLen] = useState("12");
  const [reqUpper, setReqUpper] = useState(false);
  const [reqLower, setReqLower] = useState(false);
  const [reqDigit, setReqDigit] = useState(false);
  const [reqSymbol, setReqSymbol] = useState(false);
  const [hibp, setHibp] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        setMinLen(res.data["password.min_length"] ?? "12");
        setReqUpper((res.data["password.require_upper"] ?? "0") === "1");
        setReqLower((res.data["password.require_lower"] ?? "0") === "1");
        setReqDigit((res.data["password.require_digit"] ?? "0") === "1");
        setReqSymbol((res.data["password.require_symbol"] ?? "0") === "1");
        setHibp((res.data["password.hibp_check"] ?? "0") === "1");
      }
      setLoaded(true);
    });
  }, []);

  async function save() {
    const n = parseInt(minLen, 10);
    if (!Number.isFinite(n) || n < 8) { toast("Minimum length must be at least 8", "info"); return; }
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "password.min_length":     String(n),
      "password.require_upper":  reqUpper  ? "1" : "0",
      "password.require_lower":  reqLower  ? "1" : "0",
      "password.require_digit":  reqDigit  ? "1" : "0",
      "password.require_symbol": reqSymbol ? "1" : "0",
      "password.hibp_check":     hibp      ? "1" : "0",
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Password policy saved");
  }

  return (
    <SectionShell id="password-policy">
      <VbField
        label="Minimum length"
        hint="NIST 800-63B recommends at least 8 characters; OWASP recommends 12. Floor is 8."
      >
        <VbInput
          mono type="number" min={8} value={minLen}
          onChange={(e) => setMinLen(e.target.value)} disabled={!loaded}
          style={{ maxWidth: 120 }}
        />
      </VbField>

      <VbField
        label="Required character classes"
        hint="Off by default — modern guidance favors length over character-class complexity. Enable only if a compliance regime requires it."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { key: "upper",  label: "Uppercase letter (A-Z)", on: reqUpper,  set: setReqUpper  },
            { key: "lower",  label: "Lowercase letter (a-z)", on: reqLower,  set: setReqLower  },
            { key: "digit",  label: "Digit (0-9)",            on: reqDigit,  set: setReqDigit  },
            { key: "symbol", label: "Symbol (anything non-alphanumeric)", on: reqSymbol, set: setReqSymbol },
          ].map((row) => (
            <div key={row.key} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <Toggle on={row.on} onChange={row.set} />
              <span style={{ fontSize: 12, color: "var(--vb-fg-2)" }}>{row.label}</span>
            </div>
          ))}
        </div>
      </VbField>

      <VbField
        label="Have-I-Been-Pwned check"
        hint={
          <>
            Reject passwords found in known breach corpora. Uses the{" "}
            <VbCode>api.pwnedpasswords.com</VbCode> k-anonymity API — only the first 5 SHA-1
            characters leave the server. Fails open on network error so a downed API doesn't
            lock signups.
          </>
        }
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Toggle on={hibp} onChange={setHibp} />
          <span style={{ fontSize: 12, color: "var(--vb-fg-2)" }}>Block breached passwords</span>
        </div>
      </VbField>

      <SaveBar saving={saving} dirty={loaded} onSave={save} />
    </SectionShell>
  );
}

// ── Health & metrics ────────────────────────────────────────────────────────
function MetricsSection() {
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        setEnabled((res.data["metrics.enabled"] ?? "0") === "1");
        setToken(res.data["metrics.token"] ?? "");
      }
      setLoaded(true);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "metrics.enabled": enabled ? "1" : "0",
      "metrics.token":   token.trim(),
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Metrics saved");
  }

  function regenerateToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    setToken(hex);
  }

  return (
    <SectionShell
      id="metrics"
      sub={<>Prometheus exposition at <VbCode>/api/v1/metrics</VbCode>.</>}
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{
            fontSize: 11, fontFamily: "var(--font-mono)",
            color: enabled ? "var(--vb-status-success)" : "var(--vb-fg-3)",
          }}>{enabled ? "enabled" : "off"}</span>
        </span>
      }
    >
      <VbField
        label="Bearer token (optional)"
        hint={
          <>
            When set, scrapers must send <VbCode>Authorization: Bearer &lt;token&gt;</VbCode>.
            Leave blank to expose <VbCode>/api/v1/metrics</VbCode> publicly — only do this
            if the endpoint is protected at the proxy layer.
          </>
        }
      >
        <div style={{ display: "flex", gap: 8 }}>
          <VbInput
            mono
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="(blank = no auth)"
            disabled={!loaded}
            style={{ flex: 1 }}
          />
          <VbBtn kind="ghost" size="sm" onClick={regenerateToken} icon="refresh">Generate</VbBtn>
        </div>
      </VbField>

      <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.6 }}>
        Endpoint format: <VbCode>text/plain; version=0.0.4</VbCode> — the standard Prometheus
        exposition. Exports request RPS, total counter, uptime, per-step latency summary
        (p50/p90/p99/p99.9), and SQLite page/WAL gauges. Always available to admins as JSON at{" "}
        <VbCode>/_/metrics</VbCode>.
      </div>

      <SaveBar saving={saving} dirty={loaded} onSave={save} />
    </SectionShell>
  );
}

// ── Update checker ──────────────────────────────────────────────────────────
function relativeShort(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60)    return `${diff}s`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

interface UpdateStatus {
  current_version: string;
  latest_version: string | null;
  checked_at: number | null;
  enabled: boolean;
  update_available: boolean;
  last_error: string | null;
}

function UpdatesSection() {
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  function loadStatus() {
    return api.get<ApiResponse<UpdateStatus>>("/api/v1/admin/update-status").then((res) => {
      if (res.data) {
        setStatus(res.data);
        setEnabled(res.data.enabled);
      }
    });
  }

  useEffect(() => { loadStatus().finally(() => setLoaded(true)); }, []);

  async function save() {
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "update_check.enabled": enabled ? "1" : "0",
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Update check saved");
    await loadStatus();
  }

  async function checkNow() {
    setChecking(true);
    const res = await api.post<ApiResponse<UpdateStatus>>("/api/v1/admin/update-status/check", {});
    setChecking(false);
    if (res.error) { toast(res.error, "info"); return; }
    if (res.data) setStatus(res.data);
  }

  return (
    <SectionShell
      id="updates"
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: enabled ? "var(--vb-status-success)" : "var(--vb-fg-3)",
            textTransform: "lowercase",
            letterSpacing: 0.3,
          }}>
            {enabled ? "auto-check on" : "off"}
          </span>
        </span>
      }
    >
      {status && (
        <div style={{
          padding: 16,
          borderRadius: 8,
          background: "var(--vb-bg-2)",
          border: `1px solid ${status.update_available ? "var(--vb-accent-soft)" : "var(--vb-border)"}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
              <div>
                <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)" }}>
                  Installed
                </div>
                <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, color: "var(--vb-fg)", fontFamily: "var(--font-mono)" }}>
                  v{status.current_version}
                </div>
              </div>
              <Icon
                name="chevronRight"
                size={14}
                style={{ color: status.update_available ? "var(--vb-accent)" : "var(--vb-fg-3)", flexShrink: 0 }}
              />
              <div>
                <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)" }}>
                  Latest
                </div>
                <div style={{
                  fontSize: 18, fontWeight: 600, lineHeight: 1.3,
                  color: status.update_available ? "var(--vb-accent)" : "var(--vb-fg)",
                  fontFamily: "var(--font-mono)",
                }}>
                  {status.latest_version ?? <span style={{ fontSize: 14, fontWeight: 400, color: "var(--vb-fg-3)" }}>—</span>}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <VbPill tone={status.update_available ? "accent" : status.latest_version ? "success" : "neutral"} dot>
                {status.update_available ? "update available" : status.latest_version ? "up to date" : "never checked"}
              </VbPill>
              <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>
                {status.checked_at ? `checked ${relativeShort(status.checked_at)} ago` : "—"}
              </span>
            </div>
          </div>
        </div>
      )}

      {status?.update_available && status.latest_version && (
        <a
          href={`https://github.com/vaultbase-sh/vaultbase/releases/tag/${status.latest_version}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "12px 14px", borderRadius: 6,
            background: "var(--vb-accent-soft)",
            border: "1px solid var(--vb-accent-soft)",
            color: "var(--vb-accent)",
            fontSize: 12.5, textDecoration: "none",
          }}
        >
          <Icon name="download" size={14} />
          <span style={{ flex: 1 }}>
            View release notes for <VbCode>{status.latest_version}</VbCode> on GitHub
          </span>
          <Icon name="chevronRight" size={12} />
        </a>
      )}

      {status?.last_error && (
        <div style={{
          padding: "10px 12px", borderRadius: 6,
          background: "var(--vb-status-danger-bg)",
          color: "var(--vb-status-danger)",
          fontSize: 12, display: "flex", gap: 8, alignItems: "center",
        }}>
          <Icon name="alert" size={13} />
          <span>Last check failed: {status.last_error}</span>
        </div>
      )}

      <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.6 }}>
        Polls <VbCode>api.github.com/repos/vaultbase-sh/vaultbase/releases/latest</VbCode> on boot
        (after a 30 s delay) and every 6 hours. Disable to silence the poller — no banner, no
        network call. Vaultbase never auto-updates; this is purely a notification.
      </div>

      <div style={{
        display: "flex", justifyContent: "space-between", gap: 8,
        paddingTop: 4, borderTop: "1px solid var(--vb-border)", marginTop: 4,
      }}>
        <VbBtn kind="ghost" size="sm" icon="refresh" onClick={checkNow} disabled={!loaded || checking || !enabled}>
          {checking ? "Checking…" : "Check now"}
        </VbBtn>
        <VbBtn kind="primary" size="sm" icon="check" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </VbBtn>
      </div>
    </SectionShell>
  );
}

// ── Backup / restore ─────────────────────────────────────────────────────────
function BackupSection() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);

  function handleDownload() {
    const token = getMemoryToken();
    fetch("/api/v1/admin/backup", {
      credentials: "same-origin",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        const cd = r.headers.get("content-disposition") ?? "";
        const m = cd.match(/filename="([^"]+)"/);
        const filename = m?.[1] ?? "vaultbase-backup.db";
        return r.blob().then((blob) => ({ blob, filename }));
      })
      .then(({ blob, filename }) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
        toast("Backup downloaded", "download");
      })
      .catch((e) => toast(`Backup failed: ${e instanceof Error ? e.message : String(e)}`, "info"));
  }

  async function handleRestore(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = await confirm({
      title: "Restore from backup",
      message: `Restore from "${file.name}"?\n\nThis will REPLACE all current data with the contents of the uploaded SQLite file. This cannot be undone.`,
      danger: true,
      confirmLabel: "Restore",
    });
    if (!ok) {
      e.target.value = "";
      return;
    }
    setRestoring(true);
    const fd = new FormData();
    fd.append("file", file);
    const token = getMemoryToken();
    try {
      const res = await fetch("/api/v1/admin/restore", {
        method: "POST",
        credentials: "same-origin",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        toast(`Restore failed: ${json.error ?? res.statusText}`, "info");
      } else {
        toast("Restored. Reloading…", "check");
        setTimeout(() => window.location.reload(), 800);
      }
    } catch (err) {
      toast(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, "info");
    } finally {
      setRestoring(false);
      e.target.value = "";
    }
  }

  return (
    <SectionShell id="backup">
      <VbField
        label="Download backup"
        hint={<>Downloads the live <VbCode>data.db</VbCode> file. Uploaded files are not included.</>}
      >
        <div>
          <VbBtn kind="ghost" size="sm" icon="download" onClick={handleDownload}>
            Download .db
          </VbBtn>
        </div>
      </VbField>

      <VbField
        label="Restore from backup"
        hint="Replaces all current data with the uploaded SQLite file. Existing JWTs remain valid (signing key unchanged)."
        right={<VbPill tone="warning" dot>destructive</VbPill>}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".db,application/octet-stream"
          style={{ display: "none" }}
          onChange={handleRestore}
        />
        <div>
          <VbBtn
            kind="danger"
            size="sm"
            icon="upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={restoring}
          >
            {restoring ? "Restoring…" : "Upload .db"}
          </VbBtn>
        </div>
      </VbField>
    </SectionShell>
  );
}

// ── SMTP / Email ─────────────────────────────────────────────────────────────
function SmtpSection() {
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [from, setFrom] = useState("");
  const [testTo, setTestTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        const s = res.data;
        setEnabled(s["smtp.enabled"] === "1" || s["smtp.enabled"] === "true");
        setHost(s["smtp.host"] ?? "");
        setPort(s["smtp.port"] ?? "587");
        setSecure(s["smtp.secure"] === "1" || s["smtp.secure"] === "true");
        setUser(s["smtp.user"] ?? "");
        setPass(s["smtp.pass"] ?? "");
        setFrom(s["smtp.from"] ?? "");
      }
      setLoading(false);
    });
  }, []);

  async function handleSave() {
    const portNum = parseInt(port);
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      toast("Port must be 1–65535", "info"); return;
    }
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "smtp.enabled": enabled ? "1" : "0",
      "smtp.host": host,
      "smtp.port": String(portNum),
      "smtp.secure": secure ? "1" : "0",
      "smtp.user": user,
      "smtp.pass": pass,
      "smtp.from": from,
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("SMTP settings saved");
  }

  async function handleTest() {
    if (!testTo.trim()) { toast("Enter a recipient email", "info"); return; }
    setTesting(true);
    const res = await api.post<ApiResponse<{ messageId: string }>>("/api/v1/admin/settings/smtp/test", {
      to: testTo.trim(),
    });
    setTesting(false);
    if (res.error) { toast(`Test failed: ${res.error}`, "info"); return; }
    toast(`Test email sent to ${testTo}`, "check");
  }

  return (
    <SectionShell
      id="smtp"
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{
            fontSize: 11, fontFamily: "var(--font-mono)",
            color: enabled ? "var(--vb-status-success)" : "var(--vb-fg-3)",
          }}>{enabled ? "enabled" : "disabled"}</span>
        </span>
      }
    >
      <div style={{ opacity: enabled ? 1 : 0.5, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 200px", gap: 14 }}>
          <VbField label="Host" hint={<>SMTP server hostname (e.g. <VbCode>smtp.resend.com</VbCode>)</>}>
            <VbInput mono value={host} onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.example.com" disabled={!enabled || loading} />
          </VbField>
          <VbField label="Port" hint="587 / 465 / 25">
            <VbInput mono type="number" min={1} max={65535} value={port}
              onChange={(e) => setPort(e.target.value)} disabled={!enabled || loading} />
          </VbField>
          <VbField label="Secure (TLS)" hint="On for port 465; off for STARTTLS on 587.">
            <div style={{ display: "flex", alignItems: "center", gap: 10, height: 32 }}>
              <Toggle on={secure} onChange={setSecure} />
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>
                {secure ? "TLS" : "STARTTLS"}
              </span>
            </div>
          </VbField>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <VbField label="Username" hint="SMTP auth username (often your email or API key id)">
            <VbInput mono value={user} onChange={(e) => setUser(e.target.value)}
              placeholder="apikey or user@example.com" autoComplete="off"
              disabled={!enabled || loading} />
          </VbField>
          <VbField label="Password" hint="SMTP auth password / API key.">
            <VbInput mono type="password" value={pass} onChange={(e) => setPass(e.target.value)}
              placeholder="••••••••" autoComplete="new-password"
              disabled={!enabled || loading} />
          </VbField>
        </div>

        <VbField label="From address" hint={<>Sender used in <VbCode>From:</VbCode> header</>}>
          <VbInput mono value={from} onChange={(e) => setFrom(e.target.value)}
            placeholder='"Vaultbase" <noreply@example.com>' disabled={!enabled || loading} />
        </VbField>
      </div>

      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexWrap: "wrap", gap: 10,
        paddingTop: 12, borderTop: "1px solid var(--vb-border)", marginTop: 4,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <VbInput
            mono
            style={{ width: 260 }}
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="test recipient email"
            disabled={!enabled || loading}
          />
          <VbBtn kind="ghost" size="sm" icon="send"
            onClick={handleTest} disabled={!enabled || loading || testing}>
            {testing ? "Sending…" : "Send test"}
          </VbBtn>
        </div>
        <VbBtn kind="primary" size="sm" icon="check"
          onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </VbBtn>
      </div>
    </SectionShell>
  );
}

// ── Email templates ──────────────────────────────────────────────────────────
const DEFAULT_VERIFY_SUBJECT = "Verify your email";
const DEFAULT_VERIFY_BODY =
  "Hi,\n\n" +
  "Click the link below to verify your email address for {{appUrl}}:\n\n" +
  "{{link}}\n\n" +
  "This link expires in 1 hour. If you didn't request this, you can ignore this email.\n";
const DEFAULT_RESET_SUBJECT = "Reset your password";
const DEFAULT_RESET_BODY =
  "Hi,\n\n" +
  "We received a request to reset the password for your {{appUrl}} account.\n" +
  "Click the link below to choose a new password:\n\n" +
  "{{link}}\n\n" +
  "This link expires in 1 hour. If you didn't request this, you can ignore this email.\n";

function EmailTemplatesSection() {
  const [appUrl, setAppUrl] = useState("");
  const [verifySubject, setVerifySubject] = useState(DEFAULT_VERIFY_SUBJECT);
  const [verifyBody, setVerifyBody] = useState(DEFAULT_VERIFY_BODY);
  const [resetSubject, setResetSubject] = useState(DEFAULT_RESET_SUBJECT);
  const [resetBody, setResetBody] = useState(DEFAULT_RESET_BODY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        setAppUrl(res.data["app.url"] ?? "");
        setVerifySubject(res.data["email.verify.subject"]?.trim() || DEFAULT_VERIFY_SUBJECT);
        setVerifyBody(res.data["email.verify.body"]?.trim() || DEFAULT_VERIFY_BODY);
        setResetSubject(res.data["email.reset.subject"]?.trim() || DEFAULT_RESET_SUBJECT);
        setResetBody(res.data["email.reset.body"]?.trim() || DEFAULT_RESET_BODY);
      }
      setLoading(false);
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "app.url": appUrl.trim(),
      "email.verify.subject": verifySubject,
      "email.verify.body": verifyBody,
      "email.reset.subject": resetSubject,
      "email.reset.body": resetBody,
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Email templates saved");
  }

  const taStyle: React.CSSProperties = {
    width: "100%", padding: "8px 10px",
    background: "var(--vb-bg-3)", border: "1px solid var(--vb-border-2)",
    borderRadius: 5, color: "var(--vb-fg)",
    fontFamily: "var(--font-mono)", fontSize: 12,
    outline: "none", resize: "vertical",
  };

  return (
    <SectionShell id="templates">
      <VbField
        label="App URL"
        hint={<>Base URL of your frontend. Used to build the <VbCode>{`{{link}}`}</VbCode> in emails.</>}
      >
        <VbInput mono value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://example.com" disabled={loading} />
      </VbField>

      <div style={{
        display: "flex", flexDirection: "column", gap: 10,
        padding: 14, borderRadius: 8,
        background: "var(--vb-bg-2)", border: "1px solid var(--vb-border)",
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--vb-fg)", marginBottom: 4 }}>
            Verification email
          </div>
          <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.5 }}>
            Sent on registration and via{" "}
            <VbCode>POST /api/v1/auth/:collection/request-verify</VbCode>. Variables:{" "}
            <VbCode>{`{{email}}`}</VbCode> <VbCode>{`{{token}}`}</VbCode>{" "}
            <VbCode>{`{{link}}`}</VbCode> <VbCode>{`{{appUrl}}`}</VbCode>{" "}
            <VbCode>{`{{collection}}`}</VbCode>
          </div>
        </div>
        <VbField label="Subject">
          <VbInput mono value={verifySubject} onChange={(e) => setVerifySubject(e.target.value)} disabled={loading} />
        </VbField>
        <VbField label="Body (plain text)">
          <textarea
            rows={8}
            value={verifyBody}
            onChange={(e) => setVerifyBody(e.target.value)}
            disabled={loading}
            style={taStyle}
          />
        </VbField>
      </div>

      <div style={{
        display: "flex", flexDirection: "column", gap: 10,
        padding: 14, borderRadius: 8,
        background: "var(--vb-bg-2)", border: "1px solid var(--vb-border)",
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--vb-fg)", marginBottom: 4 }}>
            Password reset email
          </div>
          <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.5 }}>
            Sent via <VbCode>POST /api/v1/auth/:collection/request-password-reset</VbCode>. Same
            variables as above.
          </div>
        </div>
        <VbField label="Subject">
          <VbInput mono value={resetSubject} onChange={(e) => setResetSubject(e.target.value)} disabled={loading} />
        </VbField>
        <VbField label="Body (plain text)">
          <textarea
            rows={8}
            value={resetBody}
            onChange={(e) => setResetBody(e.target.value)}
            disabled={loading}
            style={taStyle}
          />
        </VbField>
      </div>

      <SaveBar saving={saving} dirty={!loading} onSave={handleSave} />
    </SectionShell>
  );
}

// ── Auth features ────────────────────────────────────────────────────────────

interface AuthFeatureRow {
  key: "otp" | "mfa" | "anonymous" | "impersonation";
  label: string;
  description: React.ReactNode;
  defaultOn: boolean;
}

const AUTH_FEATURES: AuthFeatureRow[] = [
  {
    key: "otp",
    label: "OTP / magic link",
    defaultOn: false,
    description: <>Passwordless sign-in via email — both a 6-digit code and a magic link. Requires SMTP. Endpoints: <code style={codeStyle}>POST /api/v1/auth/&lt;col&gt;/otp/&#123;request,auth&#125;</code>.</>,
  },
  {
    key: "mfa",
    label: "MFA / TOTP (2FA)",
    defaultOn: true,
    description: <>RFC 6238 TOTP with authenticator apps. Disabling blocks new enrollment but lets existing users still sign in and disable their own MFA. Endpoints: <code style={codeStyle}>POST /api/v1/auth/&lt;col&gt;/totp/&#123;setup,confirm,disable&#125;</code>.</>,
  },
  {
    key: "anonymous",
    label: "Anonymous sign-in",
    defaultOn: false,
    description: <>Mints a guest user with no email/password — useful for guest carts or onboarding before signup. Sessions live 30 days. Endpoint: <code style={codeStyle}>POST /api/v1/auth/&lt;col&gt;/anonymous</code>.</>,
  },
  {
    key: "impersonation",
    label: "Admin impersonation",
    defaultOn: true,
    description: <>Admin mints a 1-hour user JWT for support purposes. JWT carries <code style={codeStyle}>impersonated_by</code> for audit. Endpoint: <code style={codeStyle}>POST /api/v1/admin/impersonate/&lt;col&gt;/&lt;userId&gt;</code>.</>,
  },
];

function AuthFeaturesSection() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) setConfig(res.data);
      setLoading(false);
    });
  }, []);

  function isOn(key: string, defaultOn: boolean): boolean {
    const v = config[`auth.${key}.enabled`];
    if (v === undefined) return defaultOn;
    return v === "1" || v === "true";
  }
  function setKey(key: string, on: boolean) {
    setConfig((prev) => ({ ...prev, [`auth.${key}.enabled`]: on ? "1" : "0" }));
  }

  async function handleSave() {
    setSaving(true);
    const payload: Record<string, string> = {};
    for (const f of AUTH_FEATURES) {
      payload[`auth.${f.key}.enabled`] = isOn(f.key, f.defaultOn) ? "1" : "0";
    }
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", payload);
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Auth features saved");
  }

  return (
    <SectionShell id="auth">
      <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
        Disabled features return <VbCode>422</VbCode> from their endpoints. Disabling MFA blocks
        new enrollment only — already-enrolled users keep working.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {AUTH_FEATURES.map((f) => {
          const on = isOn(f.key, f.defaultOn);
          return (
            <div
              key={f.key}
              style={{
                border: "1px solid var(--vb-border)",
                borderRadius: 7,
                padding: "12px 14px",
                background: on ? "var(--vb-bg-2)" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2, color: "var(--vb-fg)" }}>
                    {f.label}
                  </div>
                  <div style={{ fontSize: 11, lineHeight: 1.55, color: "var(--vb-fg-3)" }}>
                    {f.description}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <Toggle on={on} onChange={(v) => setKey(f.key, v)} />
                  <span style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: on ? "var(--vb-status-success)" : "var(--vb-fg-3)",
                    minWidth: 56,
                  }}>
                    {on ? "enabled" : "disabled"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <SaveBar saving={saving} dirty={!loading} onSave={handleSave} />
    </SectionShell>
  );
}

// ── Session lifetimes (JWT windows, including anonymous) ────────────────────

interface SessionKindRow {
  kind: "anonymous" | "user" | "admin" | "impersonate" | "refresh" | "file";
  label: string;
  description: string;
  defaultSeconds: number;
}

const SESSION_KINDS: SessionKindRow[] = [
  { kind: "anonymous",   label: "Anonymous", description: "Guest sessions minted by POST /api/v1/auth/:collection/anonymous.",            defaultSeconds: 30 * 24 * 3600 },
  { kind: "user",        label: "User",      description: "Standard user JWTs (login, register, OAuth2, magic link).",                  defaultSeconds:  7 * 24 * 3600 },
  { kind: "admin",       label: "Admin",     description: "Admin JWTs minted by POST /api/v1/admin/auth/login.",                            defaultSeconds:  7 * 24 * 3600 },
  { kind: "impersonate", label: "Impersonate", description: "JWTs issued by admin impersonation. Keep short — these escalate access.",  defaultSeconds:       3600 },
  { kind: "refresh",     label: "Refresh",   description: "Window applied when /refresh re-mints a token. Acts as the sliding ratchet.", defaultSeconds:  7 * 24 * 3600 },
  { kind: "file",        label: "File access", description: "Protected-file URLs minted via POST /api/v1/files/.../token.",                defaultSeconds:       3600 },
];

function fmtDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0)  return `${seconds / 3600}h`;
  if (seconds % 60 === 0)    return `${seconds / 60}m`;
  return `${seconds}s`;
}

const PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "1 hour",  seconds:        3600 },
  { label: "1 day",   seconds:       86400 },
  { label: "7 days",  seconds:  7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
  { label: "90 days", seconds: 90 * 86400 },
];

function SessionLifetimesSection() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        const next: Record<string, string> = {};
        for (const k of SESSION_KINDS) {
          const v = res.data[`auth.${k.kind}.window_seconds`];
          next[k.kind] = v ?? String(k.defaultSeconds);
        }
        setValues(next);
      }
      setLoading(false);
    });
  }, []);

  function setVal(kind: SessionKindRow["kind"], value: string) {
    setValues((prev) => ({ ...prev, [kind]: value }));
  }

  async function handleSave() {
    // Client-side validation for clearer toast messages — server re-validates.
    for (const k of SESSION_KINDS) {
      const n = parseInt(values[k.kind] ?? "", 10);
      if (!Number.isFinite(n) || n < 60) {
        toast(`${k.label}: must be at least 60 seconds`, "info");
        return;
      }
      if (n > 365 * 86400) {
        toast(`${k.label}: must be at most 365 days`, "info");
        return;
      }
    }
    setSaving(true);
    const payload: Record<string, string> = {};
    for (const k of SESSION_KINDS) {
      payload[`auth.${k.kind}.window_seconds`] = String(parseInt(values[k.kind] ?? "0", 10));
    }
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", payload);
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Session lifetimes saved");
  }

  // Rendered as a sibling block under the "Auth" SectionShell (no own page
  // header — there's only one header per tab). Visually a card-style group.
  return (
    <div style={{
      padding: "20px 28px 32px",
      borderTop: "1px solid var(--vb-border)",
      display: "flex", flexDirection: "column", gap: 16,
    }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--vb-fg)", marginBottom: 4 }}>
          Session lifetimes
        </h2>
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.55 }}>
          JWT <VbCode>exp</VbCode> window per token kind, in seconds. Changing a window affects{" "}
          <strong style={{ color: "var(--vb-fg-2)" }}>newly issued</strong> tokens only — existing
          tokens keep their original expiry. To revoke active sessions immediately, rotate the JWT
          secret in <VbCode>data_dir/.secret</VbCode> and restart.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {SESSION_KINDS.map((k) => {
          const current = parseInt(values[k.kind] ?? String(k.defaultSeconds), 10);
          const isDefault = current === k.defaultSeconds;
          return (
            <div
              key={k.kind}
              style={{
                border: "1px solid var(--vb-border)",
                borderRadius: 7,
                padding: "12px 14px",
                background: "var(--vb-bg-2)",
              }}
            >
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--vb-fg)" }}>
                  {k.label}{" "}
                  <span style={{
                    fontSize: 10.5, fontWeight: 400, color: "var(--vb-fg-3)",
                    fontFamily: "var(--font-mono)",
                  }}>
                    ({fmtDuration(current)}{isDefault ? " · default" : ""})
                  </span>
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.55, color: "var(--vb-fg-3)", marginTop: 2 }}>
                  {k.description}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <VbInput
                  mono type="number" min={60} max={365 * 86400}
                  value={values[k.kind] ?? ""}
                  onChange={(e) => setVal(k.kind, e.target.value)}
                  disabled={loading}
                  style={{ width: 140 }}
                />
                <span style={{ fontSize: 11, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)" }}>seconds</span>
                {PRESETS.map((p) => (
                  <VbBtn
                    key={p.label}
                    kind="ghost"
                    size="sm"
                    onClick={() => setVal(k.kind, String(p.seconds))}
                    disabled={loading}
                    style={{ height: 24, padding: "0 8px", fontSize: 11 }}
                  >
                    {p.label}
                  </VbBtn>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <SaveBar saving={saving} dirty={!loading} onSave={handleSave} />
    </div>
  );
}

// ── OAuth2 ───────────────────────────────────────────────────────────────────

interface OAuthProviderExtraField {
  /** Full settings key, e.g. `oauth2.apple.team_id`. */
  key: string;
  label: string;
  /** "text" by default; "password" hides the value, "textarea" renders multi-line. */
  type?: "text" | "password" | "textarea";
  placeholder?: string;
}

interface OAuthProviderRow {
  name: string;
  displayName: string;
  helpUrl: string;
  redirectHint: string;
  /**
   * Apple uses a non-standard credential set (Services ID + Team ID + Key ID +
   * private key). OIDC needs URLs + scopes + display name. Standard providers
   * skip this and lean on the universal client_id + client_secret pair.
   */
  hideStandardClientSecret?: boolean;
  hideStandardClientId?: boolean;
  extraFields?: OAuthProviderExtraField[];
}

const OAUTH_PROVIDERS: OAuthProviderRow[] = [
  { name: "google",    displayName: "Google",    helpUrl: "https://console.cloud.google.com/apis/credentials",            redirectHint: "Add your callback URL to the OAuth client's Authorized redirect URIs." },
  { name: "github",    displayName: "GitHub",    helpUrl: "https://github.com/settings/developers",                        redirectHint: "Set the OAuth App's Authorization callback URL to your callback URL." },
  { name: "gitlab",    displayName: "GitLab",    helpUrl: "https://gitlab.com/-/profile/applications",                     redirectHint: "Add your callback URL to the application's Redirect URIs and grant the read_user scope." },
  { name: "facebook",  displayName: "Facebook",  helpUrl: "https://developers.facebook.com/apps",                          redirectHint: "Configure the Facebook Login product with your callback URL as a Valid OAuth Redirect URI." },
  { name: "microsoft", displayName: "Microsoft", helpUrl: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps",   redirectHint: "Register a Web platform with your callback URL; multitenant + personal accounts both supported." },
  { name: "discord",   displayName: "Discord",   helpUrl: "https://discord.com/developers/applications",                    redirectHint: "Add your callback URL under OAuth2 → Redirects." },
  { name: "twitch",    displayName: "Twitch",    helpUrl: "https://dev.twitch.tv/console/apps",                            redirectHint: "Set your callback URL as the OAuth Redirect URL." },
  { name: "spotify",   displayName: "Spotify",   helpUrl: "https://developer.spotify.com/dashboard",                       redirectHint: "Add your callback URL under Edit settings → Redirect URIs." },
  { name: "linkedin",  displayName: "LinkedIn",  helpUrl: "https://www.linkedin.com/developers/apps",                       redirectHint: "Add your callback URL under Auth → Authorized redirect URLs; enable Sign In with LinkedIn using OpenID Connect." },
  { name: "slack",     displayName: "Slack",     helpUrl: "https://api.slack.com/apps",                                    redirectHint: "Under OpenID Connect, add your callback URL to the Redirect URLs." },
  { name: "bitbucket", displayName: "Bitbucket", helpUrl: "https://bitbucket.org/account/settings/app-passwords/",          redirectHint: "Create an OAuth consumer with your callback URL; grant Account: Email + Read." },
  { name: "notion",    displayName: "Notion",    helpUrl: "https://www.notion.so/my-integrations",                          redirectHint: "Configure a public OAuth integration; add your callback URL." },
  { name: "patreon",   displayName: "Patreon",   helpUrl: "https://www.patreon.com/portal/registration/register-clients",   redirectHint: "Add your callback URL to the client's Redirect URIs." },
  // Apple uses a JWT-as-client-secret signed locally with the Apple-issued private key.
  {
    name: "apple",
    displayName: "Apple",
    helpUrl: "https://developer.apple.com/account/resources/identifiers/list/serviceId",
    redirectHint: "Configure your Services ID with your callback URL as a Return URL; the private key file (.p8) belongs to a Sign In with Apple-enabled key.",
    hideStandardClientSecret: true,
    extraFields: [
      { key: "oauth2.apple.team_id",     label: "Team ID",     placeholder: "10-char Apple Developer Team ID" },
      { key: "oauth2.apple.key_id",      label: "Key ID",      placeholder: "10-char Key ID for your .p8" },
      { key: "oauth2.apple.private_key", label: "Private key (PEM)", type: "textarea",
        placeholder: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----" },
    ],
  },
  // Twitter v2 OAuth2 — PKCE is auto-engaged server-side.
  {
    name: "twitter",
    displayName: "Twitter / X",
    helpUrl: "https://developer.twitter.com/en/portal/projects-and-apps",
    redirectHint: "In your Twitter app's User authentication settings, add your callback URL. Email is gated behind Elevated access; provider_email may be a placeholder.",
  },
  // OIDC — endpoint URLs + display name come from settings.
  {
    name: "oidc",
    displayName: "OIDC (generic)",
    helpUrl: "https://openid.net/connect/",
    redirectHint: "Configure any OIDC-compliant IdP (Auth0, Keycloak, Okta, etc.) — set the display name to override how it's labeled to end users.",
    extraFields: [
      { key: "oauth2.oidc.display_name",      label: "Display name", placeholder: "Auth0 / Keycloak / …" },
      { key: "oauth2.oidc.authorization_url", label: "Authorization URL", placeholder: "https://your-idp/authorize" },
      { key: "oauth2.oidc.token_url",         label: "Token URL",         placeholder: "https://your-idp/oauth/token" },
      { key: "oauth2.oidc.userinfo_url",      label: "Userinfo URL",      placeholder: "https://your-idp/userinfo" },
      { key: "oauth2.oidc.scopes",            label: "Scopes",            placeholder: "openid profile email" },
    ],
  },
];

function OAuth2Section() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Collapsed by default — clicking a row's header toggles it.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) setConfig(res.data);
      setLoading(false);
    });
  }, []);

  function get(key: string): string {
    return config[key] ?? "";
  }
  function set(key: string, value: string) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }
  function isOn(name: string): boolean {
    const v = config[`oauth2.${name}.enabled`];
    return v === "1" || v === "true";
  }
  function toggleExpanded(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    const payload: Record<string, string> = {};
    for (const p of OAUTH_PROVIDERS) {
      payload[`oauth2.${p.name}.enabled`] = isOn(p.name) ? "1" : "0";
      if (!p.hideStandardClientId) {
        payload[`oauth2.${p.name}.client_id`] = get(`oauth2.${p.name}.client_id`);
      }
      if (!p.hideStandardClientSecret) {
        payload[`oauth2.${p.name}.client_secret`] = get(`oauth2.${p.name}.client_secret`);
      }
      for (const f of p.extraFields ?? []) {
        payload[f.key] = get(f.key);
      }
    }
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", payload);
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("OAuth2 providers saved");
  }

  const enabledCount = OAUTH_PROVIDERS.filter((p) => isOn(p.name)).length;

  return (
    <SectionShell
      id="oauth2"
      right={
        <VbPill tone={enabledCount > 0 ? "success" : "neutral"} dot>
          {enabledCount} of {OAUTH_PROVIDERS.length} enabled
        </VbPill>
      }
    >
      <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.55 }}>
        Enable a provider to expose it via{" "}
        <VbCode>GET /api/v1/auth/&lt;collection&gt;/oauth2/providers</VbCode>. Your app drives the
        popup + state, then POSTs the code to{" "}
        <VbCode>/api/v1/auth/&lt;collection&gt;/oauth2/exchange</VbCode>.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {OAUTH_PROVIDERS.map((p) => {
          const on = isOn(p.name);
          const isExpanded = expanded.has(p.name);
          return (
            <div
              key={p.name}
              style={{
                background: on ? "var(--vb-bg-2)" : "transparent",
                border: "1px solid var(--vb-border)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <div
                onClick={() => toggleExpanded(p.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <Icon name={isExpanded ? "chevronDown" : "chevronRight"} size={12} />
                <ProviderLogo provider={p.name} size={20} />
                <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--vb-fg)" }}>
                  {p.displayName}
                </div>
                {on && <VbPill tone="success" dot>enabled</VbPill>}
                <div onClick={(e) => e.stopPropagation()}>
                  <Toggle
                    on={on}
                    onChange={(v) => set(`oauth2.${p.name}.enabled`, v ? "1" : "0")}
                  />
                </div>
              </div>

              {isExpanded && (
                <div style={{
                  padding: "14px 14px 14px 48px",
                  borderTop: "1px solid var(--vb-border)",
                  background: "var(--vb-bg-1)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    {!p.hideStandardClientId && (
                      <VbField label={p.name === "apple" ? "Services ID" : "Client ID"}>
                        <VbInput mono value={get(`oauth2.${p.name}.client_id`)}
                          onChange={(e) => set(`oauth2.${p.name}.client_id`, e.target.value)}
                          placeholder="client identifier" autoComplete="off"
                          disabled={loading} />
                      </VbField>
                    )}
                    {!p.hideStandardClientSecret && (
                      <VbField label="Client secret">
                        <VbInput mono type="password"
                          value={get(`oauth2.${p.name}.client_secret`)}
                          onChange={(e) => set(`oauth2.${p.name}.client_secret`, e.target.value)}
                          placeholder="••••••••" autoComplete="new-password"
                          disabled={loading} />
                      </VbField>
                    )}
                  </div>

                  {p.extraFields && p.extraFields.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {p.extraFields.map((f) => (
                        <VbField key={f.key} label={f.label}>
                          {f.type === "textarea" ? (
                            <textarea
                              value={get(f.key)}
                              onChange={(e) => set(f.key, e.target.value)}
                              placeholder={f.placeholder}
                              autoComplete="off"
                              rows={6}
                              disabled={loading}
                              style={{
                                width: "100%", padding: "8px 10px",
                                background: "var(--vb-bg-3)",
                                border: "1px solid var(--vb-border-2)",
                                borderRadius: 5, color: "var(--vb-fg)",
                                fontFamily: "var(--font-mono)", fontSize: 11,
                                outline: "none", resize: "vertical",
                              }}
                            />
                          ) : (
                            <VbInput mono
                              type={f.type === "password" ? "password" : "text"}
                              value={get(f.key)}
                              onChange={(e) => set(f.key, e.target.value)}
                              placeholder={f.placeholder}
                              autoComplete="off"
                              disabled={loading} />
                          )}
                        </VbField>
                      ))}
                    </div>
                  )}

                  <div style={{
                    display: "flex", justifyContent: "space-between",
                    alignItems: "center", flexWrap: "wrap", gap: 8,
                  }}>
                    <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", flex: 1, lineHeight: 1.5 }}>
                      {p.redirectHint}
                    </div>
                    <a
                      href={p.helpUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        fontSize: 11.5, color: "var(--vb-accent)",
                        textDecoration: "none", fontWeight: 600,
                      }}
                    >
                      Get credentials ↗
                    </a>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <SaveBar saving={saving} dirty={!loading} onSave={handleSave} />
    </SectionShell>
  );
}

// ── Migrations ───────────────────────────────────────────────────────────────

interface MigrationsApplyResult {
  created: string[];
  updated: string[];
  skipped: string[];
  errors: Array<{ collection: string; error: string }>;
}

interface MigrationsDiffResult {
  added:     Array<{ name: string; type: string }>;
  modified:  Array<{ name: string; type: string; changes: string[] }>;
  unchanged: Array<{ name: string }>;
  removed:   Array<{ name: string }>;
}

function MigrationsSection() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"additive" | "sync">("additive");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<MigrationsApplyResult | null>(null);

  // Diff preview state — populated when admin selects a snapshot file.
  const [pendingSnapshot, setPendingSnapshot] = useState<object | null>(null);
  const [pendingFileName, setPendingFileName] = useState<string>("");
  const [diff, setDiff] = useState<MigrationsDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  function handleDownload() {
    const token = getMemoryToken();
    fetch("/api/v1/admin/migrations/snapshot", {
      credentials: "same-origin",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        const cd = r.headers.get("content-disposition") ?? "";
        const m = cd.match(/filename="([^"]+)"/);
        const filename = m?.[1] ?? "vaultbase-snapshot.json";
        return r.blob().then((blob) => ({ blob, filename }));
      })
      .then(({ blob, filename }) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
        toast("Snapshot downloaded", "download");
      })
      .catch((e) => toast(`Snapshot failed: ${e instanceof Error ? e.message : String(e)}`, "info"));
  }

  function clearPending() {
    setPendingSnapshot(null);
    setPendingFileName("");
    setDiff(null);
  }

  async function handleSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    let snapshot: object;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object") {
        toast("Snapshot must be a JSON object", "info");
        return;
      }
      snapshot = parsed;
    } catch {
      toast("Selected file is not valid JSON", "info");
      return;
    }
    setPendingSnapshot(snapshot);
    setPendingFileName(file.name);
    setDiff(null);
    setResult(null);
    setDiffLoading(true);
    const res = await api.post<ApiResponse<MigrationsDiffResult>>(
      "/api/v1/admin/migrations/diff",
      { snapshot }
    );
    setDiffLoading(false);
    if (res.error) {
      toast(`Diff failed: ${res.error}`, "info");
      clearPending();
      return;
    }
    setDiff(res.data ?? null);
  }

  async function handleApply() {
    if (!pendingSnapshot || !diff) return;
    if (mode === "sync") {
      const ok = await confirm({
        title: "Apply in sync mode",
        message:
          "Sync mode will UPDATE existing collections to match the snapshot — fields, rules, view queries. " +
          "Removed fields will drop their column (and data). Continue?",
        danger: true,
        confirmLabel: "Apply (sync)",
      });
      if (!ok) return;
    }
    setApplying(true);
    setResult(null);
    const res = await api.post<ApiResponse<MigrationsApplyResult>>(
      "/api/v1/admin/migrations/apply",
      { snapshot: pendingSnapshot, mode }
    );
    setApplying(false);
    if (res.error) { toast(res.error, "info"); return; }
    setResult(res.data ?? null);
    const d = res.data!;
    toast(
      `Applied: ${d.created.length} created · ${d.updated.length} updated · ${d.skipped.length} skipped${d.errors.length ? ` · ${d.errors.length} failed` : ""}`,
      d.errors.length ? "info" : "check"
    );
    // Clear pending after a successful apply so the panel resets.
    clearPending();
  }

  // For the summary line / button-disabled state, "will create" / "will update"
  // depend on the chosen mode: additive only creates, sync also updates.
  const willCreate = diff ? diff.added.length : 0;
  const willUpdate = diff ? (mode === "sync" ? diff.modified.length : 0) : 0;
  const willLeave  = diff
    ? diff.unchanged.length + (mode === "additive" ? diff.modified.length : 0)
    : 0;

  return (
    <SectionShell id="migrations">
      <VbField
        label="Download snapshot"
        hint="Exports every collection's full definition (name · type · fields · rules · view query) as a JSON file. Commit it to git, then upload it on a fresh install to recreate the schema."
      >
        <div>
          <VbBtn kind="ghost" size="sm" icon="download" onClick={handleDownload}>
            Download .json
          </VbBtn>
        </div>
      </VbField>

      <VbField
        label="Apply snapshot"
        hint={
          <>
            <strong style={{ color: "var(--vb-fg-2)" }}>Additive</strong> creates collections that don't exist yet — safe default.{" "}
            <strong style={{ color: "var(--vb-fg-2)" }}>Sync</strong> also updates existing collections to match the snapshot (fields, rules, view query).
            Neither mode ever deletes a collection.
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Dropdown
            value={mode}
            options={[
              { label: "Additive — create missing only", value: "additive" },
              { label: "Sync — also update existing (destructive)", value: "sync" },
            ]}
            onChange={(e) => setMode(e.value as "additive" | "sync")}
            style={{ height: 32, fontSize: 12 }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={handleSelectFile}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <VbBtn
              kind="ghost"
              size="sm"
              icon="upload"
              onClick={() => fileInputRef.current?.click()}
              disabled={applying || diffLoading}
            >
              {pendingFileName ? "Choose different file" : "Choose snapshot file"}
            </VbBtn>
            {pendingFileName && (
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--vb-fg-3)" }}>
                {pendingFileName}
              </span>
            )}
            {pendingFileName && (
              <button
                onClick={clearPending}
                disabled={applying}
                title="Clear selection"
                style={{
                  appearance: "none", border: 0, background: "transparent",
                  color: "var(--vb-fg-3)", cursor: "pointer", padding: 4,
                  marginLeft: "auto",
                }}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        </div>
      </VbField>

      {(diffLoading || diff !== null) && (
        <div style={{
          padding: "12px 14px", borderRadius: 7,
          background: "var(--vb-bg-2)", border: "1px solid var(--vb-border)",
        }}>
          {diffLoading && (
            <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>Computing diff…</div>
          )}

          {diff && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                <strong style={{ fontSize: 12, color: "var(--vb-fg)" }}>Preview</strong>
                <VbPill tone="success" dot>{diff.added.length} added</VbPill>
                <VbPill tone="warning" dot>{diff.modified.length} modified</VbPill>
                <VbPill tone="neutral" dot>{diff.unchanged.length} unchanged</VbPill>
                <VbPill tone="danger" dot>{diff.removed.length} removed</VbPill>
              </div>

              <div style={{ fontSize: 12, color: "var(--vb-fg-2)", marginBottom: 10 }}>
                Will create <strong>{willCreate}</strong>
                {" · "}update <strong>{willUpdate}</strong>
                {" · "}leave <strong>{willLeave}</strong> unchanged
                {mode === "additive" && diff.modified.length > 0 && (
                  <span style={{ marginLeft: 6, color: "var(--vb-fg-3)" }}>
                    ({diff.modified.length} drift visible — switch to Sync to update)
                  </span>
                )}
              </div>

              {diff.added.length > 0 && (
                <DiffGroup label="Added" tone="success">
                  {diff.added.map((a) => (
                    <DiffLine key={a.name} name={a.name} suffix={a.type} />
                  ))}
                </DiffGroup>
              )}

              {diff.modified.length > 0 && (
                <DiffGroup label="Modified" tone="warning">
                  {diff.modified.map((m) => (
                    <details key={m.name} style={{ fontSize: 11, lineHeight: 1.7 }}>
                      <summary style={{ cursor: "pointer", color: "var(--vb-fg)" }}>
                        <span style={{ fontFamily: "var(--font-mono)" }}>{m.name}</span>
                        <span style={{ color: "var(--vb-fg-3)", marginLeft: 6 }}>{m.type}</span>
                        <span style={{ color: "var(--vb-fg-3)", marginLeft: 6 }}>
                          · {m.changes.length} change{m.changes.length === 1 ? "" : "s"}
                        </span>
                      </summary>
                      <ul style={{ margin: "4px 0 6px 0", paddingLeft: 20, color: "var(--vb-fg-2)" }}>
                        {m.changes.map((c, i) => (
                          <li key={i} style={{ fontFamily: "var(--font-mono)" }}>{c}</li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </DiffGroup>
              )}

              {diff.unchanged.length > 0 && (
                <DiffGroup label="Unchanged" tone="muted">
                  {diff.unchanged.map((u) => (
                    <DiffLine key={u.name} name={u.name} muted />
                  ))}
                </DiffGroup>
              )}

              {diff.removed.length > 0 && (
                <DiffGroup label="Removed" tone="danger" note="(not deleted by apply)">
                  {diff.removed.map((r) => (
                    <DiffLine key={r.name} name={r.name} />
                  ))}
                </DiffGroup>
              )}
            </>
          )}
        </div>
      )}

      {pendingSnapshot && (
        <div style={{
          display: "flex", justifyContent: "flex-end", gap: 8,
          paddingTop: 12, borderTop: "1px solid var(--vb-border)",
        }}>
          <VbBtn
            kind="primary"
            size="sm"
            icon="upload"
            onClick={handleApply}
            disabled={applying || diffLoading || !diff}
          >
            {applying ? "Applying…" : mode === "sync" ? "Apply (sync mode)" : "Apply"}
          </VbBtn>
        </div>
      )}

      {result && (
        <div style={{
          display: "flex", flexDirection: "column", gap: 6,
          padding: "12px 14px", borderRadius: 7,
          background: result.errors.length > 0 ? "var(--vb-status-danger-bg)" : "var(--vb-bg-2)",
          border: "1px solid var(--vb-border)",
        }}>
          {(["created", "updated", "skipped"] as const).map((k) =>
            result[k].length > 0 ? (
              <div key={k} style={{ fontSize: 12 }}>
                <span style={{
                  color: "var(--vb-fg-3)",
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: 1.2,
                  marginRight: 8, fontSize: 10.5,
                }}>{k}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vb-fg)" }}>
                  {result[k].join(", ")}
                </span>
              </div>
            ) : null
          )}
          {result.errors.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--vb-status-danger)" }}>
              <div style={{ marginBottom: 4 }}>Errors:</div>
              {result.errors.map((e, i) => (
                <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 11, paddingLeft: 8 }}>
                  • {e.collection}: {e.error}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </SectionShell>
  );
}

// ── Diff preview helpers ─────────────────────────────────────────────────────
function DiffGroup({
  label,
  tone,
  note,
  children,
}: {
  label: string;
  tone: "success" | "warning" | "muted" | "danger";
  note?: string;
  children: React.ReactNode;
}) {
  const color =
    tone === "success" ? "var(--success)"
    : tone === "warning" ? "var(--warning)"
    : tone === "danger"  ? "var(--danger)"
    : "var(--text-muted)";
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
        {label}
        {note && (
          <span className="muted" style={{ marginLeft: 6, textTransform: "none", letterSpacing: 0, fontStyle: "italic" }}>
            {note}
          </span>
        )}
      </div>
      <div style={{ paddingLeft: 4 }}>{children}</div>
    </div>
  );
}

function DiffLine({ name, suffix, muted }: { name: string; suffix?: string; muted?: boolean }) {
  return (
    <div style={{ fontSize: 11, lineHeight: 1.7, color: muted ? "var(--text-muted)" : "var(--text-primary)" }}>
      <span className="mono">{name}</span>
      {suffix && <span className="muted" style={{ marginLeft: 6 }}>{suffix}</span>}
    </div>
  );
}

// ── File storage (local / S3 / R2) ──────────────────────────────────────────
function StorageSection() {
  const [driver, setDriver] = useState<"local" | "s3">("local");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("auto");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ driver: string; bucket?: string; endpoint?: string } | null>(null);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/v1/admin/settings").then((res) => {
      if (res.data) {
        const s = res.data;
        setDriver(s["storage.driver"] === "s3" ? "s3" : "local");
        setEndpoint(s["s3.endpoint"] ?? "");
        setBucket(s["s3.bucket"] ?? "");
        setRegion(s["s3.region"] ?? "auto");
        setAccessKeyId(s["s3.access_key_id"] ?? "");
        setSecretAccessKey(s["s3.secret_access_key"] ?? "");
        setPublicUrl(s["s3.public_url"] ?? "");
      }
      setLoading(false);
    });
    api.get<ApiResponse<{ driver: string; bucket?: string; endpoint?: string }>>(
      "/api/v1/admin/settings/storage/status"
    ).then((res) => { if (res.data) setStatus(res.data); });
  }, []);

  function applyR2Preset() {
    setRegion("auto");
    if (!endpoint) setEndpoint("https://<account-id>.r2.cloudflarestorage.com");
  }
  function applyS3Preset() {
    setRegion("us-east-1");
    setEndpoint("");
  }

  async function handleSave() {
    if (driver === "s3") {
      if (!bucket.trim())          { toast("Bucket name required", "info"); return; }
      if (!accessKeyId.trim())     { toast("Access key id required", "info"); return; }
      if (!secretAccessKey.trim()) { toast("Secret access key required", "info"); return; }
    }
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/v1/admin/settings", {
      "storage.driver": driver,
      "s3.endpoint": endpoint,
      "s3.bucket": bucket,
      "s3.region": region,
      "s3.access_key_id": accessKeyId,
      "s3.secret_access_key": secretAccessKey,
      "s3.public_url": publicUrl,
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Storage settings saved");
    const s = await api.get<ApiResponse<{ driver: string; bucket?: string; endpoint?: string }>>(
      "/api/v1/admin/settings/storage/status"
    );
    if (s.data) setStatus(s.data);
  }

  async function handleTest() {
    setTesting(true);
    const res = await api.post<ApiResponse<{ ok: boolean; driver: string }>>(
      "/api/v1/admin/settings/storage/test",
      {}
    );
    setTesting(false);
    if (res.error) { toast(`Test failed: ${res.error}`, "info"); return; }
    toast(`Storage test passed (${res.data?.driver})`, "check");
  }

  return (
    <SectionShell
      id="storage"
      right={status && (
        <span style={{ fontSize: 11, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)" }}>
          active: <span style={{ color: "var(--vb-accent)" }}>{status.driver}</span>
          {status.bucket && <> · {status.bucket}</>}
        </span>
      )}
    >
      <VbField label="Driver" hint="Switching drivers does not migrate existing files. Plan accordingly.">
        <Dropdown
          value={driver}
          options={[
            { label: "Local filesystem (default)", value: "local" },
            { label: "S3-compatible (AWS S3, Cloudflare R2, MinIO, …)", value: "s3" },
          ]}
          onChange={(e) => setDriver(e.value)}
          disabled={loading}
          style={{ height: 32, fontSize: 12 }}
        />
      </VbField>

      {driver === "s3" && (
        <>
          <VbField label="Preset" hint="One-click defaults for common providers.">
            <div style={{ display: "flex", gap: 8 }}>
              <VbBtn kind="ghost" size="sm" onClick={applyR2Preset}>Cloudflare R2</VbBtn>
              <VbBtn kind="ghost" size="sm" onClick={applyS3Preset}>AWS S3</VbBtn>
            </div>
          </VbField>

          <VbField
            label="Endpoint"
            hint={<>R2: <VbCode>{`https://<account-id>.r2.cloudflarestorage.com`}</VbCode>. AWS S3: leave blank.</>}
          >
            <VbInput mono value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://acc.r2.cloudflarestorage.com" />
          </VbField>

          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 14 }}>
            <VbField label="Bucket" hint="Must exist already. Vaultbase does not create buckets.">
              <VbInput mono value={bucket} onChange={(e) => setBucket(e.target.value)}
                placeholder="vaultbase-uploads" />
            </VbField>
            <VbField label="Region" hint={<>R2: <VbCode>auto</VbCode>. AWS: e.g. <VbCode>us-east-1</VbCode>.</>}>
              <VbInput mono value={region} onChange={(e) => setRegion(e.target.value)}
                placeholder="auto" />
            </VbField>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <VbField label="Access key ID" hint="For R2: an API token with Object Read & Write.">
              <VbInput mono value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)} autoComplete="off" />
            </VbField>
            <VbField
              label="Secret access key"
              hint="Stored encrypted at rest when VAULTBASE_ENCRYPTION_KEY is set."
            >
              <VbInput mono type="password" value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
                placeholder="••••••••" autoComplete="new-password" />
            </VbField>
          </div>

          <VbField
            label="Public URL"
            hint="Optional. If your bucket is fronted by a CDN, files link directly to it. Leave blank to proxy bytes through Vaultbase."
          >
            <VbInput mono value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)}
              placeholder="https://cdn.example.com" />
          </VbField>
        </>
      )}

      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 10, paddingTop: 12, borderTop: "1px solid var(--vb-border)", marginTop: 4,
      }}>
        <VbBtn kind="ghost" size="sm" icon="send" onClick={handleTest} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </VbBtn>
        <VbBtn kind="primary" size="sm" icon="check" onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </VbBtn>
      </div>
    </SectionShell>
  );
}

// ── Notifications (push providers) — V1 Refined per design handoff ──────────
//
// Layout: PageHeader (breadcrumb · title · paragraph · live-count pill) →
// channel tabs (Push / Inbox / Devices) → provider rows (collapsed
// status-first summary, expanded form + inline test). Visual language follows
// the --vb-* token block defined in globals.css.

interface NotificationProvidersResponse {
  onesignal: {
    enabled: boolean;
    app_id: string;
    api_key_set: boolean;
  };
  fcm: {
    enabled: boolean;
    project_id: string;
    service_account_set: boolean;
    service_account_bytes: number;
    service_account_client_email: string | null;
  };
}

type ProviderId = "onesignal" | "fcm";

interface ProviderState {
  id: ProviderId;
  configured: boolean;
  enabled: boolean;
  expanded: boolean;
}

function NotificationsSection() {
  const [cfg, setCfg] = useState<NotificationProvidersResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // ── OneSignal local form state
  const [osEnabled, setOsEnabled] = useState(false);
  const [osAppId, setOsAppId] = useState("");
  const [osApiKey, setOsApiKey] = useState("");
  const [osShowKey, setOsShowKey] = useState(false);
  const [osDirty, setOsDirty] = useState(false);
  const [osSaving, setOsSaving] = useState(false);
  const [osTesting, setOsTesting] = useState(false);

  // ── FCM local form state
  const [fcmEnabled, setFcmEnabled] = useState(false);
  const [fcmProjectId, setFcmProjectId] = useState("");
  const [fcmServiceAccount, setFcmServiceAccount] = useState("");
  const [fcmShowSa, setFcmShowSa] = useState(false);
  const [fcmDirty, setFcmDirty] = useState(false);
  const [fcmSaving, setFcmSaving] = useState(false);
  const [fcmTesting, setFcmTesting] = useState(false);

  // ── Per-row UI state
  const [expanded, setExpanded] = useState<Record<ProviderId, boolean>>({
    onesignal: true,   // default expanded since most operators start here
    fcm: false,
  });

  // ── Per-provider inline test
  const [osTestUid, setOsTestUid] = useState("");
  const [fcmTestUid, setFcmTestUid] = useState("");
  const [osTestSending, setOsTestSending] = useState(false);
  const [fcmTestSending, setFcmTestSending] = useState(false);

  function refresh(): Promise<void> {
    return api
      .get<ApiResponse<NotificationProvidersResponse>>("/api/v1/admin/notifications/providers")
      .then((res) => {
        if (res.data) {
          setCfg(res.data);
          setOsEnabled(res.data.onesignal.enabled);
          setOsAppId(res.data.onesignal.app_id);
          setFcmEnabled(res.data.fcm.enabled);
          setFcmProjectId(res.data.fcm.project_id);
          // Don't pre-fill secrets (they're masked server-side anyway).
          setOsApiKey("");
          setFcmServiceAccount("");
          setOsDirty(false);
          setFcmDirty(false);
        }
        setLoading(false);
      });
  }

  useEffect(() => { void refresh(); }, []);

  async function handleSaveOneSignal(): Promise<void> {
    setOsSaving(true);
    const body: Record<string, unknown> = {
      enabled: osEnabled,
      app_id: osAppId,
    };
    if (osApiKey) body.api_key = osApiKey;  // only patch when user typed a new value
    const res = await api.patch<ApiResponse<NotificationProvidersResponse> & { bootstrap?: { created: string[]; skipped: string[] } }>(
      "/api/v1/admin/notifications/providers/onesignal",
      body,
    );
    setOsSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    if (res.bootstrap?.created?.length) {
      toast(`OneSignal saved · bootstrapped collections: ${res.bootstrap.created.join(", ")}`, "check");
    } else {
      toast("OneSignal settings saved", "check");
    }
    await refresh();
  }

  async function handleTestOneSignal(): Promise<void> {
    setOsTesting(true);
    const res = await api.post<ApiResponse<{ ok: boolean; detail: string }>>(
      "/api/v1/admin/notifications/providers/onesignal/test-connection",
      {},
    );
    setOsTesting(false);
    if (res.error) { toast(`Test failed: ${res.error}`, "info"); return; }
    toast("OneSignal connection ✓", "check");
  }

  async function handleSaveFcm(): Promise<void> {
    setFcmSaving(true);
    const body: Record<string, unknown> = {
      enabled: fcmEnabled,
      project_id: fcmProjectId,
    };
    if (fcmServiceAccount) body.service_account = fcmServiceAccount;
    const res = await api.patch<ApiResponse<NotificationProvidersResponse> & { bootstrap?: { created: string[]; skipped: string[] } }>(
      "/api/v1/admin/notifications/providers/fcm",
      body,
    );
    setFcmSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    if (res.bootstrap?.created?.length) {
      toast(`FCM saved · bootstrapped collections: ${res.bootstrap.created.join(", ")}`, "check");
    } else {
      toast("FCM settings saved", "check");
    }
    await refresh();
  }

  async function handleTestFcm(): Promise<void> {
    setFcmTesting(true);
    const res = await api.post<ApiResponse<{ ok: boolean; detail: string }>>(
      "/api/v1/admin/notifications/providers/fcm/test-connection",
      {},
    );
    setFcmTesting(false);
    if (res.error) { toast(`Test failed: ${res.error}`, "info"); return; }
    toast("FCM connection ✓ (OAuth token minted)", "check");
  }

  async function handleSendTest(provider: ProviderId, uid: string): Promise<void> {
    if (!uid.trim()) { toast("Enter a user id", "info"); return; }
    const setSending = provider === "onesignal" ? setOsTestSending : setFcmTestSending;
    setSending(true);
    const res = await api.post<ApiResponse<{ inboxRowId: string | null; enqueued: { provider: string; jobId: string; deduped: boolean }[] }>>(
      "/api/v1/admin/notifications/test",
      { userId: uid.trim(), providers: [provider] },
    );
    setSending(false);
    if (res.error) { toast(res.error, "info"); return; }
    const enq = res.data?.enqueued ?? [];
    if (enq.length === 0) toast("Provider isn't enabled — nothing to send", "info");
    else toast(`Test enqueued via ${provider}`, "check");
  }

  // ── Computed
  const onesignalState: ProviderState = {
    id: "onesignal",
    configured: !!cfg?.onesignal.api_key_set && !!cfg?.onesignal.app_id,
    enabled: osEnabled && !!cfg?.onesignal.api_key_set && !!cfg?.onesignal.app_id,
    expanded: expanded.onesignal,
  };
  const fcmState: ProviderState = {
    id: "fcm",
    configured: !!cfg?.fcm.service_account_set,
    enabled: fcmEnabled && !!cfg?.fcm.service_account_set,
    expanded: expanded.fcm,
  };
  const liveCount = [onesignalState, fcmState].filter((s) => s.enabled && s.configured).length;
  const configuredCount = [onesignalState, fcmState].filter((s) => s.configured).length;

  function toggleExpand(id: ProviderId): void {
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
  }

  return (
    <SectionShell
      id="notifications"
      sub={
        <>
          Trigger code is provider-agnostic — call <VbCode>helpers.notify(userId, payload)</VbCode> from a hook and
          Vaultbase fans out to every enabled provider via the <VbCode>_notify</VbCode> queue.
        </>
      }
      right={
        <VbPill tone={liveCount > 0 ? "success" : "neutral"} dot>
          {liveCount > 0 ? `${liveCount} live` : "no providers live"}
        </VbPill>
      }
    >
      {/* Channel tabs (Push / Inbox / Devices) intentionally hidden until
          inbox + device-registry panels exist — single-tab strips are noise. */}

      {/* ── Push providers ───────────────────────────────────────────── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 0,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--vb-fg)" }}>Providers</h2>
          <span style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
            {liveCount} of 2 sending · enable any combination
          </span>
        </div>
        <VbBtn kind="ghost" size="sm" icon="plus" disabled>Add provider</VbBtn>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* ── OneSignal row ────────────────────────────────────────── */}
        <ProviderRow
          state={onesignalState}
          name="OneSignal"
          tagline="external_id-based · server-side fan-out"
          onToggleExpand={() => toggleExpand("onesignal")}
          onToggleEnable={(v) => { setOsEnabled(v); setOsDirty(true); }}
          onTestConnection={() => { void handleTestOneSignal(); }}
          testing={osTesting}
          loading={loading}
        >
          <OneSignalFields
            cfg={cfg}
            appId={osAppId}
            apiKey={osApiKey}
            showKey={osShowKey}
            dirty={osDirty}
            saving={osSaving}
            loading={loading}
            onAppId={(v) => { setOsAppId(v); setOsDirty(true); }}
            onApiKey={(v) => { setOsApiKey(v); setOsDirty(true); }}
            onToggleShowKey={() => setOsShowKey((v) => !v)}
            onSave={() => { void handleSaveOneSignal(); }}
            onReset={() => { void refresh(); }}
            testUid={osTestUid}
            onTestUid={setOsTestUid}
            onSendTest={() => { void handleSendTest("onesignal", osTestUid); }}
            testSending={osTestSending}
            testEnabled={onesignalState.enabled}
          />
        </ProviderRow>

        {/* ── FCM row ─────────────────────────────────────────────── */}
        <ProviderRow
          state={fcmState}
          name="Firebase Cloud Messaging"
          tagline="per-token · OAuth2 service account"
          onToggleExpand={() => toggleExpand("fcm")}
          onToggleEnable={(v) => { setFcmEnabled(v); setFcmDirty(true); }}
          onTestConnection={() => { void handleTestFcm(); }}
          testing={fcmTesting}
          loading={loading}
        >
          <FCMFields
            cfg={cfg}
            projectId={fcmProjectId}
            serviceAccount={fcmServiceAccount}
            showSa={fcmShowSa}
            dirty={fcmDirty}
            saving={fcmSaving}
            loading={loading}
            onProjectId={(v) => { setFcmProjectId(v); setFcmDirty(true); }}
            onServiceAccount={(v) => { setFcmServiceAccount(v); setFcmDirty(true); setFcmShowSa(true); }}
            onToggleShowSa={() => setFcmShowSa((v) => !v)}
            onSave={() => { void handleSaveFcm(); }}
            onReset={() => { void refresh(); }}
            testUid={fcmTestUid}
            onTestUid={setFcmTestUid}
            onSendTest={() => { void handleSendTest("fcm", fcmTestUid); }}
            testSending={fcmTestSending}
            testEnabled={fcmState.enabled}
          />
        </ProviderRow>
      </div>

      <SystemCollectionsHint />
    </SectionShell>
  );
}

// ── Provider row + expanded forms ────────────────────────────────────────────

const ProviderRow: React.FC<{
  state: ProviderState;
  name: string;
  tagline: string;
  onToggleExpand: () => void;
  onToggleEnable: (v: boolean) => void;
  onTestConnection: () => void;
  testing: boolean;
  loading: boolean;
  children: React.ReactNode;
}> = ({ state, name, tagline, onToggleExpand, onToggleEnable, onTestConnection, testing, loading, children }) => (
  <div style={{
    background: "var(--vb-bg-2)",
    border: "1px solid var(--vb-border)",
    borderRadius: 8,
    overflow: "hidden",
  }}>
    {/* Summary row — always visible */}
    <div
      onClick={onToggleExpand}
      style={{
        display: "grid",
        gridTemplateColumns: "20px 1fr auto auto auto",
        alignItems: "center",
        gap: 14,
        padding: "12px 14px",
        cursor: "pointer",
      }}
    >
      <Icon name={state.expanded ? "chevronDown" : "chevronRight"} size={12} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--vb-fg)" }}>{name}</span>
          <VbStatusDot state={state} />
        </div>
        <span style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>{tagline}</span>
      </div>

      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        fontSize: 11,
        color: "var(--vb-fg-3)",
        fontFamily: "var(--font-mono)",
      }}>
        {state.configured ? (
          // Stats are placeholders until a delivery-aggregation endpoint lands.
          // The slots stay so the visual rhythm matches the design.
          <>
            <VbStat label="24h" value="—" />
            <VbStat label="errors" value="—" />
            <VbStat label="last" value="—" />
          </>
        ) : (
          <span style={{ color: "var(--vb-fg-3)", fontStyle: "italic" }}>
            add credentials to enable
          </span>
        )}
      </div>

      <div onClick={(e) => e.stopPropagation()}>
        <VbBtn
          kind="ghost"
          size="sm"
          icon="send"
          onClick={onTestConnection}
          disabled={loading || testing || !state.configured}
        >
          {testing ? "Testing…" : "Test"}
        </VbBtn>
      </div>

      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center" }}>
        <Toggle on={state.enabled} onChange={onToggleEnable} />
      </div>
    </div>

    {state.expanded && (
      <div style={{
        borderTop: "1px solid var(--vb-border)",
        padding: "16px 14px 14px 48px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        background: "var(--vb-bg-1)",
      }}>
        {children}
      </div>
    )}
  </div>
);

const OneSignalFields: React.FC<{
  cfg: NotificationProvidersResponse | null;
  appId: string;
  apiKey: string;
  showKey: boolean;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  onAppId: (v: string) => void;
  onApiKey: (v: string) => void;
  onToggleShowKey: () => void;
  onSave: () => void;
  onReset: () => void;
  testUid: string;
  onTestUid: (v: string) => void;
  onSendTest: () => void;
  testSending: boolean;
  testEnabled: boolean;
}> = (p) => (
  <>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <VbField
        label="App ID"
        hint={<>From OneSignal dashboard → Settings → Keys &amp; IDs</>}
      >
        <VbInput mono value={p.appId} onChange={(e) => p.onAppId(e.target.value)} placeholder="4572b496-4fdc-..." disabled={p.loading} />
      </VbField>
      <VbField
        label="REST API key"
        hint="Server-side key — never ship to clients"
        right={p.cfg?.onesignal.api_key_set
          ? <VbPill tone="success" dot>set</VbPill>
          : <VbPill tone="warning" dot>not set</VbPill>}
      >
        <div style={{ position: "relative" }}>
          <VbInput
            mono
            type={p.showKey ? "text" : "password"}
            value={p.apiKey}
            onChange={(e) => p.onApiKey(e.target.value)}
            placeholder={p.cfg?.onesignal.api_key_set ? "•••••••••• (leave blank to keep)" : "paste REST API key"}
            disabled={p.loading}
            style={{ paddingRight: 32 }}
          />
          <button
            type="button"
            onClick={p.onToggleShowKey}
            disabled={!p.apiKey}
            style={{
              position: "absolute",
              right: 6,
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              border: 0,
              color: "var(--vb-fg-3)",
              cursor: p.apiKey ? "pointer" : "default",
              padding: 4,
            }}
            title={p.showKey ? "Hide" : "Show"}
          >
            <Icon name="eye" size={13} />
          </button>
        </div>
      </VbField>
    </div>
    <InlineTestSend
      providerName="OneSignal"
      uid={p.testUid}
      onUid={p.onTestUid}
      onSend={p.onSendTest}
      sending={p.testSending}
      disabled={!p.testEnabled}
    />
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
      <VbBtn kind="ghost" size="sm" onClick={p.onReset} disabled={p.loading || !p.dirty}>Reset</VbBtn>
      <VbBtn kind="primary" size="sm" onClick={p.onSave} disabled={p.loading || p.saving || !p.dirty}>
        {p.saving ? "Saving…" : "Save changes"}
      </VbBtn>
    </div>
  </>
);

const FCMFields: React.FC<{
  cfg: NotificationProvidersResponse | null;
  projectId: string;
  serviceAccount: string;
  showSa: boolean;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  onProjectId: (v: string) => void;
  onServiceAccount: (v: string) => void;
  onToggleShowSa: () => void;
  onSave: () => void;
  onReset: () => void;
  testUid: string;
  onTestUid: (v: string) => void;
  onSendTest: () => void;
  testSending: boolean;
  testEnabled: boolean;
}> = (p) => (
  <>
    <VbField
      label="Project ID"
      hint={<>Defaults to <VbCode>project_id</VbCode> from the service account if blank</>}
    >
      <VbInput mono value={p.projectId} onChange={(e) => p.onProjectId(e.target.value)} placeholder="my-app-prod" disabled={p.loading} />
    </VbField>
    <VbField
      label="Service account JSON"
      hint={<>Paste contents of <VbCode>service-account.json</VbCode> · Firebase console → Project Settings → Service Accounts → Generate new private key</>}
      right={p.cfg?.fcm.service_account_set
        ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <VbPill tone="success" dot>uploaded</VbPill>
            {p.cfg.fcm.service_account_client_email && (
              <span style={{ fontSize: 10.5, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)" }}>
                {p.cfg.fcm.service_account_client_email}
              </span>
            )}
          </span>
        )
        : <VbPill tone="warning" dot>not set</VbPill>}
    >
      <textarea
        value={p.showSa ? p.serviceAccount : (p.serviceAccount ? "•••• JSON loaded ••••" : "")}
        onChange={(e) => p.onServiceAccount(e.target.value)}
        placeholder={p.cfg?.fcm.service_account_set
          ? '{"type":"service_account",...}  (leave blank to keep existing)'
          : 'paste full {"type":"service_account",...} JSON'}
        disabled={p.loading}
        rows={6}
        style={{
          width: "100%",
          minHeight: 86,
          background: "var(--vb-bg-3)",
          border: "1px solid var(--vb-border-2)",
          borderRadius: 5,
          color: "var(--vb-fg)",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          lineHeight: 1.4,
          padding: "8px 10px",
          outline: "none",
          resize: "vertical",
        }}
      />
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 4,
        fontSize: 11,
        color: "var(--vb-fg-3)",
        gap: 12,
      }}>
        <button
          type="button"
          onClick={p.onToggleShowSa}
          disabled={!p.serviceAccount}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: "transparent",
            border: 0,
            color: "var(--vb-fg-3)",
            cursor: p.serviceAccount ? "pointer" : "default",
            padding: 0,
            fontSize: 11,
          }}
        >
          <Icon name="eye" size={12} /> {p.showSa ? "Mask" : "Show"} pasted JSON
        </button>
        <span>Stored encrypted at rest when <VbCode>VAULTBASE_ENCRYPTION_KEY</VbCode> is set.</span>
      </div>
    </VbField>
    <InlineTestSend
      providerName="FCM"
      uid={p.testUid}
      onUid={p.onTestUid}
      onSend={p.onSendTest}
      sending={p.testSending}
      disabled={!p.testEnabled}
    />
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
      <VbBtn kind="ghost" size="sm" onClick={p.onReset} disabled={p.loading || !p.dirty}>Reset</VbBtn>
      <VbBtn kind="primary" size="sm" onClick={p.onSave} disabled={p.loading || p.saving || !p.dirty}>
        {p.saving ? "Saving…" : "Save changes"}
      </VbBtn>
    </div>
  </>
);

const InlineTestSend: React.FC<{
  providerName: string;
  uid: string;
  onUid: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled: boolean;
}> = ({ providerName, uid, onUid, onSend, sending, disabled }) => (
  <div style={{
    borderTop: "1px dashed var(--vb-border-2)",
    paddingTop: 12,
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    opacity: disabled ? 0.5 : 1,
  }}>
    <Icon name="send" size={13} />
    <span style={{ fontSize: 12, color: "var(--vb-fg-2)", whiteSpace: "nowrap" }}>
      Send <VbCode>"Vaultbase test"</VbCode> via {providerName} to
    </span>
    <VbInput
      mono
      placeholder="user id (vaultbase)"
      value={uid}
      onChange={(e) => onUid(e.target.value)}
      style={{ height: 28, flex: "1 1 200px", minWidth: 160 }}
      disabled={disabled}
    />
    <VbBtn kind="soft" size="sm" disabled={disabled || sending || !uid.trim()} onClick={onSend}>
      {sending ? "Sending…" : "Send"}
    </VbBtn>
  </div>
);

const SystemCollectionsHint: React.FC = () => (
  <div style={{
    marginTop: 16,
    padding: "12px 14px",
    background: "var(--vb-bg-1)",
    border: "1px dashed var(--vb-border-2)",
    borderRadius: 6,
    fontSize: 11.5,
    color: "var(--vb-fg-2)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  }}>
    <Icon name="sparkle" size={13} />
    <span>
      The first time you enable a provider, the <VbCode>notifications</VbCode> and <VbCode>device_tokens</VbCode>{" "}
      system collections are created automatically.
    </span>
  </div>
);


// ── Danger zone ──────────────────────────────────────────────────────────────
function DangerZone() {
  return (
    <SectionShell id="danger">
      <VbField label="Sign out" hint="Clear your session token from this browser.">
        <div>
          <VbBtn
            kind="danger"
            size="sm"
            icon="logout"
            onClick={() => {
              useAuth.getState().signOut();
              window.location.href = "/_/login";
            }}
          >
            Sign out
          </VbBtn>
        </div>
      </VbField>
    </SectionShell>
  );
}
