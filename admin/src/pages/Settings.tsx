import { useEffect, useRef, useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Modal } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

interface Admin {
  id: string;
  email: string;
  created_at: number;
}

export default function Settings({
  adminEmail,
  toast,
}: {
  adminEmail: string;
  toast: (text: string, icon?: string) => void;
}) {
  return (
    <>
      <Topbar title="Settings" subtitle="Application & admin configuration" />
      <div className="app-body" style={{ maxWidth: 880 }}>
        <AdminsSection adminEmail={adminEmail} toast={toast} />
        <ApplicationSection />
        <BackupSection toast={toast} />
        <DangerZone />
      </div>
    </>
  );
}

// ── Admins management ───────────────────────────────────────────────────────
function AdminsSection({
  adminEmail,
  toast,
}: {
  adminEmail: string;
  toast: (text: string, icon?: string) => void;
}) {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState<Admin | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await api.get<ApiResponse<Admin[]>>("/api/admin/admins");
    if (res.data) setAdmins(res.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function handleDelete(a: Admin) {
    if (!confirm(`Delete admin '${a.email}'?`)) return;
    const res = await api.delete<ApiResponse<null>>(`/api/admin/admins/${a.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Admin deleted", "trash");
    load();
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Admins</h3>
        <span className="meta">{admins.length} superuser{admins.length === 1 ? "" : "s"}</span>
        <button
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          onClick={() => setShowAdd(true)}
        >
          <Icon name="plus" size={12} /> Add admin
        </button>
      </div>
      <div style={{ padding: "8px 0" }}>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : admins.length === 0 ? (
          <div className="empty">No admins.</div>
        ) : (
          <table className="table" style={{ background: "transparent" }}>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="row" style={{ gap: 10 }}>
                      <div
                        style={{
                          width: 28, height: 28, borderRadius: "50%",
                          background: "linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent), purple 40%))",
                          display: "grid", placeItems: "center", fontSize: 12, fontWeight: 600, color: "#000",
                        }}
                      >
                        {a.email[0]!.toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontSize: 13 }}>{a.email}</div>
                        <div className="muted mono" style={{ fontSize: 10.5 }}>
                          {a.id.slice(0, 12)}… · joined {new Date(a.created_at * 1000).toLocaleDateString()}
                          {a.email === adminEmail && " · you"}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="right">
                    <span className="row-actions" style={{ opacity: 1, gap: 4 }}>
                      <button
                        className="btn-icon"
                        onClick={() => setShowEdit(a)}
                        title="Edit"
                      >
                        <Icon name="pencil" size={12} />
                      </button>
                      <button
                        className="btn-icon danger"
                        onClick={() => handleDelete(a)}
                        title="Delete"
                        disabled={a.email === adminEmail}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <AddAdminModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => { toast("Admin added"); load(); }} />
      <EditAdminModal admin={showEdit} onClose={() => setShowEdit(null)} onSaved={() => { toast("Admin updated"); load(); }} />
    </div>
  );
}

function AddAdminModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setEmail(""); setPw(""); setError(""); setSaving(false); }
  }, [open]);

  async function handleSubmit() {
    if (!email.includes("@")) { setError("Invalid email"); return; }
    if (pw.length < 8) { setError("Password must be at least 8 characters"); return; }
    setError(""); setSaving(true);
    const res = await api.post<ApiResponse<Admin>>("/api/admin/admins", { email, password: pw });
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onAdded(); onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add admin"
      width={400}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? "Adding…" : "Add admin"}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 12px", background: "rgba(248,113,113,0.1)", borderRadius: 6 }}>
            {error}
          </div>
        )}
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="label">Password (min 8 chars)</label>
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function EditAdminModal({ admin, onClose, onSaved }: { admin: Admin | null; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (admin) { setEmail(admin.email); setPw(""); setError(""); setSaving(false); }
  }, [admin]);

  async function handleSubmit() {
    if (!admin) return;
    if (!email.includes("@")) { setError("Invalid email"); return; }
    if (pw && pw.length < 8) { setError("Password must be at least 8 characters"); return; }
    const body: { email?: string; password?: string } = {};
    if (email !== admin.email) body.email = email;
    if (pw) body.password = pw;
    if (Object.keys(body).length === 0) { onClose(); return; }
    setError(""); setSaving(true);
    const res = await api.patch<ApiResponse<Admin>>(`/api/admin/admins/${admin.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved(); onClose();
  }

  return (
    <Modal
      open={!!admin}
      onClose={onClose}
      title="Edit admin"
      width={400}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 12px", background: "rgba(248,113,113,0.1)", borderRadius: 6 }}>
            {error}
          </div>
        )}
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label">New password (leave blank to keep)</label>
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
        </div>
      </div>
    </Modal>
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
