/**
 * First-run setup wizard — implements `Vaultbase Setup.dc.html` from the
 * "Vaultbase redesign scope" design project (boards 1a / 2a / 2b / 3a).
 *
 * Styling is shared with Login in ../styles/auth.css; see the comment at the
 * top of that file for why the design tokens are not hoisted to :root. The
 * password group and error line follow the login board, which is where those
 * two patterns are drawn — the setup board predates them.
 */
import { useEffect, useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import Icon from "../components/Icon.tsx";
import AuthBackdrop from "../components/AuthBackdrop.tsx";
import AuthMark from "../components/AuthMark.tsx";
import { useVersion } from "../stores/version.ts";
import "../styles/auth.css";

type Step = "welcome" | "admin" | "done";

/** Which database this install runs on (`/admin/setup/status`, before the first admin). */
type Database = "sqlite" | "postgres";

const DATABASES_DOC = "https://docs.vaultbase.dev/concepts/databases/";

const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "WELCOME" },
  { id: "admin", label: "ADMIN" },
  { id: "done", label: "DONE" },
];

/**
 * Client-side floor, kept in step with the server's `password.min_length`
 * default (src/core/password-policy.ts). At setup time no settings row exists
 * yet, so the default is what applies. If an operator has pinned a stricter
 * policy the server's own message is surfaced verbatim on submit.
 */
const PW_MIN = 12;

export default function Setup() {
  const [step, setStep] = useState<Step>("welcome");
  const [adminEmail, setAdminEmail] = useState("");
  const [database, setDatabase] = useState<Database | null>(null);
  const version = useVersion();

  useEffect(() => {
    let cancelled = false;
    api.get<ApiResponse<{ database?: Database }>>("/api/v1/admin/setup/status")
      .then((res) => { if (!cancelled && res.data?.database) setDatabase(res.data.database); })
      .catch(() => { /* the welcome step just leaves the database out */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="vb-auth">
      <AuthBackdrop />
      <div className="vb-auth__card">
        <div className="vb-auth__head">
          <AuthMark />
          <span className="vb-auth__ver">{version ? `v${version}` : " "}</span>
        </div>

        <Stepper step={step} />

        {step === "welcome" && <WelcomeStep database={database} onNext={() => setStep("admin")} />}
        {step === "admin" && (
          <AdminStep
            onBack={() => setStep("welcome")}
            onDone={(email) => {
              setAdminEmail(email);
              setStep("done");
            }}
          />
        )}
        {step === "done" && (
          <DoneStep email={adminEmail} onFinish={() => window.location.assign("/_/login")} />
        )}
      </div>
    </div>
  );
}

// ── Stepper ──────────────────────────────────────────────────────────────────
function Stepper({ step }: { step: Step }) {
  const current = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="vb-auth__steps">
      {STEPS.map((s, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <div
            key={s.id}
            className={
              "vb-auth__step" +
              (active ? " vb-auth__step--active" : "") +
              (done ? " vb-auth__step--done" : "")
            }
            aria-current={active ? "step" : undefined}
          >
            <span className="vb-auth__stepnum">
              {done ? "✓" : String(i + 1).padStart(2, "0")}
            </span>
            {s.label}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Welcome ──────────────────────────────────────────────────────────
/** Icon paths come from the design board rather than components/Icon.tsx —
 *  they are drawn at 16px with square caps to match the board exactly. */
const FEATURES: { text: string; path: React.ReactNode }[] = [
  {
    text: "REST API for collections + records",
    path: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </>
    ),
  },
  {
    text: "Built-in auth (email + password, JWT)",
    path: (
      <>
        <circle cx="9" cy="8" r="4" />
        <path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M16 4a4 4 0 0 1 0 8M22 21c0-3-1.8-5.5-4.5-6.5" />
      </>
    ),
  },
  {
    text: "WebSocket realtime — subscribe to changes",
    path: <path d="M2 12h4l3-8 6 16 3-8h4" />,
  },
  {
    text: "Request logging + filterable Logs page",
    path: (
      <>
        <rect x="4" y="2" width="16" height="20" />
        <path d="M8 7h8M8 12h8M8 17h5" />
      </>
    ),
  },
  {
    text: "File uploads (local filesystem)",
    path: <path d="M12 16V3M6 9l6-6 6 6M3 15v6h18v-6" />,
  },
  {
    text: "Single binary, zero deps",
    path: (
      <>
        <rect x="3" y="3" width="18" height="8" />
        <rect x="3" y="13" width="18" height="8" />
        <path d="M7 7h1M7 17h1" />
      </>
    ),
  },
];

/**
 * The database is chosen by the environment before the server starts, never
 * here: this says which one is in use, how to switch while switching is
 * free (nothing has been written that would need moving), and that the
 * first admin makes it final (the server records it and refuses another).
 */
function DatabaseNote({ database }: { database: Database }) {
  const sqlite = database === "sqlite";
  return (
    <div className="vb-auth__db">
      <div className="vb-auth__urls">
        <div className="vb-auth__url">
          <span className="vb-auth__urlkey">DATABASE</span>
          <span className="vb-auth__urlval"><span>{sqlite ? "SQLite" : "Postgres"}</span></span>
        </div>
      </div>
      <p className="vb-auth__note">
        {sqlite ? (
          <>A file in the data directory; nothing to set up. To use Postgres instead, stop the server, set{" "}
          <span className="mono">VAULTBASE_DATABASE_URL</span> and start it again, before creating the admin.</>
        ) : (
          <>From <span className="mono">VAULTBASE_DATABASE_URL</span>. To use SQLite instead, stop the server,
          remove the variable and start it again, before creating the admin.</>
        )}{" "}
        Creating the admin makes the choice final: the install can't move to {sqlite ? "Postgres" : "SQLite"} later.{" "}
        <a href={DATABASES_DOC} target="_blank" rel="noreferrer">Choosing a database</a>
      </p>
    </div>
  );
}

function WelcomeStep({ database, onNext }: { database: Database | null; onNext: () => void }) {
  return (
    <div className="vb-auth__body">
      <div className="vb-auth__intro">
        <h1 className="vb-auth__h1">
          Welcome to Vaultbase<span className="vb-auth__dot">.</span>
        </h1>
        <p className="vb-auth__lead">Let's get you set up — takes about 30 seconds.</p>
      </div>

      <div className="vb-auth__features">
        {FEATURES.map((f) => (
          <div key={f.text} className="vb-auth__feature">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth="1.5"
              strokeLinecap="square"
              aria-hidden="true"
            >
              {f.path}
            </svg>
            <span>{f.text}</span>
          </div>
        ))}
      </div>

      {database && <DatabaseNote database={database} />}

      <div className="vb-auth__actions">
        <button type="button" className="vb-auth__btn" onClick={onNext}>
          <span>Get started</span>
          <span className="arrow">&rarr;</span>
        </button>
        <div className="vb-auth__foot">
          Already have an account? <a href="/_/login">Sign in</a>
        </div>
      </div>
    </div>
  );
}

// ── Step 2: Admin account ────────────────────────────────────────────────────
/**
 * The server prints the setup key to its log on a fresh install, as a
 * `/_/setup#key=…` link. The fragment never reaches the server or its logs.
 */
function keyFromHash(): string {
  const m = /(?:^#|&)key=([^&]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]!) : "";
}

function AdminStep({ onBack, onDone }: { onBack: () => void; onDone: (email: string) => void }) {
  const [setupKey, setSetupKey] = useState(keyFromHash);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const pwTooShort = pw.length > 0 && pw.length < PW_MIN;
  const pwMismatch = pw.length > 0 && pw2.length > 0 && pw !== pw2;
  const valid = setupKey.trim() !== "" && email.includes("@") && pw.length >= PW_MIN && pw === pw2;

  // One message at a time, matching the board's single error line. Local
  // validation first, then whatever the server said.
  const message = pwMismatch
    ? "Passwords do not match."
    : pwTooShort
      ? `Password must be at least ${PW_MIN} characters.`
      : error;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || loading) return;
    setError("");
    setLoading(true);
    const res = await api.post<ApiResponse<{ id: string }>>("/api/v1/admin/setup", {
      email,
      password: pw,
      setup_key: setupKey.trim(),
    });
    setLoading(false);
    if (res.data?.id) onDone(email);
    else if (res.code === 401) setError("Setup key is missing or wrong. It is printed in the server log.");
    else setError(res.error ?? "Setup failed.");
  }

  return (
    <form className="vb-auth__body" onSubmit={handleSubmit}>
      <div className="vb-auth__intro">
        <h1 className="vb-auth__h1">
          Create the admin<span className="vb-auth__dot">.</span>
        </h1>
        <p className="vb-auth__lead">This account owns the instance. You can add more later.</p>
      </div>

      <div className="vb-auth__form">
        <label className="vb-auth__field">
          <span className="vb-auth__label">SETUP KEY</span>
          <input
            className="vb-auth__input"
            type="text"
            value={setupKey}
            onChange={(e) => setSetupKey(e.target.value)}
            placeholder="Printed in the server log"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label className="vb-auth__field">
          <span className="vb-auth__label">EMAIL</span>
          <input
            className="vb-auth__input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoComplete="username"
            autoFocus
          />
        </label>

        <PwField
          label="PASSWORD"
          value={pw}
          onChange={setPw}
          placeholder={`At least ${PW_MIN} characters`}
          bad={pwTooShort}
        />

        <PwField
          label="CONFIRM PASSWORD"
          value={pw2}
          onChange={setPw2}
          placeholder="Repeat password"
          bad={pwMismatch}
        />

        {message && (
          <div className="vb-auth__err" role="alert">
            <span>{message}</span>
          </div>
        )}
      </div>

      <div className="vb-auth__split">
        <button
          type="button"
          className="vb-auth__btn vb-auth__btn--ghost"
          onClick={onBack}
          disabled={loading}
        >
          Back
        </button>
        <button
          type="submit"
          className={"vb-auth__btn" + (!valid && !loading ? " vb-auth__btn--primary-off" : "")}
          disabled={!valid || loading}
        >
          <span>{loading ? "Creating…" : "Create admin"}</span>
          {loading ? <span className="vb-auth__spinner" /> : <span className="arrow">&rarr;</span>}
        </button>
      </div>
    </form>
  );
}

/** Password input + reveal sharing one border, per the login board. */
function PwField({
  label,
  value,
  onChange,
  placeholder,
  bad,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  bad?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="vb-auth__field">
      <span className="vb-auth__label">{label}</span>
      <span className={"vb-auth__pw" + (bad ? " vb-auth__pw--bad" : "")}>
        <input
          className="vb-auth__input"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="new-password"
        />
        <button
          type="button"
          className="vb-auth__reveal"
          onClick={() => setShow((v) => !v)}
          disabled={!value}
          title={show ? "Hide password" : "Show password"}
          aria-label={show ? "Hide password" : "Show password"}
        >
          <Icon name={show ? "eyeOff" : "eye"} size={16} />
        </button>
      </span>
    </label>
  );
}

// ── Step 3: Done ─────────────────────────────────────────────────────────────
function DoneStep({ email, onFinish }: { email: string; onFinish: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const base = window.location.origin;

  function copy(text: string, key: string) {
    navigator.clipboard?.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  const rows = [
    { key: "admin", label: "ADMIN", value: `${base}/_/` },
    { key: "rest", label: "REST", value: `${base}/api/v1/` },
  ];

  return (
    <div className="vb-auth__body">
      <div className="vb-auth__intro">
        <h1 className="vb-auth__h1">
          You're <em>live</em>
          <span className="vb-auth__dot">.</span>
        </h1>
        {/* The board reads "Signed in as …", but POST /admin/setup returns no
            session (src/api/auth.ts) — the next step really is a sign-in. */}
        <p className="vb-auth__lead">
          Admin account <span className="mono">{email}</span> is ready. Sign in to continue.
        </p>
      </div>

      <div className="vb-auth__urls">
        {rows.map((r) => (
          <div key={r.key} className="vb-auth__url">
            <span className="vb-auth__urlkey">{r.label}</span>
            <span className="vb-auth__urlval">
              <span>{r.value}</span>
              <button
                type="button"
                className="vb-auth__copy"
                onClick={() => copy(r.value, r.key)}
                title="Copy"
                aria-label={`Copy ${r.label} URL`}
              >
                <Icon name={copied === r.key ? "check" : "copy"} size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="vb-auth__actions">
        <button type="button" className="vb-auth__btn" onClick={onFinish}>
          <span>Sign in</span>
          <span className="arrow">&rarr;</span>
        </button>
        <div className="vb-auth__foot">
          New here?{" "}
          <a href="https://docs.vaultbase.dev" target="_blank" rel="noreferrer">
            Read the quickstart
          </a>
        </div>
      </div>
    </div>
  );
}
