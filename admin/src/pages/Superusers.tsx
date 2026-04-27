import { useEffect, useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Modal } from "../components/UI.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";
import { useAuth } from "../stores/auth.ts";
import Icon from "../components/Icon.tsx";

interface Admin {
  id: string;
  email: string;
  created_at: number;
}

export default function Superusers() {
  const adminEmail = useAuth((s) => s.email);
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
    const ok = await confirm({
      title: "Delete superuser",
      message: `Delete superuser '${a.email}'?\n\nThey will lose admin access immediately.`,
      danger: true,
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<null>>(`/api/admin/admins/${a.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Superuser deleted", "trash");
    load();
  }

  return (
    <>
      <Topbar
        title="Superusers"
        subtitle={`${admins.length} account${admins.length === 1 ? "" : "s"} with full system access`}
        actions={
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={12} /> New superuser
          </button>
        }
      />
      <div className="app-body">
        <div className="table-wrap">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : admins.length === 0 ? (
            <div className="empty">No superusers.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: "50%" }}>Email</th>
                  <th>Created</th>
                  <th style={{ textAlign: "right" }} />
                </tr>
              </thead>
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
                            flexShrink: 0,
                          }}
                        >
                          {a.email[0]!.toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontSize: 13 }}>{a.email}</div>
                          <div className="muted mono" style={{ fontSize: 10.5 }}>
                            {a.id.slice(0, 12)}…
                            {a.email === adminEmail && (
                              <span style={{ color: "var(--accent-light)", marginLeft: 6 }}>· you</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="muted mono-cell" style={{ fontSize: 11.5 }}>
                      {new Date(a.created_at * 1000).toLocaleDateString()}
                    </td>
                    <td style={{ textAlign: "right" }}>
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
                          title={a.email === adminEmail ? "Cannot delete your own account" : "Delete"}
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
      </div>

      <AddSuperuserModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => { toast("Superuser added"); load(); }} />
      <EditSuperuserModal admin={showEdit} onClose={() => setShowEdit(null)} onSaved={() => { toast("Superuser updated"); load(); }} />
    </>
  );
}

function AddSuperuserModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
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
      title="New superuser"
      width={400}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? "Adding…" : "Create"}
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

function EditSuperuserModal({ admin, onClose, onSaved }: { admin: Admin | null; onClose: () => void; onSaved: () => void }) {
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
      title="Edit superuser"
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
