import { useEffect, useRef, useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

export default function Settings({
  toast,
}: {
  adminEmail: string;
  toast: (text: string, icon?: string) => void;
}) {
  return (
    <>
      <Topbar title="Settings" subtitle="Application configuration" />
      <div className="app-body" style={{ maxWidth: 880 }}>
        <ApplicationSection />
        <RateLimitSection toast={toast} />
        <BackupSection toast={toast} />
        <DangerZone />
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
function RateLimitSection({ toast }: { toast: (text: string, icon?: string) => void }) {
  const [enabled, setEnabled] = useState(true);
  const [maxReq, setMaxReq] = useState("120");
  const [windowSec, setWindowSec] = useState("60");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<ApiResponse<Record<string, string>>>("/api/admin/settings").then((res) => {
      if (res.data) {
        if (res.data["rate_limit.enabled"] !== undefined) {
          setEnabled(res.data["rate_limit.enabled"] === "1" || res.data["rate_limit.enabled"] === "true");
        }
        if (res.data["rate_limit.max"]) setMaxReq(res.data["rate_limit.max"]);
        if (res.data["rate_limit.window_ms"]) {
          const ms = parseInt(res.data["rate_limit.window_ms"]);
          if (!isNaN(ms)) setWindowSec(String(Math.round(ms / 1000)));
        }
      }
      setLoading(false);
    });
  }, []);

  async function handleSave() {
    const max = parseInt(maxReq);
    const winSec = parseInt(windowSec);
    if (isNaN(max) || max < 1) { toast("Max requests must be a positive integer", "info"); return; }
    if (isNaN(winSec) || winSec < 1) { toast("Window must be a positive integer (seconds)", "info"); return; }
    setSaving(true);
    const res = await api.patch<ApiResponse<Record<string, string>>>("/api/admin/settings", {
      "rate_limit.enabled": enabled ? "1" : "0",
      "rate_limit.max": String(max),
      "rate_limit.window_ms": String(winSec * 1000),
    });
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Rate limit settings saved");
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Rate limiting</h3>
        <span className="meta">per-IP token bucket</span>
      </div>
      <div className="settings-section-body">
        <div className="label-block">
          <label className="label">Enabled</label>
          <div className="help">When off, all requests bypass the limiter.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Toggle on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {enabled ? "Limiting active" : "Bypass — no rate limit"}
          </span>
        </div>

        <div className="label-block">
          <label className="label">Max requests per window</label>
          <div className="help">How many requests a single IP can make per window.</div>
        </div>
        <input
          className="input mono"
          type="number"
          min={1}
          value={maxReq}
          onChange={(e) => setMaxReq(e.target.value)}
          disabled={!enabled || loading}
        />

        <div className="label-block">
          <label className="label">Window (seconds)</label>
          <div className="help">Bucket refills proportionally across this window.</div>
        </div>
        <input
          className="input mono"
          type="number"
          min={1}
          value={windowSec}
          onChange={(e) => setWindowSec(e.target.value)}
          disabled={!enabled || loading}
        />
      </div>
      <div className="settings-section-foot" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Skipped: <code style={{ fontFamily: "var(--font-mono)" }}>/_/, /realtime, /api/health, /api/admin/logs</code>
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
function BackupSection({ toast }: { toast: (text: string, icon?: string) => void }) {
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
    if (!confirm(`Restore from "${file.name}"? This will replace ALL current data.`)) {
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
              localStorage.removeItem("vaultbase_admin_token");
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
