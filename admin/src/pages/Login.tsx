import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";

export default function Login() {
  const [email, setEmail] = useState("admin@vaultbase.local");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await api.post<ApiResponse<{ token: string }>>("/api/admin/auth/login", {
      email,
      password,
    });
    setLoading(false);
    if (res.data?.token) {
      localStorage.setItem("vaultbase_admin_token", res.data.token);
      navigate("/_/");
    } else {
      setError(res.error ?? "Invalid credentials");
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="sb-brand-mark" />
          <div className="name">vaultbase</div>
        </div>
        <div>
          <h1 className="auth-title">Welcome back</h1>
          <p className="auth-subtitle">Sign in to manage your collections, records and rules.</p>
        </div>
        <form className="auth-form" onSubmit={handleSubmit}>
          {error && (
            <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 12px", background: "rgba(248,113,113,0.1)", borderRadius: 6, border: "0.5px solid rgba(248,113,113,0.3)" }}>
              {error}
            </div>
          )}
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? <span className="spinner" /> : null}
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="auth-foot">
          First time? <a href="/_/setup" style={{ color: "var(--accent-light)" }}>Set up admin account →</a>
        </div>
      </div>
    </div>
  );
}
