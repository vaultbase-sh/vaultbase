import { useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import Icon from "../components/Icon.tsx";

export default function Settings({
  adminEmail,
  toast,
}: {
  adminEmail: string;
  toast: (text: string, icon?: string) => void;
}) {
  const [email, setEmail] = useState(adminEmail);
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [resetConfirm, setResetConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSaveAccount(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await new Promise((r) => setTimeout(r, 400));
    setSaving(false);
    toast("Admin account saved");
  }

  return (
    <>
      <Topbar title="Settings" subtitle="Application & admin configuration" />
      <div className="app-body" style={{ maxWidth: 880 }}>

        {/* Admin account */}
        <div className="settings-section">
          <div className="settings-section-head">
            <h3>Admin account</h3>
            <span className="meta">superuser credentials</span>
          </div>
          <div className="settings-section-body">
            <div className="label-block">
              <label className="label">Email</label>
              <div className="help">Used to sign in to this admin panel.</div>
            </div>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div className="label-block span2">
              <div className="divider" style={{ margin: 0 }} />
            </div>
            <div className="label-block">
              <label className="label">Change password</label>
              <div className="help">Min 8 characters.</div>
            </div>
            <div className="col">
              <input
                className="input"
                type="password"
                placeholder="Current password"
                value={pwForm.current}
                onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
              />
              <input
                className="input"
                type="password"
                placeholder="New password"
                value={pwForm.next}
                onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })}
              />
              <input
                className="input"
                type="password"
                placeholder="Confirm new password"
                value={pwForm.confirm}
                onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
              />
            </div>
          </div>
          <div className="settings-section-foot">
            <button className="btn btn-primary" disabled={saving} onClick={handleSaveAccount}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>

        {/* Application */}
        <div className="settings-section">
          <div className="settings-section-head">
            <h3>Application</h3>
            <span className="meta">runtime configuration</span>
          </div>
          <div className="settings-section-body">
            <div className="label-block">
              <label className="label">App name</label>
              <div className="help">Shown in the admin header.</div>
            </div>
            <input className="input" defaultValue="vaultbase" />

            <div className="label-block">
              <label className="label">Base URL</label>
              <div className="help">Public URL of your instance.</div>
            </div>
            <input className="input mono" defaultValue="http://localhost:8091" />

            <div className="label-block">
              <label className="label">Data directory</label>
              <div className="help">Configured via <span className="mono">VAULTBASE_DATA_DIR</span>.</div>
            </div>
            <input className="input mono" defaultValue="./vaultbase_data" disabled />
          </div>
          <div className="settings-section-foot">
            <button className="btn btn-primary" onClick={() => toast("Application settings saved")}>
              Save changes
            </button>
          </div>
        </div>

        {/* SMTP */}
        <div className="settings-section disabled">
          <div className="settings-section-head">
            <h3>SMTP</h3>
            <span className="badge auth">Coming in v2</span>
            <span className="meta" style={{ marginLeft: "auto" }}>used for password reset emails</span>
          </div>
          <div className="settings-section-body">
            <div className="label-block"><label className="label">SMTP host</label></div>
            <input className="input mono" placeholder="smtp.example.com" disabled />
            <div className="label-block"><label className="label">Port</label></div>
            <input className="input mono" placeholder="587" disabled />
            <div className="label-block"><label className="label">Username</label></div>
            <input className="input" placeholder="postmaster@example.com" disabled />
            <div className="label-block"><label className="label">Password</label></div>
            <input className="input" type="password" placeholder="••••••••" disabled />
          </div>
        </div>

        {/* Danger zone */}
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
            <div className="label-block span2"><div className="divider" style={{ margin: 0 }} /></div>
            <div className="label-block">
              <label className="label" style={{ color: "var(--danger)" }}>Reset all data</label>
              <div className="help">
                Deletes all collections and records. Type{" "}
                <span className="mono" style={{ color: "var(--danger)" }}>delete</span> to confirm.
              </div>
            </div>
            <div className="row">
              <input
                className="input mono"
                placeholder="delete"
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                style={{ maxWidth: 200 }}
              />
              <button className="btn btn-danger" disabled={resetConfirm !== "delete"}>
                <Icon name="trash" size={12} /> Reset all data
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
