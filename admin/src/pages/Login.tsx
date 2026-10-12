/**
 * Admin sign-in — implements `Vaultbase Login.dc.html` from the "Vaultbase
 * redesign scope" project (boards 1a idle / 1b submitting / 1c 401 / 1d 429).
 *
 * Styling is shared with Setup in ../styles/auth.css; see the comment at the
 * top of that file for why the design tokens are not hoisted to :root.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";
import { useAuth } from "../stores/auth.ts";
import AuthBackdrop from "../components/AuthBackdrop.tsx";
import AuthMark from "../components/AuthMark.tsx";
import { useVersion } from "../stores/version.ts";
import "../styles/auth.css";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /**
   * Board 1d. The server answers 429 while a lockout window is open, so the
   * form is dead until it expires — the board disables the fields and swaps
   * the button to an outline rather than leaving an accent control that
   * refuses. (Lockout is on by default — 10 failures in 15 minutes — unless
   * an operator sets `auth.lockout.max_attempts` to 0.)
   */
  const [lockedOut, setLockedOut] = useState(false);
  const navigate = useNavigate();
  const version = useVersion();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading || lockedOut) return;
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
      return;
    }
    if (res.code === 429) setLockedOut(true);
    setError(res.error ?? "Invalid credentials");
  }

  const disabled = loading || lockedOut;

  return (
    <div className="vb-auth">
      <AuthBackdrop clearing={0.4} maxPackets={9} />
      <div className="vb-auth__card vb-auth__card--sm">
        <div className="vb-auth__head">
          <AuthMark />
          <span className="vb-auth__ver">{version ? `v${version}` : " "}</span>
        </div>

        <form className="vb-auth__body" onSubmit={handleSubmit}>
          <div className="vb-auth__intro">
            <h1 className="vb-auth__h1">
              Welcome <em>back</em>
              <span className="vb-auth__dot">.</span>
            </h1>
            <p className="vb-auth__lead">Sign in to manage your collections, records and rules.</p>
          </div>

          <div className="vb-auth__form">
            <label className="vb-auth__field">
              <span className="vb-auth__label">EMAIL</span>
              <input
                className={"vb-auth__input" + (error && !lockedOut ? " vb-auth__input--bad" : "")}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="username"
                disabled={lockedOut}
                autoFocus
              />
            </label>

            <label className="vb-auth__field">
              <span className="vb-auth__label">PASSWORD</span>
              <span className={"vb-auth__pw" + (error && !lockedOut ? " vb-auth__pw--bad" : "")}>
                <input
                  className="vb-auth__input"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  disabled={lockedOut}
                />
                <button
                  type="button"
                  className="vb-auth__reveal"
                  onClick={() => setShowPw((v) => !v)}
                  disabled={lockedOut || !password}
                  title={showPw ? "Hide password" : "Show password"}
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  <EyeIcon off={showPw} />
                </button>
              </span>
            </label>
          </div>

          <div className="vb-auth__actions">
            {error && (
              <div className="vb-auth__err" role="alert">
                <span>{error}</span>
              </div>
            )}
            <button
              type="submit"
              className={"vb-auth__btn" + (lockedOut ? " vb-auth__btn--blocked" : "")}
              disabled={disabled}
            >
              <span>{loading ? "Signing in…" : "Sign in"}</span>
              {loading ? (
                <span className="vb-auth__spinner" />
              ) : (
                <span className="arrow">&rarr;</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The board's eye, with the struck-through variant for the revealed state. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}
