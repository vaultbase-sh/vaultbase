import { useEffect, useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import {
  VbBtn, VbEmptyState, VbField, VbInput, VbPageHeader, VbPill,
  VbTable, type VbTableColumn,
} from "../components/Vb.tsx";
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
    const res = await api.get<ApiResponse<Admin[]>>("/api/v1/admin/admins");
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
    const res = await api.delete<ApiResponse<null>>(`/api/v1/admin/admins/${a.id}`);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Superuser deleted", "trash");
    load();
  }

  const columns: VbTableColumn<Admin>[] = [
    { key: "email", label: "Email", flex: 2, render: (a) => (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <span style={{
          width: 28, height: 28, borderRadius: 6,
          background: "var(--vb-accent)",
          display: "grid", placeItems: "center",
          fontSize: 12, fontWeight: 600, color: "#fff",
          flexShrink: 0,
        }}>{a.email[0]!.toUpperCase()}</span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontSize: 13, color: "var(--vb-fg)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {a.email}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--vb-fg-3)" }}>
            {a.id.slice(0, 12)}…
            {a.email === adminEmail && (
              <span style={{ color: "var(--vb-accent)", marginLeft: 6 }}>· you</span>
            )}
          </span>
        </span>
      </span>
    )},
    { key: "created_at", label: "Created", width: 140, mono: true, render: (a) => (
      <span style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
        {new Date(a.created_at * 1000).toLocaleDateString()}
      </span>
    )},
    { key: "actions", label: "", width: 96, align: "right", render: (a) => (
      <span
        style={{ display: "inline-flex", gap: 4, justifyContent: "flex-end" }}
        onClick={(e) => e.stopPropagation()}
      >
        <VbBtn kind="ghost" size="sm" icon="pencil" onClick={() => setShowEdit(a)} title="Edit" />
        <VbBtn
          kind="danger"
          size="sm"
          icon="trash"
          onClick={() => handleDelete(a)}
          disabled={a.email === adminEmail}
          title={a.email === adminEmail ? "Cannot delete your own account" : "Delete"}
        />
      </span>
    )},
  ];

  return (
    <>
      <VbPageHeader
        breadcrumb={["Superusers"]}
        title="Superusers"
        sub="Operator-equivalent admin accounts. Compromise of any superuser is equivalent to root on the host — treat them carefully."
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <VbPill tone="warning" dot>{admins.length} active</VbPill>
            <VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowAdd(true)}>
              New superuser
            </VbBtn>
          </span>
        }
      />
      <div className="app-body">
        <VbTable<Admin>
          rows={admins}
          columns={columns}
          rowKey={(a) => a.id}
          loading={loading}
          onRowClick={(a) => setShowEdit(a)}
          emptyState={
            <VbEmptyState
              icon="users"
              title="No superusers"
              body="Superusers have full admin access — they can manage collections, edit hooks, and impersonate any user."
              actions={<VbBtn kind="primary" size="sm" icon="plus" onClick={() => setShowAdd(true)}>New superuser</VbBtn>}
            />
          }
        />
      </div>

      <AddSuperuserModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => { toast("Superuser added"); load(); }} />
      <EditSuperuserModal admin={showEdit} onClose={() => setShowEdit(null)} onSaved={() => { toast("Superuser updated"); load(); }} />
    </>
  );
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
    const res = await api.post<ApiResponse<Admin>>("/api/v1/admin/admins", { email, password: pw });
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onAdded(); onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New superuser"
      width={420}
      footer={
        <>
          <VbBtn kind="ghost" size="sm" onClick={onClose}>Cancel</VbBtn>
          <VbBtn kind="primary" size="sm" icon="check" onClick={handleSubmit} disabled={saving}>
            {saving ? "Adding…" : "Create"}
          </VbBtn>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {error && <ModalErrorBar message={error} />}
        <VbField label="Email">
          <VbInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus placeholder="ops@example.com" />
        </VbField>
        <VbField label="Password" hint="min 8 characters">
          <VbInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
        </VbField>
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
    const res = await api.patch<ApiResponse<Admin>>(`/api/v1/admin/admins/${admin.id}`, body);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    onSaved(); onClose();
  }

  return (
    <Modal
      open={!!admin}
      onClose={onClose}
      title="Edit superuser"
      width={420}
      footer={
        <>
          <VbBtn kind="ghost" size="sm" onClick={onClose}>Cancel</VbBtn>
          <VbBtn kind="primary" size="sm" icon="check" onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </VbBtn>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {error && <ModalErrorBar message={error} />}
        <VbField label="Email">
          <VbInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </VbField>
        <VbField label="New password" hint="leave blank to keep current">
          <VbInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
        </VbField>
      </div>
    </Modal>
  );
}
