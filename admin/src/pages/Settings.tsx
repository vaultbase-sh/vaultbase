import { useState } from "react";
import { Topbar } from "../components/Shell.tsx";
import Icon from "../components/Icon.tsx";

export default function Settings({
  adminEmail,
  toast,
}: {
  adminEmail: string;
  toast: (text: string, icon?: string) => void;
}) {
  const [resetConfirm, setResetConfirm] = useState("");

  return (
    <>
      <Topbar title="Settings" subtitle="Application & admin configuration" />
      <div className="app-body" style={{ maxWidth: 880 }}>

        {/* Admin account — read-only in v1, update endpoint coming in v2 */}
        <div className="settings-section">
          <div className="settings-section-head">
            <h3>Admin account</h3>
            <span className="meta">superuser credentials</span>
          </div>
          <div className="settings-section-body">
            <div className="label-block">
              <label className="label">Email</label>
              <div className="help">Currently signed in as this address.</div>
            </div>
            <input className="input" value={adminEmail} readOnly />

            <div className="label-block span2">
              <div className="divider" style={{ margin: 0 }} />
            </div>

            <div className="label-block">
              <label className="label">Change password</label>
              <div className="help">
                Admin credential update available in v2.{" "}
                Use{" "}
                <code
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "rgba(255,255,255,0.05)",
                    padding: "1px 5px",
                    borderRadius: 3,
                    color: "var(--text-secondary)",
                  }}
                >
                  VAULTBASE_JWT_SECRET
                </code>{" "}
                env var to rotate the signing key now.
              </div>
            </div>
            <div className="col">
              <input className="input" type="password" placeholder="Current password" disabled />
              <input className="input" type="password" placeholder="New password" disabled />
              <input className="input" type="password" placeholder="Confirm new password" disabled />
            </div>
          </div>
          <div className="settings-section-foot">
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Admin profile update available in v2
            </span>
            <button className="btn btn-primary" disabled style={{ opacity: 0.4, cursor: "not-allowed" }}>
              Save changes
            </button>
          </div>
        </div>

        {/* Application config — runtime values are env-driven, not editable via UI in v1 */}
        <div className="settings-section">
          <div className="settings-section-head">
            <h3>Application</h3>
            <span className="meta">runtime configuration</span>
          </div>
          <div className="settings-section-body">
            <div className="label-block">
              <label className="label">Port</label>
              <div className="help">Set via <code style={{ fontFamily: "var(--font-mono)", background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: 3, color: "var(--text-secondary)" }}>VAULTBASE_PORT</code></div>
            </div>
            <input className="input mono" defaultValue="8091" disabled />

            <div className="label-block">
              <label className="label">Data directory</label>
              <div className="help">Set via <code style={{ fontFamily: "var(--font-mono)", background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: 3, color: "var(--text-secondary)" }}>VAULTBASE_DATA_DIR</code></div>
            </div>
            <input className="input mono" defaultValue="./vaultbase_data" disabled />

            <div className="label-block">
              <label className="label">JWT secret</label>
              <div className="help">Auto-generated on first run. Stored in <code style={{ fontFamily: "var(--font-mono)", background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: 3, color: "var(--text-secondary)" }}>data_dir/.secret</code></div>
            </div>
            <input className="input mono" value="••••••••••••••••••••••••••••••••" disabled />
          </div>
          <div className="settings-section-foot">
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Runtime config is set via environment variables
            </span>
          </div>
        </div>

        {/* SMTP — v2 */}
        <div className="settings-section disabled">
          <div className="settings-section-head">
            <h3>SMTP</h3>
            <span className="badge auth" style={{ marginLeft: 8 }}>Available in v2</span>
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

            <div className="label-block span2">
              <div className="divider" style={{ margin: 0 }} />
            </div>

            <div className="label-block">
              <label className="label" style={{ color: "var(--danger)" }}>Reset all data</label>
              <div className="help">
                Deletes all collections and records. Type{" "}
                <span className="mono" style={{ color: "var(--danger)" }}>delete</span> to confirm.
                <br />
                <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                  Bulk reset endpoint available in v2. For now, delete collections individually.
                </span>
              </div>
            </div>
            <div className="row">
              <input
                className="input mono"
                placeholder="delete"
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                style={{ maxWidth: 200 }}
                disabled
              />
              <button className="btn btn-danger" disabled style={{ opacity: 0.4, cursor: "not-allowed" }}>
                <Icon name="trash" size={12} /> Reset all data
                <span style={{ fontSize: 10, marginLeft: 4 }}>v2</span>
              </button>
            </div>
          </div>
        </div>

      </div>
    </>
  );
}
