import { useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import Icon from "../components/Icon.tsx";
import { VaultbaseLogo } from "../components/VaultbaseLogo.tsx";
import { useVersion } from "../stores/version.ts";

type Step = "welcome" | "admin" | "done";

export default function Setup() {
  const [step, setStep] = useState<Step>("welcome");
  const [adminEmail, setAdminEmail] = useState("");
  const version = useVersion();

  return (
    <div className="auth-shell">
      <div className="auth-card wide" style={{ width: 520 }}>
        <div className="auth-brand">
          <span className="sb-brand-mark"><VaultbaseLogo size={26} /></span>
          <div className="name">vaultbase</div>
          {version && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              v{version}
            </span>
          )}
        </div>

        <StepIndicator step={step} />

        {step === "welcome" && <WelcomeStep onNext={() => setStep("admin")} />}
        {step === "admin"   && <AdminStep   onDone={(email) => { setAdminEmail(email); setStep("done"); }} />}
        {step === "done"    && <DoneStep    email={adminEmail} onFinish={() => { window.location.assign("/_/login"); }} />}
      </div>
    </div>
  );
}

// ── Step indicator ───────────────────────────────────────────────────────────
/** Password input with reveal toggle for the setup + login auth screens. */
function PwInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        className="input"
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ paddingRight: 36 }}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        disabled={!value}
        title={show ? "Hide" : "Show"}
        style={{
          position: "absolute",
          right: 8, top: "50%", transform: "translateY(-50%)",
          background: "transparent", border: 0,
          color: "var(--vb-fg-3, #888)",
          cursor: value ? "pointer" : "default",
          padding: 4, display: "flex",
        }}
      >
        <Icon name={show ? "eyeOff" : "eye"} size={14} />
      </button>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "welcome", label: "Welcome" },
    { id: "admin",   label: "Admin"   },
    { id: "done",    label: "Done"    },
  ];
  const currentIdx = steps.findIndex((s) => s.id === step);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: -4 }}>
      {steps.map((s, i) => {
        const active = i === currentIdx;
        const past = i < currentIdx;
        return (
          <div key={s.id} style={{ display: "flex", alignItems: "center", flex: 1, gap: 8 }}>
            <div
              style={{
                width: 24, height: 24, borderRadius: "50%",
                display: "grid", placeItems: "center",
                fontSize: 11, fontFamily: "var(--font-mono)",
                background: past || active ? "var(--accent)" : "rgba(255,255,255,0.06)",
                color: past || active ? "#000" : "var(--text-muted)",
                border: `0.5px solid ${active ? "var(--accent)" : "var(--border-default)"}`,
                flexShrink: 0,
              }}
            >
              {past ? <Icon name="check" size={11} /> : i + 1}
            </div>
            <span style={{ fontSize: 12, color: active ? "var(--text-primary)" : "var(--text-muted)", flex: 1 }}>
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <div
                style={{
                  flex: 1, height: 1, marginRight: 4,
                  background: past ? "var(--accent)" : "var(--border-default)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Welcome ──────────────────────────────────────────────────────────
function WelcomeStep({ onNext }: { onNext: () => void }) {
  const features = [
    { icon: "database", text: "REST API for collections + records" },
    { icon: "users",    text: "Built-in auth (email + password, JWT)" },
    { icon: "activity", text: "WebSocket realtime — subscribe to changes" },
    { icon: "scroll",   text: "Request logging + filterable Logs page" },
    { icon: "upload",   text: "File uploads (local filesystem)" },
    { icon: "server",   text: "Single binary, SQLite, zero deps" },
  ];
  return (
    <>
      <div>
        <h1 className="auth-title">Welcome to Vaultbase</h1>
        <p className="auth-subtitle">
          Self-hosted backend in a single binary. Let's get you set up — takes about 30 seconds.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", background: "rgba(255,255,255,0.025)", borderRadius: 8, border: "0.5px solid var(--border-default)" }}>
        {features.map((f) => (
          <div key={f.text} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
            <Icon name={f.icon} size={14} style={{ color: "var(--accent)" }} />
            <span>{f.text}</span>
          </div>
        ))}
      </div>
      <button className="btn btn-primary" style={{ width: "100%", height: 36, justifyContent: "center" }} onClick={onNext}>
        Get started <Icon name="chevronRight" size={12} />
      </button>
      <div className="auth-foot">
        Already have an account? <a href="/_/login" style={{ color: "var(--accent-light)" }}>Sign in →</a>
      </div>
    </>
  );
}

// ── Step 2: Admin account ────────────────────────────────────────────────────
function AdminStep({ onDone }: { onDone: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const valid = email.includes("@") && pw.length >= 8 && pw === pw2;
  const pwMismatch = pw && pw2 && pw !== pw2;
  const pwTooShort = pw.length > 0 && pw.length < 8;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setError("");
    setLoading(true);
    const res = await api.post<ApiResponse<{ id: string }>>("/api/v1/admin/setup", {
      email,
      password: pw,
    });
    setLoading(false);
    if (res.data?.id) {
      onDone(email);
    } else {
      setError(res.error ?? "Setup failed");
    }
  }

  return (
    <>
      <div>
        <h1 className="auth-title">Create admin account</h1>
        <p className="auth-subtitle">
          This is your superuser. You can change credentials later in Settings.
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
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus />
        </div>
        <div>
          <label className="label">Password</label>
          <PwInput value={pw} onChange={setPw} placeholder="At least 8 characters" />
          {pwTooShort && (
            <div style={{ fontSize: 11, color: "var(--warning)", marginTop: 4 }}>
              Password must be at least 8 characters
            </div>
          )}
        </div>
        <div>
          <label className="label">Confirm password</label>
          <PwInput value={pw2} onChange={setPw2} />
          {pwMismatch && (
            <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>
              Passwords don't match
            </div>
          )}
        </div>
        <button className="btn btn-primary" disabled={!valid || loading}>
          {loading ? <span className="spinner" /> : null}
          {loading ? "Creating…" : "Create admin account"}
        </button>
      </form>
    </>
  );
}

// ── Step 3: Done ─────────────────────────────────────────────────────────────
function DoneStep({ email, onFinish }: { email: string; onFinish: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const baseUrl = window.location.origin;

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  const curlExample = `curl ${baseUrl}/api/health`;

  return (
    <>
      <div>
        <h1 className="auth-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 26, height: 26, borderRadius: "50%",
              background: "var(--success)", display: "grid", placeItems: "center",
            }}
          >
            <Icon name="check" size={14} style={{ color: "#000" }} />
          </span>
          You're all set
        </h1>
        <p className="auth-subtitle">
          Admin account <span className="mono" style={{ color: "var(--text-secondary)" }}>{email}</span> ready.
          Sign in to start managing your data.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <InfoBlock
          label="Admin panel"
          value={`${baseUrl}/_/`}
          copied={copied === "admin"}
          onCopy={() => copy(`${baseUrl}/_/`, "admin")}
        />
        <InfoBlock
          label="API base"
          value={`${baseUrl}/api/`}
          copied={copied === "api"}
          onCopy={() => copy(`${baseUrl}/api/`, "api")}
        />
        <InfoBlock
          label="Realtime WS"
          value={`${baseUrl.replace(/^http/, "ws")}/realtime`}
          copied={copied === "ws"}
          onCopy={() => copy(`${baseUrl.replace(/^http/, "ws")}/realtime`, "ws")}
        />

        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 500 }}>
            Try a request
          </div>
          <div className="code-block" style={{ position: "relative", paddingRight: 40 }}>
            {curlExample}
            <button
              className="btn-icon"
              style={{ position: "absolute", top: 6, right: 6 }}
              onClick={() => copy(curlExample, "curl")}
              title="Copy"
            >
              <Icon name={copied === "curl" ? "check" : "copy"} size={12} />
            </button>
          </div>
        </div>
      </div>

      <button className="btn btn-primary" style={{ width: "100%", height: 36, justifyContent: "center" }} onClick={onFinish}>
        Continue to login <Icon name="chevronRight" size={12} />
      </button>
    </>
  );
}

function InfoBlock({ label, value, copied, onCopy }: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 500 }}>
        {label}
      </div>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 10px",
          background: "rgba(255,255,255,0.04)",
          border: "0.5px solid var(--border-default)",
          borderRadius: 6,
        }}
      >
        <span className="mono" style={{ flex: 1, fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {value}
        </span>
        <button className="btn-icon" onClick={onCopy} title="Copy">
          <Icon name={copied ? "check" : "copy"} size={12} />
        </button>
      </div>
    </div>
  );
}
