import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";

export default function Setup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await api.post<ApiResponse<{ id: string }>>("/api/admin/setup", {
      email,
      password,
    });
    if (res.data?.id) {
      navigate("/_/login");
    } else {
      setError(res.error ?? "Setup failed");
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "#f4f4f5",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: "#fff",
          padding: 32,
          borderRadius: 8,
          width: 320,
          boxShadow: "0 2px 8px #0002",
        }}
      >
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Vaultbase Setup</h1>
        <p style={{ margin: "0 0 24px", color: "#71717a", fontSize: 14 }}>
          Create your admin account.
        </p>
        {error && <div style={{ color: "#dc2626", marginBottom: 12 }}>{error}</div>}
        <label style={{ display: "block", marginBottom: 8, fontSize: 14 }}>Email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          required
          style={{
            width: "100%",
            padding: "8px 10px",
            marginBottom: 16,
            border: "1px solid #d4d4d8",
            borderRadius: 4,
            boxSizing: "border-box",
          }}
        />
        <label style={{ display: "block", marginBottom: 8, fontSize: 14 }}>Password</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          required
          minLength={8}
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
            width: "100%",
            padding: "10px",
            background: "#18181b",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 15,
          }}
        >
          Create admin account
        </button>
      </form>
    </div>
  );
}
