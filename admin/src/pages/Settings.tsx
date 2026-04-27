import { useEffect, useRef, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, type ApiResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";
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
  { label: "/api/*",   max: 300, windowMs: 10000, audience: "all" },
];

type SettingsTabId = "application" | "rate-limit" | "smtp" | "backup" | "danger";

interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon: string;
  subtitle: string;
}

const SETTINGS_TABS: SettingsTab[] = [
  { id: "application", label: "Application", icon: "settings", subtitle: "runtime configuration" },
  { id: "rate-limit",  label: "Rate limiting", icon: "shield", subtitle: "per-IP token bucket" },
  { id: "smtp",        label: "SMTP / Email", icon: "scroll", subtitle: "outbound email server" },
  { id: "backup",      label: "Backup & restore", icon: "download", subtitle: "SQLite snapshot" },
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
          {active === "rate-limit" && <RateLimitSection />}
          {active === "smtp" && <SmtpSection />}
          {active === "backup" && <BackupSection />}
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
    api.get<ApiResponse<Record<string, string>>>("/api/admin/settings").then((res) => {
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
    setRules((prev) => [...prev, { label: "/api/", max: 60, windowMs: 5000, audience: "all" }]);
  }

  async function handleSave() {
    for (const r of rules) {
      if (!r.label.trim()) { toast("Rule label cannot be empty", "info"); return; }
      if (!Number.isFinite(r.max) || r.max < 1) { toast(`Invalid max for "${r.label}"`, "info"); return; }
      if (!Number.isFinite(r.windowMs) || r.windowMs < 1) { toast(`Invalid window for "${r.label}"`, "info"); return; }
    }
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/admin/settings", {
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

// ── Backup / restore ─────────────────────────────────────────────────────────
function BackupSection() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);

  function handleDownload() {
    const token = localStorage.getItem("vaultbase_admin_token") ?? "";
    fetch("/api/admin/backup", { headers: { Authorization: `Bearer ${token}` } })
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
    const token = localStorage.getItem("vaultbase_admin_token") ?? "";
    try {
      const res = await fetch("/api/admin/restore", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
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
    api.get<ApiResponse<Record<string, string>>>("/api/admin/settings").then((res) => {
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
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/admin/settings", {
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
    const res = await api.post<ApiResponse<{ messageId: string }>>("/api/admin/settings/smtp/test", {
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
