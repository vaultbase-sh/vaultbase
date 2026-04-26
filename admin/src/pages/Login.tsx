import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await api.post<ApiResponse<{ token: string }>>("/api/admin/auth/login", {
      email,
      password,
    });
    if (res.data?.token) {
      localStorage.setItem("vaultbase_admin_token", res.data.token);
      navigate("/_/");
    } else {
      setError(res.error ?? "Login failed");
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
        <h1 style={{ margin: "0 0 24px", fontSize: 22 }}>Vaultbase Admin</h1>
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
          Sign in
        </button>
      </form>
    </div>
  );
}
