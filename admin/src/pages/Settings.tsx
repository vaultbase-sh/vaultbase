import { useState } from "react";
import { api, type ApiResponse } from "../api.ts";

export default function Settings() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const me = await api.get<ApiResponse<{ id: string }>>("/api/admin/auth/me");
    if (!me.data?.id) {
      setMsg("Not authenticated");
      return;
    }
    setMsg("Settings saved (stub — extend via PATCH /api/admin/profile when implemented)");
  }

  return (
    <div style={{ maxWidth: 400 }}>
      <h1 style={{ margin: "0 0 24px" }}>Settings</h1>
      <form onSubmit={handleSubmit}>
        {msg && <div style={{ marginBottom: 16, color: "#16a34a" }}>{msg}</div>}
        <label style={{ display: "block", marginBottom: 8, fontSize: 14 }}>New email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          style={{
            width: "100%",
            padding: "8px 10px",
            marginBottom: 16,
            border: "1px solid #d4d4d8",
            borderRadius: 4,
            boxSizing: "border-box",
          }}
        />
        <label style={{ display: "block", marginBottom: 8, fontSize: 14 }}>New password</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          style={{
            width: "100%",
            padding: "8px 10px",
            marginBottom: 24,
            border: "1px solid #d4d4d8",
            borderRadius: 4,
            boxSizing: "border-box",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "10px 20px",
            background: "#18181b",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Save changes
        </button>
      </form>
    </div>
  );
}
