import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";
import { useAuth } from "../stores/auth.ts";
import { VaultbaseLogo } from "../components/VaultbaseLogo.tsx";
import Icon from "../components/Icon.tsx";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await api.post<ApiResponse<{ token: string }>>("/api/v1/admin/auth/login", {
      email,
      password,
    });
    setLoading(false);
    if (res.data?.token) {
      const { setMemoryToken } = await import("../api.ts");
      setMemoryToken(res.data.token);
      await useAuth.getState().signIn();
      navigate("/_/");
    } else {
      setError(res.error ?? "Invalid credentials");
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="sb-brand-mark"><VaultbaseLogo size={26} /></span>
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
              placeholder="you@example.com"
              autoFocus
            />
          </div>
          <div>
            <label className="label">Password</label>
            <div style={{ position: "relative" }}>
              <input
                className="input"
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                style={{ paddingRight: 36 }}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                disabled={!password}
                title={showPw ? "Hide" : "Show"}
                style={{
                  position: "absolute",
                  right: 8, top: "50%", transform: "translateY(-50%)",
                  background: "transparent", border: 0,
                  color: "var(--vb-fg-3, #888)",
                  cursor: password ? "pointer" : "default",
                  padding: 4, display: "flex",
                }}
              >
                <Icon name={showPw ? "eyeOff" : "eye"} size={14} />
              </button>
            </div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? <span className="spinner" /> : null}
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
