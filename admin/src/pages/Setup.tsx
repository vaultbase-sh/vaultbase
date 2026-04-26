import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";

export default function Setup() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const valid = email.includes("@") && pw.length >= 8 && pw === pw2;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setError("");
    setLoading(true);
    const res = await api.post<ApiResponse<{ id: string }>>("/api/admin/setup", {
      email,
      password: pw,
    });
    setLoading(false);
    if (res.data?.id) {
      navigate("/_/login");
    } else {
      setError(res.error ?? "Setup failed");
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card wide">
        <div className="auth-brand">
          <div className="sb-brand-mark" />
          <div className="name">vaultbase</div>
        </div>
        <div>
          <h1 className="auth-title">Set up your admin account</h1>
          <p className="auth-subtitle">
            This is shown once. You can change these details later in settings.
          </p>
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
            <input
              className="input"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <div>
            <label className="label">Confirm password</label>
            <input
              className="input"
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" disabled={!valid || loading}>
            {loading ? <span className="spinner" /> : null}
            {loading ? "Creating…" : "Create admin account"}
          </button>
        </form>
        <div className="auth-foot">
          Already have an account?{" "}
          <a href="/_/login" style={{ color: "var(--accent-light)" }}>Sign in →</a>
        </div>
      </div>
    </div>
  );
}
