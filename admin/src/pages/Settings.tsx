import { useEffect, useRef, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Tag } from "primereact/tag";
import { api, getMemoryToken, type ApiResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";
import ProviderLogo from "../components/ProviderLogo.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";
import { useAuth } from "../stores/auth.ts";

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
  | "storage" | "backup" | "migrations"
  | "metrics" | "updates" | "danger";

interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon: string;
  subtitle: string;
}

const SETTINGS_TABS: SettingsTab[] = [
  { id: "application", label: "Application", icon: "settings", subtitle: "runtime configuration" },
  { id: "theme",       label: "Theme",       icon: "palette",  subtitle: "admin UI accent + surface colors" },
  { id: "rate-limit",  label: "Rate limiting", icon: "shield", subtitle: "per-IP token bucket" },
  { id: "egress",      label: "Hook egress",   icon: "globe",  subtitle: "outbound HTTP allow / deny CIDRs" },
  { id: "cors",        label: "CORS",          icon: "globe",  subtitle: "cross-origin allow-list for the HTTP API" },
  { id: "security",    label: "Security",      icon: "shield", subtitle: "sessions · lockout · proxies · fingerprints" },
  { id: "smtp",        label: "SMTP / Email", icon: "scroll", subtitle: "outbound email server" },
  { id: "templates",   label: "Email templates", icon: "scroll", subtitle: "verify + reset emails" },
  { id: "auth",        label: "Auth features", icon: "key", subtitle: "OTP · MFA · anonymous · impersonation" },
  { id: "password-policy", label: "Password policy", icon: "lock", subtitle: "length · character classes · HIBP" },
  { id: "oauth2",      label: "OAuth2", icon: "shield", subtitle: "third-party sign-in providers" },
  { id: "storage",     label: "File storage", icon: "database", subtitle: "local FS · S3 · Cloudflare R2" },
  { id: "backup",      label: "Backup & restore", icon: "download", subtitle: "SQLite snapshot" },
  { id: "migrations",  label: "Migrations", icon: "layers", subtitle: "schema snapshot · environment sync" },
  { id: "metrics",     label: "Health & metrics", icon: "activity", subtitle: "Prometheus exposition" },
  { id: "updates",     label: "Updates",    icon: "refresh", subtitle: "GitHub release checker" },
  { id: "danger",      label: "Danger zone", icon: "alert", subtitle: "irreversible actions" },
];

export default function Settings() {
  const [active, setActive] = useState<SettingsTabId>("application");
  const activeTab = SETTINGS_TABS.find((t) => t.id === active) ?? SETTINGS_TABS[0];

  return (
    <>
      <Topbar title="Settings" subtitle={activeTab.subtitle} />
      <div className="app-body settings-layout">
        <aside className="settings-nav">
          <ul className="settings-nav-list">
            {SETTINGS_TABS.map((t) => (
              <li
                key={t.id}
                className={`settings-nav-item ${active === t.id ? "active" : ""} ${t.id === "danger" ? "danger" : ""}`}
                onClick={() => setActive(t.id)}
              >
                <Icon name={t.icon} size={14} />
                <span>{t.label}</span>
              </li>
            ))}
          </ul>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Application</h3>
        <span className="meta">runtime configuration</span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Port</label>
          <div className="help">Set via <code style={codeStyle}>VAULTBASE_PORT</code></div>
        </div>
        <input className="input mono" defaultValue="8091" disabled />
        <div className="label-block">
          <label className="label">Data directory</label>
          <div className="help">Set via <code style={codeStyle}>VAULTBASE_DATA_DIR</code></div>
        </div>
        <input className="input mono" defaultValue="./vaultbase_data" disabled />
        <div className="label-block">
          <label className="label">JWT secret</label>
          <div className="help">Auto-generated. Stored in <code style={codeStyle}>data_dir/.secret</code></div>
        </div>
        <input className="input mono" value="••••••••••••••••••••••••••••••••" disabled />
      </div>
      <div className="settings-section-foot">
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Runtime config is set via environment variables
        </span>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>Rate limiting</h3>
          <span className="meta">per-IP, per-rule token bucket</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 12, color: enabled ? "var(--success)" : "var(--text-muted)" }}>
            {enabled ? "Enabled" : "Bypass"}
          </span>
        </div>
      </div>

      <div style={{ padding: "16px 18px" }}>
        <div className="rl-table" style={{ opacity: enabled ? 1 : 0.5 }}>
          <div className="rl-row rl-head">
            <div>Rule label</div>
            <div>Max requests<br/><span className="rl-sub">(per IP)</span></div>
            <div>Interval<br/><span className="rl-sub">(in seconds)</span></div>
            <div>Targeted users</div>
            <div></div>
          </div>
          {rules.map((r, i) => (
            <div className="rl-row" key={i}>
              <input
                className="input mono"
                value={r.label}
                onChange={(e) => updateRule(i, { label: e.target.value })}
                placeholder="*:auth"
                disabled={!enabled || loading}
              />
              <input
                className="input mono"
                type="number"
                min={1}
                value={r.max}
                onChange={(e) => updateRule(i, { max: parseInt(e.target.value) || 0 })}
                disabled={!enabled || loading}
              />
              <input
                className="input mono"
                type="number"
                min={1}
                value={Math.round(r.windowMs / 1000)}
                onChange={(e) => updateRule(i, { windowMs: (parseInt(e.target.value) || 0) * 1000 })}
                disabled={!enabled || loading}
              />
              <Dropdown
                value={r.audience}
                options={AUDIENCE_OPTIONS}
                onChange={(e) => updateRule(i, { audience: e.value as RuleAudience })}
                disabled={!enabled || loading}
              />
              <button
                className="btn-icon danger"
                onClick={() => removeRule(i)}
                disabled={!enabled || loading}
                title="Remove rule"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={addRule} disabled={!enabled || loading}>
            <Icon name="plus" size={12} /> Add rate limit rule
          </button>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
            Label = <code style={codeStyle}>{`<path>[:<action>]`}</code> · path: exact, prefix*, or *
          </span>
        </div>
      </div>

      <div className="settings-section-foot" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Actions: <code style={codeStyle}>auth</code> <code style={codeStyle}>create</code> <code style={codeStyle}>list</code> <code style={codeStyle}>view</code> <code style={codeStyle}>update</code> <code style={codeStyle}>delete</code>
        </span>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Hook egress (SSRF guard)</h3>
        <span className="meta">filters <code style={codeStyle}>helpers.http(...)</code> outbound calls</span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Deny CIDRs (comma-separated)</label>
          <div className="help">
            Default deny when blank: <span className="mono" style={{ fontSize: 11 }}>{DEFAULT_DENY_HUMAN}</span>.
            Set <code style={codeStyle}>off</code> to disable filtering entirely (NOT recommended for public deployments).
          </div>
        </div>
        <textarea
          className="input mono"
          rows={3}
          value={deny}
          onChange={(e) => setDeny(e.target.value)}
          placeholder="(blank = use default deny)"
          disabled={!loaded}
          style={{ width: "100%", fontSize: 12, padding: "8px 10px", resize: "vertical" }}
        />
        {off && (
          <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 4, background: "rgba(248,113,113,0.1)", color: "var(--danger)", fontSize: 12 }}>
            <Icon name="alert" size={12} /> Egress filtering is OFF — hooks can reach any IP including private RFC1918 ranges.
          </div>
        )}

        <div className="label-block" style={{ marginTop: 16 }}>
          <label className="label">Allow CIDRs (comma-separated)</label>
          <div className="help">
            Punches a hole in deny — e.g. <code style={codeStyle}>10.5.0.0/16</code> to permit one internal subnet
            without disabling the rest of the deny list. Empty by default.
          </div>
        </div>
        <textarea
          className="input mono"
          rows={2}
          value={allow}
          onChange={(e) => setAllow(e.target.value)}
          placeholder="(blank = no allow exceptions)"
          disabled={!loaded}
          style={{ width: "100%", fontSize: 12, padding: "8px 10px", resize: "vertical" }}
        />

        <div className="help" style={{ marginTop: 12 }}>
          <strong>Known limitation:</strong> filtering happens after DNS resolution; a malicious DNS server can
          still race-rebind a host between resolution and connect. Defense-in-depth alongside an operator-level
          firewall (iptables / VPC NACL) is recommended.
        </div>
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ── Theme ───────────────────────────────────────────────────────────────────
interface ThemeKnob { key: string; label: string; defaultValue: string; cssVar: string }

const THEME_KNOBS: ThemeKnob[] = [
  // Brand
  { key: "accent",         label: "Primary accent",     defaultValue: "#3b82f6", cssVar: "--accent" },
  { key: "accent_hover",   label: "Accent (hover)",     defaultValue: "#4a8ef7", cssVar: "--accent-hover" },
  { key: "accent_light",   label: "Accent (light)",     defaultValue: "#60a5fa", cssVar: "--accent-light" },
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Theme</h3>
        <span className="meta">accent + surface + text colors · admin UI only</span>
      </div>
      <div className="settings-section-body">
        <div className="help" style={{ marginBottom: 16 }}>
          Hex colors: <code style={codeStyle}>#3b82f6</code>, <code style={codeStyle}>#fff</code>,
          <code style={codeStyle}>#3b82f680</code> (alpha). Empty falls back to the built-in default.
          Changes apply on next page load — and immediately to every other tab once you save.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {THEME_KNOBS.map((k) => {
            const v = values[k.key] ?? "";
            const effective = v.trim() || k.defaultValue;
            const isHex = HEX_RE.test(effective);
            return (
              <div key={k.key} className="row" style={{ gap: 10, alignItems: "center" }}>
                <input
                  type="color"
                  value={isHex && effective.length === 7 ? effective : k.defaultValue}
                  onChange={(e) => update(k.key, e.target.value)}
                  disabled={!loaded}
                  style={{ width: 36, height: 30, border: "0.5px solid var(--border-default)", borderRadius: 4, padding: 0, cursor: "pointer", background: "transparent" }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label className="label" style={{ marginBottom: 2 }}>{k.label}</label>
                  <input
                    className="input mono"
                    value={v}
                    onChange={(e) => update(k.key, e.target.value)}
                    placeholder={k.defaultValue}
                    disabled={!loaded}
                    style={{ fontSize: 12, padding: "4px 8px", height: 26 }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 24,
            padding: 16,
            borderRadius: 8,
            border: "0.5px solid var(--border-default)",
            background: "var(--bg-panel)",
            ...liveStyle(),
          }}
        >
          <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            Live preview
          </div>
          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary">Primary action</button>
            <button className="btn btn-ghost">Secondary</button>
            <span className="badge success">success</span>
            <span className="badge warning">warning</span>
            <span className="badge danger">danger</span>
            <a href="#" onClick={(e) => e.preventDefault()} style={{ color: "var(--accent-light)" }}>An accent link</a>
          </div>
        </div>
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "space-between" }}>
        <button className="btn btn-ghost" onClick={reset} disabled={!loaded || saving}>
          Reset to defaults
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>CORS</h3>
        <span className="meta">cross-origin allow-list for the HTTP API</span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Allowed origins (comma-separated)</label>
          <div className="help">
            Empty blocks all cross-origin requests. <code style={codeStyle}>*</code> permits any origin
            (incompatible with credentials — silently downgraded). Otherwise list each origin
            verbatim, e.g. <code style={codeStyle}>https://app.example.com,https://admin.example.com</code>.
          </div>
        </div>
        <textarea
          className="input mono" rows={2} value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          placeholder="(blank = block cross-origin)"
          disabled={!loaded}
          style={{ width: "100%", fontSize: 12, padding: "8px 10px", resize: "vertical" }}
        />

        <div className="row" style={{ gap: 16, marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <label className="label">Allowed methods</label>
            <input className="input mono" value={methods} onChange={(e) => setMethods(e.target.value)} placeholder="GET,POST,PUT,PATCH,DELETE,OPTIONS" disabled={!loaded} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">Allowed headers</label>
            <input className="input mono" value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization,Content-Type,If-Match,X-VB-Idempotency-Key" disabled={!loaded} />
          </div>
        </div>

        <div className="row" style={{ gap: 16, marginTop: 16, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <label className="label">Preflight cache (seconds)</label>
            <input className="input mono" type="number" min={0} value={maxAge} onChange={(e) => setMaxAge(e.target.value)} disabled={!loaded} />
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, marginTop: 22 }}>
            <Toggle on={credentials} onChange={setCredentials} />
            <span style={{ fontSize: 12 }}>Allow credentials (cookies / Authorization)</span>
          </div>
        </div>
        {wildcardWithCreds && (
          <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: 4, background: "rgba(248,113,113,0.1)", color: "var(--danger)", fontSize: 12 }}>
            <Icon name="alert" size={12} /> <code style={codeStyle}>*</code> origin + credentials is not
            permitted by browsers. Vaultbase will echo the matched origin instead.
          </div>
        )}
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="col" style={{ gap: 24 }}>
      <ActiveSessionsCard />
      <BruteForceCard />
      <TrustedProxiesCard />
      <FingerprintsCard />
      <HeadersPreviewCard />
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>Active admin sessions</h3>
          <span className="meta">{sessions.length} active · revoke individually or all at once</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" onClick={load} disabled={loading}>
            <Icon name="refresh" size={12} /> Refresh
          </button>
          <button className="btn" style={{ borderColor: "var(--danger)", color: "var(--danger)" }} onClick={logoutAll}>
            Force logout all
          </button>
        </div>
      </div>
      <div style={{ padding: "0 18px 18px" }}>
        {sessions.length === 0 ? (
          <div className="empty" style={{ padding: 24, textAlign: "center" }}>No active admin sessions.</div>
        ) : (
          <table className="vb-table" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "0.5px solid var(--border-default)" }}>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Admin</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Issued</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Expires</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>IP</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>User-Agent</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>jti</th>
                <th style={{ padding: "8px 10px", width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.jti} style={{ borderBottom: "0.5px solid rgba(255,255,255,0.04)", opacity: s.revoked ? 0.5 : 1 }}>
                  <td style={{ padding: "8px 10px" }} className="mono">{s.admin_email}</td>
                  <td style={{ padding: "8px 10px" }} className="mono muted">{shortRel(s.issued_at)}</td>
                  <td style={{ padding: "8px 10px" }} className="mono muted">{shortRel(s.expires_at)}</td>
                  <td style={{ padding: "8px 10px" }} className="mono muted">{s.ip ?? "—"}</td>
                  <td style={{ padding: "8px 10px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} className="muted" title={s.user_agent ?? ""}>{s.user_agent ?? "—"}</td>
                  <td style={{ padding: "8px 10px" }} className="mono muted">{s.jti.slice(0, 8)}…</td>
                  <td style={{ padding: "8px 10px", textAlign: "right" }}>
                    {s.revoked ? (
                      <span className="muted" style={{ fontSize: 10 }}>revoked</span>
                    ) : (
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => revoke(s.jti)}>Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>Brute-force lockout</h3>
          <span className="meta">per-email + per-IP failed-login throttle</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 12, color: enabled ? "var(--success)" : "var(--text-muted)" }}>
            {enabled ? "Enabled" : "Off"}
          </span>
        </div>
      </div>
      <div className="settings-section-body" style={{ opacity: enabled ? 1 : 0.6 }}>
        <div className="row" style={{ gap: 16 }}>
          <div style={{ flex: 1 }}>
            <label className="label">Max failed attempts</label>
            <input className="input mono" type="number" min={1} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} disabled={!enabled || !loaded} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">Lockout duration (seconds)</label>
            <input className="input mono" type="number" min={60} value={duration} onChange={(e) => setDuration(e.target.value)} disabled={!enabled || !loaded} />
            <div className="help" style={{ fontSize: 11 }}>Default 900 (15 minutes). Min 60.</div>
          </div>
        </div>
        <div className="help" style={{ marginTop: 12 }}>
          Tracks both <code style={codeStyle}>email:&lt;addr&gt;</code> and <code style={codeStyle}>ip:&lt;addr&gt;</code> keys so a
          spray attack across emails from one IP gets caught alongside a single-account attack.
          Per-IP keying requires <code style={codeStyle}>VAULTBASE_TRUSTED_PROXIES</code> (or the proxies setting below) to
          surface real client IPs through your reverse proxy.
        </div>
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Trusted proxies</h3>
        <span className="meta">CIDRs allowed to set <code style={codeStyle}>X-Forwarded-For</code></span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Allowed proxy CIDRs (comma-separated)</label>
          <div className="help">
            Empty + no <code style={codeStyle}>VAULTBASE_TRUSTED_PROXIES</code> env → vaultbase ignores
            <code style={codeStyle}>X-Forwarded-For</code> entirely (defensive default). Set this when your
            reverse proxy / load balancer sits in front of vaultbase.
          </div>
        </div>
        <input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="10.0.0.0/8,127.0.0.1/32" disabled={!loaded} />
        {envFallback && !value.trim() && (
          <div className="help" style={{ marginTop: 8 }}>
            Currently effective via env: <code style={codeStyle}>{envFallback}</code>
          </div>
        )}
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Secrets fingerprints</h3>
        <span className="meta">read-only · SHA-256 first 8 bytes</span>
      </div>
      <div className="settings-section-body">
        {loading ? (
          <div className="muted" style={{ fontSize: 12 }}>loading…</div>
        ) : !fp ? (
          <div className="muted" style={{ fontSize: 12 }}>—</div>
        ) : (
          <>
            <div className="row" style={{ gap: 16 }}>
              <div style={{ flex: 1 }}>
                <label className="label">JWT signing secret</label>
                <div className="mono" style={{ fontSize: 13 }}>{fp.jwt_secret_fingerprint}</div>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">AES encryption key</label>
                <div className="mono" style={{ fontSize: 13, color: fp.encryption_key_present ? undefined : "var(--text-muted)" }}>
                  {fp.encryption_key_present ? fp.encryption_key_fingerprint : "(not set — encrypted fields disabled)"}
                </div>
              </div>
            </div>
            {!fp.encryption_key_present && (
              <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: 4, background: "rgba(251,191,36,0.1)", color: "#fbbf24", fontSize: 12 }}>
                <Icon name="alert" size={12} /> No <code style={codeStyle}>VAULTBASE_ENCRYPTION_KEY</code> set —
                fields marked <code style={codeStyle}>encrypted</code> store plaintext.
              </div>
            )}
            <div className="help" style={{ marginTop: 12 }}>
              Compare these across hosts in a fleet to confirm they share the same secrets.
              A mismatch means JWTs from one host won't verify on the other and encrypted
              fields written on one will be unreadable on the other.
            </div>
          </>
        )}
      </div>
    </div>
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
    if (!headers) return <div className="muted" style={{ fontSize: 12 }}>—</div>;
    const entries = Object.entries(headers);
    if (entries.length === 0) return <div className="muted" style={{ fontSize: 12 }}>(no headers)</div>;
    return (
      <table style={{ width: "100%", fontSize: 11 }} className="mono">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} style={{ borderBottom: "0.5px solid rgba(255,255,255,0.04)" }}>
              <td style={{ padding: "5px 8px", color: "var(--accent-light)", whiteSpace: "nowrap", verticalAlign: "top" }}>{k}</td>
              <td style={{ padding: "5px 8px", wordBreak: "break-all" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Security headers</h3>
        <span className="meta">read-only · what vaultbase emits per response</span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">API responses</label>
        </div>
        {renderTable(preview?.api)}
        <div className="label-block" style={{ marginTop: 16 }}>
          <label className="label">Admin UI / non-API responses</label>
          <div className="help">CSP applies here only — the API surface returns JSON and doesn't need it.</div>
        </div>
        {renderTable(preview?.ui)}
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Password policy</h3>
        <span className="meta">applies to admin + auth-collection users</span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Minimum length</label>
          <div className="help">NIST 800-63B recommends at least 8 characters; OWASP recommends 12. Floor is 8.</div>
        </div>
        <input className="input mono" type="number" min={8} value={minLen} onChange={(e) => setMinLen(e.target.value)} disabled={!loaded} style={{ maxWidth: 120 }} />

        <div className="label-block" style={{ marginTop: 16 }}>
          <label className="label">Required character classes</label>
          <div className="help">
            Off by default — modern guidance favors length over character-class complexity.
            Enable only if a compliance regime requires it.
          </div>
        </div>
        {[
          { key: "upper",  label: "Uppercase letter (A-Z)", on: reqUpper,  set: setReqUpper  },
          { key: "lower",  label: "Lowercase letter (a-z)", on: reqLower,  set: setReqLower  },
          { key: "digit",  label: "Digit (0-9)",            on: reqDigit,  set: setReqDigit  },
          { key: "symbol", label: "Symbol (anything non-alphanumeric)", on: reqSymbol, set: setReqSymbol },
        ].map((row) => (
          <div key={row.key} className="row" style={{ gap: 10, alignItems: "center", marginTop: 8 }}>
            <Toggle on={row.on} onChange={row.set} />
            <span style={{ fontSize: 12 }}>{row.label}</span>
          </div>
        ))}

        <div className="label-block" style={{ marginTop: 24 }}>
          <label className="label">Have-I-Been-Pwned check</label>
          <div className="help">
            Reject passwords found in known breach corpora. Uses the
            <code style={codeStyle}>api.pwnedpasswords.com</code> k-anonymity API —
            only the first 5 SHA-1 characters leave the server. Fails open on network error
            so a downed API doesn't lock signups.
          </div>
        </div>
        <div className="row" style={{ gap: 10, alignItems: "center", marginTop: 8 }}>
          <Toggle on={hibp} onChange={setHibp} />
          <span style={{ fontSize: 12 }}>Block breached passwords</span>
        </div>
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>Health &amp; metrics</h3>
          <span className="meta">Prometheus exposition at <code style={codeStyle}>/api/metrics</code></span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 12, color: enabled ? "var(--success)" : "var(--text-muted)" }}>
            {enabled ? "Enabled" : "Off"}
          </span>
        </div>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Bearer token (optional)</label>
          <div className="help">
            When set, scrapers must send <code style={codeStyle}>Authorization: Bearer &lt;token&gt;</code>.
            Leave blank to expose <code style={codeStyle}>/api/metrics</code> publicly — only do this
            if the endpoint is protected at the proxy layer.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="(blank = no auth)" disabled={!loaded} style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={regenerateToken}>Generate</button>
        </div>

        <div className="help" style={{ marginTop: 16 }}>
          Endpoint format: <code style={codeStyle}>text/plain; version=0.0.4</code> — the standard
          Prometheus exposition. Exports request RPS, total counter, uptime, per-step latency
          summary (p50/p90/p99/p99.9), and SQLite page/WAL gauges. Always available to admins as
          JSON at <code style={codeStyle}>/_/metrics</code>.
        </div>
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>Updates</h3>
          <span className="meta">polls GitHub for the latest release tag</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 12, color: enabled ? "var(--success)" : "var(--text-muted)" }}>
            {enabled ? "Auto-check on" : "Off"}
          </span>
        </div>
      </div>
      <div className="settings-section-body">
        {status && (
          <div
            style={{
              padding: "20px 22px",
              borderRadius: 10,
              background: status.update_available
                ? "linear-gradient(180deg, rgba(96,165,250,0.10), rgba(96,165,250,0.02))"
                : "rgba(255,255,255,0.02)",
              border: `1px solid ${status.update_available ? "rgba(96,165,250,0.3)" : "var(--border-default)"}`,
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>
                    Installed
                  </div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>
                    v{status.current_version}
                  </div>
                </div>
                <Icon
                  name="arrowRight"
                  size={16}
                  style={{ color: status.update_available ? "var(--accent-light)" : "var(--text-muted)", flexShrink: 0 }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>
                    Latest
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 20,
                      fontWeight: 600,
                      lineHeight: 1.3,
                      color: status.update_available ? "var(--accent-light)" : undefined,
                    }}
                  >
                    {status.latest_version ?? <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>—</span>}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    padding: "3px 8px",
                    borderRadius: 10,
                    background: status.update_available
                      ? "rgba(96,165,250,0.15)"
                      : status.latest_version
                        ? "rgba(74,222,128,0.12)"
                        : "rgba(255,255,255,0.06)",
                    color: status.update_available
                      ? "var(--accent-light)"
                      : status.latest_version
                        ? "var(--success)"
                        : "var(--text-muted)",
                  }}
                >
                  {status.update_available ? "UPDATE AVAILABLE" : status.latest_version ? "UP TO DATE" : "NEVER CHECKED"}
                </span>
                <span className="muted" style={{ fontSize: 11 }}>
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
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "14px 16px",
              borderRadius: 8,
              background: "rgba(96,165,250,0.08)",
              border: "1px solid rgba(96,165,250,0.25)",
              color: "var(--accent-light)",
              fontSize: 13,
              textDecoration: "none",
              marginBottom: 20,
            }}
          >
            <Icon name="download" size={14} />
            <span style={{ flex: 1 }}>
              View release notes for <code style={codeStyle}>{status.latest_version}</code> on GitHub
            </span>
            <Icon name="arrowRight" size={12} />
          </a>
        )}

        {status?.last_error && (
          <div style={{ padding: "12px 14px", borderRadius: 6, background: "rgba(248,113,113,0.1)", color: "var(--danger)", fontSize: 12, marginBottom: 20, display: "flex", gap: 8, alignItems: "center" }}>
            <Icon name="alert" size={14} />
            <span>Last check failed: {status.last_error}</span>
          </div>
        )}

        <div className="help" style={{ lineHeight: 1.6 }}>
          Polls <code style={codeStyle}>api.github.com/repos/vaultbase-sh/vaultbase/releases/latest</code>{" "}
          on boot (after a 30 s delay) and every 6 hours. Disable to silence the poller — no banner,
          no network call. Vaultbase never auto-updates; this is purely a notification.
        </div>
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "space-between" }}>
        <button className="btn btn-ghost" onClick={checkNow} disabled={!loaded || checking || !enabled}>
          <Icon name="refresh" size={12} /> {checking ? "Checking…" : "Check now"}
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Backup & restore</h3>
        <span className="meta">SQLite snapshot</span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Download backup</label>
          <div className="help">Downloads the live <code style={codeStyle}>data.db</code> file. Uploaded files are not included.</div>
        </div>
        <div>
          <button className="btn btn-ghost" onClick={handleDownload}>
            <Icon name="download" size={12} /> Download .db
          </button>
        </div>
        <div className="label-block span2"><div className="divider" style={{ margin: 0 }} /></div>
        <div className="label-block">
          <label className="label" style={{ color: "var(--warning)" }}>Restore from backup</label>
          <div className="help">
            Replaces all current data with the uploaded SQLite file. Existing JWTs remain valid (signing key unchanged).
          </div>
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".db,application/octet-stream"
            style={{ display: "none" }}
            onChange={handleRestore}
          />
          <button
            className="btn btn-ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={restoring}
          >
            <Icon name="upload" size={12} /> {restoring ? "Restoring…" : "Upload .db"}
          </button>
        </div>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>SMTP / Email</h3>
          <span className="meta">outbound email via SMTP server</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 12, color: enabled ? "var(--success)" : "var(--text-muted)" }}>
            {enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
      </div>

      <div className="settings-section-body" style={{ opacity: enabled ? 1 : 0.5 }}>
        <div className="label-block">
          <label className="label">Host</label>
          <div className="help">SMTP server hostname (e.g. <code style={codeStyle}>smtp.resend.com</code>)</div>
        </div>
        <input
          className="input mono"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="smtp.example.com"
          disabled={!enabled || loading}
        />

        <div className="label-block">
          <label className="label">Port</label>
          <div className="help">Common: 587 (STARTTLS), 465 (TLS), 25 (plain)</div>
        </div>
        <input
          className="input mono"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          disabled={!enabled || loading}
        />

        <div className="label-block">
          <label className="label">Secure (TLS)</label>
          <div className="help">Enable for port 465. Leave off for STARTTLS on 587.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Toggle on={secure} onChange={setSecure} />
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {secure ? "TLS" : "STARTTLS"}
          </span>
        </div>

        <div className="label-block">
          <label className="label">Username</label>
          <div className="help">SMTP auth username (often your email or API key id)</div>
        </div>
        <input
          className="input mono"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="apikey or user@example.com"
          autoComplete="off"
          disabled={!enabled || loading}
        />

        <div className="label-block">
          <label className="label">Password</label>
          <div className="help">SMTP auth password / API key. Stored in plaintext in the settings table.</div>
        </div>
        <input
          className="input mono"
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="••••••••"
          autoComplete="new-password"
          disabled={!enabled || loading}
        />

        <div className="label-block">
          <label className="label">From address</label>
          <div className="help">Sender used in <code style={codeStyle}>From:</code> header</div>
        </div>
        <input
          className="input mono"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder='"Vaultbase" <noreply@example.com>'
          disabled={!enabled || loading}
        />
      </div>

      <div className="settings-section-foot" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            className="input mono"
            style={{ width: 240 }}
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="test recipient email"
            disabled={!enabled || loading}
          />
          <button className="btn btn-ghost" onClick={handleTest} disabled={!enabled || loading || testing}>
            <Icon name="play" size={11} /> {testing ? "Sending…" : "Send test"}
          </button>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Email templates</h3>
        <span className="meta">verify + password reset</span>
      </div>

      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">App URL</label>
          <div className="help">Base URL of your frontend. Used to build the <code style={codeStyle}>{`{{link}}`}</code> in emails.</div>
        </div>
        <input
          className="input mono"
          value={appUrl}
          onChange={(e) => setAppUrl(e.target.value)}
          placeholder="https://example.com"
          disabled={loading}
        />

        <div className="label-block span2">
          <div className="divider" style={{ margin: 0 }} />
        </div>

        <div className="label-block span2">
          <label className="label">Verification email</label>
          <div className="help">
            Sent on registration and via <code style={codeStyle}>POST /api/auth/:collection/request-verify</code>.
            Variables: <code style={codeStyle}>{`{{email}}`}</code> <code style={codeStyle}>{`{{token}}`}</code> <code style={codeStyle}>{`{{link}}`}</code> <code style={codeStyle}>{`{{appUrl}}`}</code> <code style={codeStyle}>{`{{collection}}`}</code>
          </div>
        </div>
        <div className="label-block">
          <label className="label">Subject</label>
        </div>
        <input
          className="input mono"
          value={verifySubject}
          onChange={(e) => setVerifySubject(e.target.value)}
          disabled={loading}
        />
        <div className="label-block">
          <label className="label">Body (plain text)</label>
        </div>
        <textarea
          className="input mono"
          rows={8}
          value={verifyBody}
          onChange={(e) => setVerifyBody(e.target.value)}
          disabled={loading}
          style={{ fontFamily: "var(--font-mono)", resize: "vertical" }}
        />

        <div className="label-block span2">
          <div className="divider" style={{ margin: 0 }} />
        </div>

        <div className="label-block span2">
          <label className="label">Password reset email</label>
          <div className="help">
            Sent via <code style={codeStyle}>POST /api/auth/:collection/request-password-reset</code>. Same variables as above.
          </div>
        </div>
        <div className="label-block">
          <label className="label">Subject</label>
        </div>
        <input
          className="input mono"
          value={resetSubject}
          onChange={(e) => setResetSubject(e.target.value)}
          disabled={loading}
        />
        <div className="label-block">
          <label className="label">Body (plain text)</label>
        </div>
        <textarea
          className="input mono"
          rows={8}
          value={resetBody}
          onChange={(e) => setResetBody(e.target.value)}
          disabled={loading}
          style={{ fontFamily: "var(--font-mono)", resize: "vertical" }}
        />
      </div>

      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    description: <>Passwordless sign-in via email — both a 6-digit code and a magic link. Requires SMTP. Endpoints: <code style={codeStyle}>POST /api/auth/&lt;col&gt;/otp/&#123;request,auth&#125;</code>.</>,
  },
  {
    key: "mfa",
    label: "MFA / TOTP (2FA)",
    defaultOn: true,
    description: <>RFC 6238 TOTP with authenticator apps. Disabling blocks new enrollment but lets existing users still sign in and disable their own MFA. Endpoints: <code style={codeStyle}>POST /api/auth/&lt;col&gt;/totp/&#123;setup,confirm,disable&#125;</code>.</>,
  },
  {
    key: "anonymous",
    label: "Anonymous sign-in",
    defaultOn: false,
    description: <>Mints a guest user with no email/password — useful for guest carts or onboarding before signup. Sessions live 30 days. Endpoint: <code style={codeStyle}>POST /api/auth/&lt;col&gt;/anonymous</code>.</>,
  },
  {
    key: "impersonation",
    label: "Admin impersonation",
    defaultOn: true,
    description: <>Admin mints a 1-hour user JWT for support purposes. JWT carries <code style={codeStyle}>impersonated_by</code> for audit. Endpoint: <code style={codeStyle}>POST /api/admin/impersonate/&lt;col&gt;/&lt;userId&gt;</code>.</>,
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Auth features</h3>
        <span className="meta">enable / disable per-feature</span>
      </div>

      <div className="settings-section-body" style={{ gridTemplateColumns: "1fr", padding: "10px 14px" }}>
        <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          Disabled features return <code style={codeStyle}>422</code> from their endpoints. Disabling MFA blocks new enrollment only — already-enrolled users keep working.
        </div>

        {AUTH_FEATURES.map((f) => {
          const on = isOn(f.key, f.defaultOn);
          return (
            <div
              key={f.key}
              style={{
                border: "0.5px solid var(--border-default)",
                borderRadius: 7,
                padding: "12px 14px",
                marginBottom: 8,
                background: on ? "rgba(255,255,255,0.02)" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{f.label}</div>
                  <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>{f.description}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <Toggle on={on} onChange={(v) => setKey(f.key, v)} />
                  <span style={{ fontSize: 12, color: on ? "var(--success)" : "var(--text-muted)", minWidth: 60 }}>
                    {on ? "Enabled" : "Disabled"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
  { kind: "anonymous",   label: "Anonymous", description: "Guest sessions minted by POST /api/auth/:collection/anonymous.",            defaultSeconds: 30 * 24 * 3600 },
  { kind: "user",        label: "User",      description: "Standard user JWTs (login, register, OAuth2, magic link).",                  defaultSeconds:  7 * 24 * 3600 },
  { kind: "admin",       label: "Admin",     description: "Admin JWTs minted by POST /api/admin/auth/login.",                            defaultSeconds:  7 * 24 * 3600 },
  { kind: "impersonate", label: "Impersonate", description: "JWTs issued by admin impersonation. Keep short — these escalate access.",  defaultSeconds:       3600 },
  { kind: "refresh",     label: "Refresh",   description: "Window applied when /refresh re-mints a token. Acts as the sliding ratchet.", defaultSeconds:  7 * 24 * 3600 },
  { kind: "file",        label: "File access", description: "Protected-file URLs minted via POST /api/files/.../token.",                defaultSeconds:       3600 },
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

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Session lifetimes</h3>
        <span className="meta">JWT exp window per token kind, in seconds</span>
      </div>

      <div className="settings-section-body" style={{ gridTemplateColumns: "1fr", padding: "10px 14px" }}>
        <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          Changing a window affects <strong>newly issued</strong> tokens only — existing tokens keep their original expiry. To revoke active sessions immediately, rotate the JWT secret in <code style={codeStyle}>data_dir/.secret</code> and restart.
        </div>

        {SESSION_KINDS.map((k) => {
          const current = parseInt(values[k.kind] ?? String(k.defaultSeconds), 10);
          const isDefault = current === k.defaultSeconds;
          return (
            <div
              key={k.kind}
              style={{
                border: "0.5px solid var(--border-default)",
                borderRadius: 7,
                padding: "12px 14px",
                marginBottom: 8,
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
                    {k.label}{" "}
                    <span className="muted mono" style={{ fontSize: 10, fontWeight: 400 }}>
                      ({fmtDuration(current)}{isDefault ? " · default" : ""})
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>{k.description}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <input
                  className="input mono"
                  type="number"
                  min={60}
                  max={365 * 86400}
                  value={values[k.kind] ?? ""}
                  onChange={(e) => setVal(k.kind, e.target.value)}
                  disabled={loading}
                  style={{ width: 140 }}
                />
                <span className="muted" style={{ fontSize: 11 }}>seconds</span>
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className="btn btn-ghost"
                    style={{ fontSize: 11, padding: "2px 8px", height: 24 }}
                    onClick={() => setVal(k.kind, String(p.seconds))}
                    disabled={loading}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>OAuth2 providers</h3>
        <span className="meta">{enabledCount} of {OAUTH_PROVIDERS.length} enabled</span>
      </div>

      <div className="settings-section-body" style={{ gridTemplateColumns: "1fr", padding: "10px 14px" }}>
        <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          Enable a provider to expose it via{" "}
          <code style={codeStyle}>GET /api/auth/&lt;collection&gt;/oauth2/providers</code>
          {" · "}your app drives the popup + state, then POSTs the code to{" "}
          <code style={codeStyle}>/api/auth/&lt;collection&gt;/oauth2/exchange</code>.
        </div>

        {OAUTH_PROVIDERS.map((p) => {
          const on = isOn(p.name);
          const isExpanded = expanded.has(p.name);
          return (
            <div
              key={p.name}
              style={{
                border: "0.5px solid var(--border-default)",
                borderRadius: 7,
                marginBottom: 8,
                background: on ? "rgba(255,255,255,0.02)" : "transparent",
                overflow: "hidden",
              }}
            >
              {/* Collapsed header — click to expand */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 12px",
                  cursor: "pointer",
                  userSelect: "none",
                }}
                onClick={() => toggleExpanded(p.name)}
              >
                <ProviderLogo provider={p.name} size={20} />
                <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{p.displayName}</div>
                {on && (
                  <span
                    style={{
                      fontSize: 10.5,
                      color: "var(--success)",
                      background: "rgba(74,222,128,0.1)",
                      padding: "2px 8px",
                      borderRadius: 10,
                    }}
                  >
                    enabled
                  </span>
                )}
                <div onClick={(e) => e.stopPropagation()}>
                  <Toggle
                    on={on}
                    onChange={(v) => set(`oauth2.${p.name}.enabled`, v ? "1" : "0")}
                  />
                </div>
                <Icon name={isExpanded ? "chevronDown" : "chevronRight"} size={12} />
              </div>

              {/* Expanded body */}
              {isExpanded && (
                <div
                  style={{
                    padding: "0 12px 14px 44px",
                    borderTop: "0.5px solid rgba(255,255,255,0.04)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, paddingTop: 12 }}>
                    {!p.hideStandardClientId && (
                      <div>
                        <label className="label">{p.name === "apple" ? "Services ID" : "Client ID"}</label>
                        <input
                          className="input mono"
                          value={get(`oauth2.${p.name}.client_id`)}
                          onChange={(e) => set(`oauth2.${p.name}.client_id`, e.target.value)}
                          placeholder="client identifier"
                          autoComplete="off"
                          disabled={loading}
                        />
                      </div>
                    )}
                    {!p.hideStandardClientSecret && (
                      <div>
                        <label className="label">Client secret</label>
                        <input
                          className="input mono"
                          type="password"
                          value={get(`oauth2.${p.name}.client_secret`)}
                          onChange={(e) => set(`oauth2.${p.name}.client_secret`, e.target.value)}
                          placeholder="••••••••"
                          autoComplete="new-password"
                          disabled={loading}
                        />
                      </div>
                    )}
                  </div>

                  {p.extraFields && p.extraFields.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {p.extraFields.map((f) => (
                        <div key={f.key}>
                          <label className="label">{f.label}</label>
                          {f.type === "textarea" ? (
                            <textarea
                              className="input mono"
                              value={get(f.key)}
                              onChange={(e) => set(f.key, e.target.value)}
                              placeholder={f.placeholder}
                              autoComplete="off"
                              rows={6}
                              disabled={loading}
                              style={{ fontFamily: "var(--font-mono)", fontSize: 11, resize: "vertical" }}
                            />
                          ) : (
                            <input
                              className="input mono"
                              type={f.type === "password" ? "password" : "text"}
                              value={get(f.key)}
                              onChange={(e) => set(f.key, e.target.value)}
                              placeholder={f.placeholder}
                              autoComplete="off"
                              disabled={loading}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <div className="muted" style={{ fontSize: 11, flex: 1 }}>
                      {p.redirectHint}
                    </div>
                    <a
                      href={p.helpUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 11, color: "var(--accent-light)", textDecoration: "none" }}
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

      <div className="settings-section-foot" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Migrations</h3>
        <span className="meta">schema snapshot for env sync</span>
      </div>

      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Download snapshot</label>
          <div className="help">
            Exports every collection's full definition (name · type · fields · rules · view query) as a JSON file.
            Commit it to git, then upload it on a fresh install to recreate the schema.
          </div>
        </div>
        <div>
          <button className="btn btn-ghost" onClick={handleDownload}>
            <Icon name="download" size={12} /> Download .json
          </button>
        </div>

        <div className="label-block span2"><div className="divider" style={{ margin: 0 }} /></div>

        <div className="label-block">
          <label className="label">Apply snapshot</label>
          <div className="help">
            <strong>Additive</strong> creates collections that don't exist yet — safe default.{" "}
            <strong>Sync</strong> also updates existing collections to match the snapshot (fields, rules, view query).
            Neither mode ever deletes a collection.
          </div>
        </div>
        <div className="col" style={{ gap: 10 }}>
          <Dropdown
            value={mode}
            options={[
              { label: "Additive — create missing only", value: "additive" },
              { label: "Sync — also update existing (destructive)", value: "sync" },
            ]}
            onChange={(e) => setMode(e.value as "additive" | "sync")}
            style={{ height: 34 }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={handleSelectFile}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn btn-ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={applying || diffLoading}
            >
              <Icon name="upload" size={12} /> {pendingFileName ? "Choose different file" : "Choose snapshot file"}
            </button>
            {pendingFileName && (
              <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {pendingFileName}
              </span>
            )}
            {pendingFileName && (
              <button
                className="btn-icon"
                onClick={clearPending}
                disabled={applying}
                title="Clear selection"
                style={{ marginLeft: "auto" }}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        </div>

        {/* ── Diff preview panel ─────────────────────────────────────────── */}
        {(diffLoading || diff !== null) && (
          <div className="label-block span2" style={{ marginTop: 6 }}>
            <div
              style={{
                border: "0.5px solid var(--border-default)",
                borderRadius: 7,
                padding: "12px 14px",
                background: "rgba(255,255,255,0.02)",
              }}
            >
              {diffLoading && (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Computing diff…</div>
              )}

              {diff && (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                    <strong style={{ fontSize: 12 }}>Preview</strong>
                    <Tag value={`${diff.added.length} added`} severity="success" rounded />
                    <Tag value={`${diff.modified.length} modified`} severity="warning" rounded />
                    <Tag value={`${diff.unchanged.length} unchanged`} severity="secondary" rounded />
                    <Tag value={`${diff.removed.length} removed`} severity="danger" rounded />
                  </div>

                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
                    Will create <strong>{willCreate}</strong>
                    {" · "}update <strong>{willUpdate}</strong>
                    {" · "}leave <strong>{willLeave}</strong> unchanged
                    {mode === "additive" && diff.modified.length > 0 && (
                      <span className="muted" style={{ marginLeft: 6 }}>
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
                        <details key={m.name} className="mig-diff-details">
                          <summary>
                            <span className="mono" style={{ fontSize: 11 }}>{m.name}</span>
                            <span className="muted" style={{ fontSize: 10.5, marginLeft: 6 }}>{m.type}</span>
                            <span className="muted" style={{ fontSize: 10.5, marginLeft: 6 }}>
                              · {m.changes.length} change{m.changes.length === 1 ? "" : "s"}
                            </span>
                          </summary>
                          <ul style={{ margin: "4px 0 6px 0", paddingLeft: 20, fontSize: 11, color: "var(--text-secondary)" }}>
                            {m.changes.map((c, i) => (
                              <li key={i} className="mono">{c}</li>
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
          </div>
        )}

        {/* ── Apply button row ───────────────────────────────────────────── */}
        {pendingSnapshot && (
          <div className="label-block span2" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              className="btn btn-primary"
              onClick={handleApply}
              disabled={applying || diffLoading || !diff}
            >
              <Icon name="upload" size={12} /> {applying
                ? "Applying…"
                : mode === "sync" ? "Apply (sync mode)" : "Apply"}
            </button>
          </div>
        )}
      </div>

      {result && (
        <div className="settings-section-foot" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          {(["created", "updated", "skipped"] as const).map((k) =>
            result[k].length > 0 ? (
              <div key={k} style={{ fontSize: 12 }}>
                <span style={{ color: "var(--text-muted)", textTransform: "capitalize", marginRight: 6 }}>{k}:</span>
                <span className="mono" style={{ fontSize: 11 }}>{result[k].join(", ")}</span>
              </div>
            ) : null
          )}
          {result.errors.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--danger)" }}>
              <div style={{ marginBottom: 4 }}>Errors:</div>
              {result.errors.map((e, i) => (
                <div key={i} className="mono" style={{ fontSize: 11, paddingLeft: 8 }}>
                  • {e.collection}: {e.error}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
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
    <div className="settings-section">
      <div className="settings-section-head" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>File storage</h3>
          <span className="meta">where uploaded files live</span>
        </div>
        {status && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            active: <span style={{ color: "var(--accent-light)" }}>{status.driver}</span>
            {status.bucket && <> · {status.bucket}</>}
          </span>
        )}
      </div>

      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Driver</label>
          <div className="help">Switching drivers does not migrate existing files. Plan accordingly.</div>
        </div>
        <Dropdown
          value={driver}
          options={[
            { label: "Local filesystem (default)", value: "local" },
            { label: "S3-compatible (AWS S3, Cloudflare R2, MinIO, …)", value: "s3" },
          ]}
          onChange={(e) => setDriver(e.value)}
          disabled={loading}
        />

        {driver === "s3" && (
          <>
            <div className="label-block">
              <label className="label">Preset</label>
              <div className="help">One-click defaults for common providers.</div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-ghost" onClick={applyR2Preset}>
                Cloudflare R2
              </button>
              <button className="btn btn-ghost" onClick={applyS3Preset}>
                AWS S3
              </button>
            </div>

            <div className="label-block">
              <label className="label">Endpoint</label>
              <div className="help">
                R2: <code style={codeStyle}>{`https://<account-id>.r2.cloudflarestorage.com`}</code>.
                AWS S3: leave blank.
              </div>
            </div>
            <input
              className="input mono"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://acc.r2.cloudflarestorage.com"
            />

            <div className="label-block">
              <label className="label">Bucket</label>
              <div className="help">Must exist already. Vaultbase does not create buckets.</div>
            </div>
            <input
              className="input mono"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              placeholder="vaultbase-uploads"
            />

            <div className="label-block">
              <label className="label">Region</label>
              <div className="help">R2: <code style={codeStyle}>auto</code>. AWS: e.g. <code style={codeStyle}>us-east-1</code>.</div>
            </div>
            <input
              className="input mono"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="auto"
            />

            <div className="label-block">
              <label className="label">Access key ID</label>
              <div className="help">For R2: an API token with Object Read &amp; Write.</div>
            </div>
            <input
              className="input mono"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              autoComplete="off"
            />

            <div className="label-block">
              <label className="label">Secret access key</label>
              <div className="help">Stored in plaintext in the settings table. Treat the DB accordingly.</div>
            </div>
            <input
              className="input mono"
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />

            <div className="label-block">
              <label className="label">Public URL <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
              <div className="help">
                If your bucket is fronted by a CDN/public domain, files can link directly to it. Leave blank to proxy bytes through Vaultbase.
              </div>
            </div>
            <input
              className="input mono"
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
              placeholder="https://cdn.example.com"
            />
          </>
        )}
      </div>

      <div className="settings-section-foot" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <button className="btn btn-ghost" onClick={handleTest} disabled={testing}>
          <Icon name="play" size={11} /> {testing ? "Testing…" : "Test connection"}
        </button>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ── Danger zone ──────────────────────────────────────────────────────────────
function DangerZone() {
  return (
    <div className="settings-section danger">
      <div className="settings-section-head">
        <h3 style={{ color: "var(--danger)" }}>Danger zone</h3>
        <span className="meta">irreversible actions</span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Sign out</label>
          <div className="help">Clear your session token from this browser.</div>
        </div>
        <div>
          <button
            className="btn btn-ghost"
            onClick={() => {
              useAuth.getState().signOut();
              window.location.href = "/_/login";
            }}
          >
            <Icon name="logout" size={12} /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
