import type { ReactNode } from "react";
import { VaultbaseLogo } from "./components/VaultbaseLogo.tsx";

const VERSION = "v0.1.8";
const ACCENT = "#3b82f6";

// ── Atoms ───────────────────────────────────────────────────────────────────

function Check({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ArrowRight({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function DownloadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function GitHubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
    </svg>
  );
}

function Btn({
  variant = "default",
  size = "md",
  href,
  children,
}: {
  variant?: "default" | "primary";
  size?: "md" | "lg";
  href?: string;
  children: ReactNode;
}) {
  const base =
    "inline-flex items-center gap-2 rounded-md font-medium border transition-colors active:scale-[0.97] active:transition-transform active:duration-75";
  const sizes = size === "lg"
    ? "px-[18px] py-[11px] text-[14px]"
    : "px-[14px] py-[7px] text-[13px]";
  const styles = variant === "primary"
    ? "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] border-[var(--color-accent)] text-white"
    : "bg-bg-panel-2 hover:bg-[#1f2229] border-border-default text-text-primary";
  return (
    <a href={href} className={`${base} ${sizes} ${styles}`}>
      {children}
    </a>
  );
}

function SectionEyebrow({ num, label }: { num: string; label: string }) {
  return (
    <div className="flex items-center gap-3 mb-[14px]">
      <span className="font-mono text-[11px] tracking-[0.14em] uppercase font-semibold text-accent">
        <span className="text-text-muted">{num}</span> {label}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[40px] leading-[1.1] tracking-[-0.025em] font-bold m-0 mb-[14px] max-w-[720px]">
      {children}
    </h2>
  );
}

function SectionLead({ children }: { children: ReactNode }) {
  return (
    <p className="text-[16px] leading-[1.6] text-text-secondary max-w-[640px] m-0 mb-[40px]">
      {children}
    </p>
  );
}

function MonoCode({ children, color = "#93c5fd" }: { children: ReactNode; color?: string }) {
  return (
    <code className="font-mono text-[13px]" style={{ color }}>
      {children}
    </code>
  );
}

// ── TopNav ──────────────────────────────────────────────────────────────────

function TopNav() {
  return (
    <nav
      className="sticky top-0 z-50 flex items-center gap-6 px-8 py-3 border-b border-border-subtle"
      style={{ backdropFilter: "blur(12px)", background: "rgb(14 15 18 / 0.78)" }}
    >
      <a href="#" className="flex items-center gap-[10px] font-bold tracking-[-0.01em] text-[15px]">
        <VaultbaseLogo size={22} />
        vaultbase
      </a>
      <div className="flex gap-1 ml-6">
        {["Features", "Compare", "Install", "Stack", "Docs"].map((l) => (
          <a
            key={l}
            href={`#${l.toLowerCase()}`}
            className="px-3 py-1.5 text-[13px] text-text-secondary hover:text-text-primary hover:bg-[#1f2229] rounded-md transition-colors"
          >
            {l}
          </a>
        ))}
      </div>
      <div className="ml-auto flex gap-2 items-center">
        <span className="font-mono text-[11px] text-text-muted">{VERSION} · MIT</span>
        <Btn href="https://github.com/vaultbase/vaultbase">
          <GitHubIcon size={14} />
          Star · 4.2k
        </Btn>
        <Btn variant="primary" href="#install">
          Download
        </Btn>
      </div>
    </nav>
  );
}

// ── Terminal ────────────────────────────────────────────────────────────────

function Terminal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className="bg-bg-code border border-border-default rounded-xl overflow-hidden"
      style={{ boxShadow: "0 30px 60px -20px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(255 255 255 / 0.02) inset" }}
    >
      <div className="flex items-center gap-2 px-[14px] py-[10px] border-b border-border-subtle bg-bg-panel">
        <div className="flex gap-1.5">
          <span className="w-[11px] h-[11px] rounded-full bg-border-strong" />
          <span className="w-[11px] h-[11px] rounded-full bg-border-strong" />
          <span className="w-[11px] h-[11px] rounded-full bg-border-strong" />
        </div>
        <span className="font-mono text-[11.5px] text-text-tertiary ml-2">{title}</span>
      </div>
      <div className="px-5 py-[18px] font-mono text-[13px] leading-[1.7]">{children}</div>
    </div>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden py-24">
      <div
        className="absolute left-1/2 -translate-x-1/2 -top-[50%] w-[1200px] h-[700px] pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, rgb(59 130 246 / 0.16), transparent 60%)",
        }}
      />
      <div className="relative max-w-[1200px] mx-auto px-8 grid grid-cols-[1.2fr_1fr] gap-12 items-center">
        <div>
          <span
            className="inline-flex items-center gap-2 px-3 py-[5px] border border-border-default rounded-full font-mono text-[11.5px] text-text-secondary mb-[22px]"
            style={{ background: "rgb(255 255 255 / 0.02)" }}
          >
            <span
              className="w-[6px] h-[6px] rounded-full"
              style={{
                background: "#22c55e",
                boxShadow: "0 0 0 3px rgb(34 197 94 / 0.18)",
              }}
            />
            {VERSION} · just shipped: queue workers + S3 presets
          </span>
          <h1 className="text-[64px] leading-[1.02] tracking-[-0.035em] font-bold m-0 mb-[22px]">
            A self-hosted backend in{" "}
            <span style={{ color: ACCENT }}>a single binary.</span>
          </h1>
          <p className="text-[18px] leading-[1.55] text-text-secondary max-w-[580px] m-0 mb-7">
            Collections, REST API, auth, realtime, file uploads, server-side
            hooks — all from one executable. Drop it on a server, run it, done.
          </p>
          <div className="flex gap-[10px] items-center mb-6">
            <Btn variant="primary" size="lg" href="#install">
              <DownloadIcon size={14} />
              Download {VERSION}
            </Btn>
            <Btn size="lg" href="#docs">
              Read the docs
              <ArrowRight size={14} />
            </Btn>
          </div>
          <div className="flex gap-[18px] font-mono text-[11.5px] text-text-tertiary">
            <span className="inline-flex items-center gap-1.5">
              <Check size={12} /> Linux · macOS · Windows
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check size={12} /> MIT licensed
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check size={12} /> Zero native deps
            </span>
          </div>
        </div>
        <Terminal title="~/projects/my-app">
          <span className="text-text-muted italic"># install, build, run — three commands</span>
          <br />
          <span className="text-accent select-none">$</span> bun install
          <br />
          <span className="text-accent select-none">$</span> bun run build           <span className="text-text-muted italic">→ ./vaultbase</span>
          <br />
          <span className="text-accent select-none">$</span> ./vaultbase
          <br />
          <br />
          <span style={{ color: "#4ade80" }}>✓</span> sqlite ready              <span className="text-text-muted italic">vaultbase.db</span>
          <br />
          <span style={{ color: "#4ade80" }}>✓</span> admin assets embedded     <span className="text-text-muted italic">12.4 MB</span>
          <br />
          <span style={{ color: "#4ade80" }}>✓</span> 4 hooks · 2 cron · 1 queue
          <br />
          <span style={{ color: "#4ade80" }}>✓</span> serving on{" "}
          <span style={{ color: "#60a5fa" }}>http://localhost:8091</span>
          <br />
          <br />
          <span className="text-text-muted italic"># open http://localhost:8091/_/  → setup wizard</span>
        </Terminal>
      </div>
    </section>
  );
}

// ── Why ─────────────────────────────────────────────────────────────────────

function WhyCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="relative overflow-hidden bg-bg-panel border border-border-subtle rounded-xl p-7">
      <div
        className="absolute left-0 top-0 right-0 h-0.5 opacity-60"
        style={{ background: "linear-gradient(90deg, var(--color-accent), transparent)" }}
      />
      <div
        className="w-[38px] h-[38px] rounded-lg flex items-center justify-center mb-4"
        style={{ background: "var(--color-accent-soft)", color: ACCENT }}
      >
        {icon}
      </div>
      <h3 className="text-[20px] font-semibold m-0 mb-2 tracking-[-0.01em]">{title}</h3>
      <p className="text-sm leading-[1.6] text-text-secondary m-0">{children}</p>
    </div>
  );
}

function WhySection() {
  return (
    <section id="why" className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="01" label="Why vaultbase" />
        <SectionTitle>Three things that aren't true of anything else.</SectionTitle>
        <SectionLead>
          Most "backend-as-a-service" products force a tradeoff: hosted
          convenience for vendor lock-in. vaultbase is the opposite end of the
          dial.
        </SectionLead>
        <div className="grid grid-cols-3 gap-3.5">
          <WhyCard
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
            }
            title="One binary."
          >
            Compiled with <MonoCode>bun build --compile</MonoCode>. Cross-compiles to Linux x64,
            macOS arm64/x64, Windows x64. Zero native deps shipped alongside —
            the executable is genuinely self-contained.
          </WhyCard>
          <WhyCard
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                <path d="M3 12a9 3 0 0 0 18 0" />
              </svg>
            }
            title="Real SQL, not JSON blobs."
          >
            Each collection is a real SQLite table — <MonoCode>vb_posts</MonoCode>,{" "}
            <MonoCode>vb_users</MonoCode>. Hit them with <MonoCode>sqlite3</MonoCode>, run native
            indexes, do real schema migrations. No JSON1 acrobatics.
          </WhyCard>
          <WhyCard
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
            }
            title="Edit logic in the browser."
          >
            Schema, API rules, hooks, custom HTTP routes, cron jobs, queue
            workers — all written in JavaScript directly in the admin UI, with
            Monaco autocomplete typed to your collection's actual record shape.
          </WhyCard>
        </div>
      </div>
    </section>
  );
}

// ── Replaces ────────────────────────────────────────────────────────────────

const STACK_BEFORE: Array<{ color: string; label: string; price: string }> = [
  { color: "#fbbf24", label: "Managed Postgres",       price: "$25/mo" },
  { color: "#a78bfa", label: "Auth0 / Clerk / Cognito", price: "$23/mo" },
  { color: "#fb923c", label: "S3 + signed URLs",        price: "$8/mo" },
  { color: "#2dd4bf", label: "Pusher / Ably",           price: "$49/mo" },
  { color: "#4ade80", label: "Inngest / Trigger.dev",   price: "$20/mo" },
  { color: "#60a5fa", label: "A backend framework host", price: "$15/mo" },
];

function ReplacesSection() {
  return (
    <section id="replaces" className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="02" label="What it replaces" />
        <SectionTitle>
          A typical small-app stack runs <span style={{ color: ACCENT }}>$80–$300/month.</span>{" "}
          Now it runs on a $5 VPS.
        </SectionTitle>
        <SectionLead>
          For the kind of project where you spend a weekend wiring five managed
          services together, vaultbase is one process on one box.
        </SectionLead>
        <div className="bg-bg-panel border border-border-subtle rounded-xl p-9 grid grid-cols-[1fr_auto_1fr] gap-9 items-center">
          <div>
            <h4 className="font-mono text-[11px] tracking-[0.1em] uppercase text-text-tertiary font-semibold m-0 mb-3.5">
              Before · 5+ services
            </h4>
            {STACK_BEFORE.map((s) => (
              <div
                key={s.label}
                className="flex items-center gap-2.5 px-3 py-2 bg-bg-input border border-border-subtle rounded-md mb-1.5 text-[13px]"
              >
                <span style={{ color: s.color }}>●</span>
                <span className="line-through text-text-tertiary">{s.label}</span>
                <span className="ml-auto font-mono text-[11.5px] text-text-muted">{s.price}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col items-center justify-center gap-1" style={{ color: ACCENT }}>
            <span className="font-mono text-[28px]">→</span>
            <span className="font-mono text-[10.5px] tracking-[0.1em] text-text-tertiary">BECOMES</span>
          </div>
          <div>
            <h4 className="font-mono text-[11px] tracking-[0.1em] uppercase text-text-tertiary font-semibold m-0 mb-3.5">
              After · 1 binary
            </h4>
            <div
              className="rounded-lg p-3.5 flex items-center gap-3"
              style={{
                background:
                  "linear-gradient(180deg, rgb(59 130 246 / 0.10), rgb(59 130 246 / 0.02))",
                border: "1px solid rgb(59 130 246 / 0.3)",
              }}
            >
              <VaultbaseLogo size={30} />
              <div>
                <div className="font-semibold text-[15px]">./vaultbase</div>
                <div className="font-mono text-[11.5px] text-text-tertiary">
                  SQLite · Auth · Files · Realtime · Hooks · Queue
                </div>
              </div>
            </div>
            <div
              className="mt-3.5 px-3.5 py-3 rounded-md text-[12.5px] text-text-secondary font-mono"
              style={{
                background: "rgb(34 197 94 / 0.05)",
                border: "1px solid rgb(34 197 94 / 0.2)",
              }}
            >
              <span style={{ color: "#4ade80" }}>$5/mo VPS</span> · one process · one port · one
              file you can <MonoCode>scp</MonoCode> as a backup
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Pillars ─────────────────────────────────────────────────────────────────

interface PillarSpec {
  iconBg: string;
  iconColor: string;
  icon: ReactNode;
  title: string;
  stat: string;
  body: string;
  bullets: string[];
}

const PILLARS: PillarSpec[] = [
  {
    iconBg: "rgb(96 165 250 / 0.12)",
    iconColor: "#60a5fa",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14a9 3 0 0 0 18 0V5" />
        <path d="M3 12a9 3 0 0 0 18 0" />
      </svg>
    ),
    title: "Collections + REST API",
    stat: "14 field types · 3 collection kinds",
    body: "Real SQL tables, typed fields with validation, REST with filter / sort / expand / projection, ALTER TABLE-style schema diffs when you edit fields.",
    bullets: ["text · number · bool · email", "relation · select · json · file", "password · editor · geoPoint", "base · auth · view collections"],
  },
  {
    iconBg: "rgb(167 139 250 / 0.12)",
    iconColor: "#a78bfa",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="15" r="4" />
        <path d="m10.85 12.15 7.65-7.65" />
        <path d="m18 5 3 3" />
      </svg>
    ),
    title: "Auth, fully featured",
    stat: "13 OAuth2 providers",
    body: "Email + password, OAuth2 with Google / GitHub / Discord / 10 more, OTP / magic-link, MFA / TOTP, anonymous sessions, admin impersonation.",
    bullets: ["JWT, configurable expiry", "Recovery codes", "No account-enumeration leaks", "Multi-admin out of the box"],
  },
  {
    iconBg: "rgb(45 212 191 / 0.12)",
    iconColor: "#2dd4bf",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
    title: "Realtime",
    stat: "WebSocket + SSE",
    body: "WebSocket endpoint with topic subscriptions — collection, record, child records, or * for everything. SSE fallback. Per-connection auth respects API rules.",
    bullets: ["Subscribe to a record", "Subscribe to children", "Wildcard topics", "Auth-gated streams"],
  },
  {
    iconBg: "rgb(251 146 60 / 0.12)",
    iconColor: "#fb923c",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    ),
    title: "Files",
    stat: "Local · S3 · R2",
    body: "Local FS by default. One-click S3 / R2 presets via Bun's native client. On-the-fly thumbnails, signed protected URLs, MIME + size validation.",
    bullets: ["?thumb=300x200", "1-hour signed tokens", "Multi-file fields", "Round-trip test button"],
  },
  {
    iconBg: "rgb(192 132 252 / 0.12)",
    iconColor: "#c084fc",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
    title: "Server-side logic, in the browser",
    stat: "Hooks · Routes · Cron · Queues",
    body: "Six hook points (before/after × CRUD), custom HTTP routes, UTC cron with run-now, queue workers with retry budgets and dead-letter trails. All with typed Monaco autocomplete.",
    bullets: ["Edit live, no redeploy", "helpers.enqueue(queue, payload)", "cronstrue + crontab.guru", "Audited dead-letter retries"],
  },
  {
    iconBg: "rgb(34 197 94 / 0.12)",
    iconColor: "#4ade80",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    title: "Operations",
    stat: "Logs · Rate limits · Snapshots",
    body: "Request log viewer with rule-eval inspection (which API rule allowed/denied each request and why). Per-rule rate limiting. SQLite snapshot download. AES-GCM encryption at rest.",
    bullets: ["JSONPath log search", "Per-IP token buckets", "One-click backup", "JSON migration snapshots"],
  },
];

function PillarsSection() {
  return (
    <section id="features" className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="03" label="What's in the box" />
        <SectionTitle>Six pillars. All in the binary.</SectionTitle>
        <SectionLead>No add-ons, no plugins, no "Pro tier". Everything below ships in {VERSION}.</SectionLead>
        <div className="grid grid-cols-2 gap-3.5">
          {PILLARS.map((p) => (
            <div
              key={p.title}
              className="flex flex-col gap-3 bg-bg-panel border border-border-subtle rounded-xl p-[26px]"
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-md flex items-center justify-center"
                  style={{ background: p.iconBg, color: p.iconColor }}
                >
                  {p.icon}
                </div>
                <h3 className="text-[18px] font-semibold m-0 tracking-[-0.01em]">{p.title}</h3>
                <span className="ml-auto font-mono text-[11px] text-text-tertiary px-2 py-0.5 border border-border-default rounded-full">
                  {p.stat}
                </span>
              </div>
              <p className="text-[13.5px] leading-[1.6] text-text-secondary m-0">{p.body}</p>
              <ul className="m-0 p-0 grid grid-cols-2 gap-x-4 gap-y-1 list-none">
                {p.bullets.map((b) => (
                  <li
                    key={b}
                    className="font-mono text-[12.5px] text-text-tertiary flex items-center gap-1.5"
                  >
                    <span className="w-1 h-1 rounded-full bg-accent flex-shrink-0" />
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Admin preview ───────────────────────────────────────────────────────────

const ADMIN_ROWS: Array<{
  selected?: boolean;
  name: string;
  type: keyof typeof TYPE_COLORS;
  meta: string;
  flag?: { color: string; label: string };
}> = [
  { selected: true, name: "title",  type: "text",     meta: "min 3, max 120",                flag: { color: "#fbbf24", label: "● req" } },
  {                 name: "slug",   type: "text",     meta: "unique · ^[a-z0-9-]+$",          flag: { color: "#a78bfa", label: "● uniq" } },
  {                 name: "author", type: "relation", meta: "→ users · single",               flag: { color: "#fbbf24", label: "● req" } },
  {                 name: "status", type: "select",   meta: "draft / published / archived" },
  {                 name: "cover",  type: "file",     meta: "image/* · max 5MB · thumb=300x200" },
];

const TYPE_COLORS = {
  text:     "var(--color-type-text)",
  relation: "var(--color-type-relation)",
  select:   "var(--color-type-select)",
  file:     "var(--color-type-file)",
} as const;

function AdminPreviewSection() {
  return (
    <section id="admin" className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="04" label="The admin UI" />
        <SectionTitle>Schema, rules, and logic — all editable in the browser.</SectionTitle>
        <SectionLead>
          No CLI dance, no migrations folder, no redeploy. Edit a hook, save, the next request runs the new code.
        </SectionLead>
        <div
          className="bg-bg-panel border border-border-default rounded-xl overflow-hidden grid min-h-[360px]"
          style={{
            gridTemplateColumns: "200px 1fr 280px",
            boxShadow: "0 30px 60px -20px rgb(0 0 0 / 0.6)",
          }}
        >
          {/* sidebar */}
          <div className="bg-bg-sidebar border-r border-border-subtle px-3 py-3.5">
            <div className="font-mono text-[9.5px] tracking-[0.12em] text-text-muted px-2 pb-1.5 uppercase">DATA</div>
            {[
              { active: true, label: "Collections", icon: <RectIcon /> },
              { label: "Logs", icon: <LogsIcon /> },
              { label: "API preview", icon: <PlayIcon /> },
            ].map((it) => (
              <div
                key={it.label}
                className={`flex items-center gap-2 px-2.5 py-[5px] text-[12px] rounded-md mb-0.5 ${
                  it.active
                    ? "text-text-primary border-l-2 pl-2"
                    : "text-text-secondary"
                }`}
                style={
                  it.active
                    ? { background: "var(--color-accent-soft)", borderLeftColor: ACCENT }
                    : {}
                }
              >
                {it.icon}
                {it.label}
              </div>
            ))}
            <div className="font-mono text-[9.5px] tracking-[0.12em] text-text-muted px-2 pb-1.5 mt-3.5 uppercase">LOGIC</div>
            {[
              { label: "Hooks · 4", icon: <CodeIcon /> },
              { label: "Cron · 2", icon: <ClockIcon /> },
              { label: "Queues · 1", icon: <ZapIcon /> },
            ].map((it) => (
              <div key={it.label} className="flex items-center gap-2 px-2.5 py-[5px] text-[12px] text-text-secondary rounded-md mb-0.5">
                {it.icon}
                {it.label}
              </div>
            ))}
          </div>
          {/* main */}
          <div className="p-4">
            <div className="flex items-center gap-2.5 px-2.5 mb-3 pb-3 border-b border-border-subtle">
              <div
                className="w-[22px] h-[22px] rounded-md text-white font-bold text-[11px] font-mono flex items-center justify-center"
                style={{ background: "linear-gradient(135deg,#ef4444,#b91c1c)" }}
              >
                P
              </div>
              <div>
                <div className="text-[13px] font-semibold">posts</div>
                <div className="text-[10.5px] text-text-tertiary font-mono">12 fields · 3 indexes</div>
              </div>
            </div>
            {ADMIN_ROWS.map((r) => (
              <div
                key={r.name}
                className="flex items-center gap-2.5 px-2.5 py-2 text-[12px] rounded-md"
                style={
                  r.selected
                    ? {
                        background: "rgb(59 130 246 / 0.08)",
                        borderLeft: `2px solid ${ACCENT}`,
                        paddingLeft: 8,
                      }
                    : {}
                }
              >
                <span
                  className="font-mono font-medium min-w-[90px]"
                  style={r.selected ? { color: "#93c5fd" } : {}}
                >
                  {r.name}
                </span>
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[10px] border border-border-default"
                  style={{ color: TYPE_COLORS[r.type], background: "rgb(255 255 255 / 0.04)" }}
                >
                  <span
                    className="w-1 h-1 rounded-full"
                    style={{ background: TYPE_COLORS[r.type] }}
                  />
                  <span style={{ fontFamily: "var(--font-mono)" }}>{r.type}</span>
                </span>
                <span className="font-mono text-[11px] text-text-tertiary flex-1">{r.meta}</span>
                {r.flag && (
                  <span className="text-[10.5px] font-mono" style={{ color: r.flag.color }}>
                    {r.flag.label}
                  </span>
                )}
              </div>
            ))}
          </div>
          {/* right rail */}
          <div className="border-l border-border-subtle p-4 bg-bg-app">
            <div className="font-mono text-[10px] tracking-[0.1em] text-text-tertiary uppercase mb-2.5">
              FIELD OPTIONS · text
            </div>
            <div className="font-mono text-[11px] text-text-muted mb-1">NAME</div>
            <div className="bg-bg-input border border-border-subtle rounded-md px-2.5 py-1.5 font-mono text-[12px] mb-3">
              title
            </div>
            <div className="font-mono text-[11px] text-text-muted mb-1">VALIDATION</div>
            <div className="grid grid-cols-2 gap-1.5 mb-2.5">
              <div className="bg-bg-input border border-border-subtle rounded-md px-2.5 py-1.5 font-mono text-[12px]">3</div>
              <div className="bg-bg-input border border-border-subtle rounded-md px-2.5 py-1.5 font-mono text-[12px]">120</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 px-2.5 py-[7px] bg-bg-input border border-border-subtle rounded-md">
                <span className="text-[12px] flex-1">Required</span>
                <ToggleDot on />
              </div>
              <div className="flex items-center gap-2 px-2.5 py-[7px] bg-bg-input border border-border-subtle rounded-md">
                <span className="text-[12px] flex-1">Encrypted</span>
                <ToggleDot />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ToggleDot({ on }: { on?: boolean }) {
  return (
    <span
      className="relative inline-block w-[26px] h-[14px] rounded-full"
      style={{ background: on ? ACCENT : "var(--color-border-default)" }}
    >
      <span
        className="absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all"
        style={{ left: on ? 13 : 2, background: on ? "#fff" : "#d8d9de" }}
      />
    </span>
  );
}

function RectIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
    </svg>
  );
}
function LogsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l7 5Z" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}
function CodeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function ZapIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

// ── Compare ─────────────────────────────────────────────────────────────────

interface CompareRow {
  label: string;
  cells: [string, string, string, string]; // vaultbase / pocketbase / supabase / firebase
  tones: [Tone, Tone, Tone, Tone];
}
type Tone = "yes" | "no" | "meh";

const COMPARE_ROWS: CompareRow[] = [
  { label: "Single binary, self-hosted",            cells: ["yes", "yes", "no", "no"],                                        tones: ["yes", "yes", "no", "no"] },
  { label: "Real SQL tables (not JSON blobs)",      cells: ["yes", "partial", "yes (Postgres)", "no (Firestore)"],            tones: ["yes", "meh", "yes", "no"] },
  { label: "Server-side logic editable in browser", cells: ["yes", "JSVM, limited", "Edge Fns, deploy", "deploy only"],       tones: ["yes", "meh", "meh", "no"] },
  { label: "Built-in queue workers + cron",         cells: ["yes", "no", "cron only", "cron only"],                            tones: ["yes", "no", "meh", "meh"] },
  { label: "Realtime (WebSocket + SSE)",            cells: ["yes", "yes", "yes", "yes"],                                       tones: ["yes", "yes", "yes", "yes"] },
  { label: "Open source, MIT",                      cells: ["yes", "yes", "Apache + open core", "closed"],                    tones: ["yes", "yes", "meh", "no"] },
  { label: "Globally distributed multi-region",     cells: ["no (single host)", "no", "yes", "yes"],                          tones: ["no", "no", "yes", "yes"] },
  { label: "Free for self-host",                    cells: ["yes", "yes", "yes", "no"],                                        tones: ["yes", "yes", "yes", "no"] },
];

function toneClass(t: Tone): string {
  if (t === "yes") return "text-[#4ade80]";
  if (t === "no") return "text-[#ff7b7b]";
  return "text-[#fbbf24]";
}

function CompareSection() {
  return (
    <section id="compare" className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="05" label="Comparison" />
        <SectionTitle>How vaultbase compares.</SectionTitle>
        <SectionLead>
          Honest table. We're a single-binary open-source backend for solo devs and small teams — not a globally distributed multi-region platform.
        </SectionLead>
        <div className="bg-bg-panel border border-border-subtle rounded-xl overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left px-[18px] py-[14px] text-[11px] font-mono uppercase tracking-[0.06em] text-text-tertiary font-semibold border-b border-border-subtle" style={{ width: "32%", background: "rgb(255 255 255 / 0.015)" }}>&nbsp;</th>
                <th className="text-left px-[18px] py-[14px] text-[11px] font-mono uppercase tracking-[0.06em] font-semibold border-b border-border-subtle" style={{ color: ACCENT, background: "rgb(59 130 246 / 0.06)" }}>vaultbase</th>
                <th className="text-left px-[18px] py-[14px] text-[11px] font-mono uppercase tracking-[0.06em] text-text-tertiary font-semibold border-b border-border-subtle" style={{ background: "rgb(255 255 255 / 0.015)" }}>PocketBase</th>
                <th className="text-left px-[18px] py-[14px] text-[11px] font-mono uppercase tracking-[0.06em] text-text-tertiary font-semibold border-b border-border-subtle" style={{ background: "rgb(255 255 255 / 0.015)" }}>Supabase</th>
                <th className="text-left px-[18px] py-[14px] text-[11px] font-mono uppercase tracking-[0.06em] text-text-tertiary font-semibold border-b border-border-subtle" style={{ background: "rgb(255 255 255 / 0.015)" }}>Firebase</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row, i) => (
                <tr key={row.label}>
                  <td className="px-[18px] py-[14px] text-[13.5px] text-text-secondary border-b border-border-subtle align-middle" style={i === COMPARE_ROWS.length - 1 ? { borderBottom: 0 } : {}}>{row.label}</td>
                  <td className="px-[18px] py-[14px] text-[13.5px] text-text-primary font-medium border-b border-border-subtle align-middle" style={{ background: "rgb(59 130 246 / 0.04)", ...(i === COMPARE_ROWS.length - 1 ? { borderBottom: 0 } : {}) }}>
                    <span className={toneClass(row.tones[0])}>● {row.cells[0]}</span>
                  </td>
                  <td className="px-[18px] py-[14px] text-[13.5px] border-b border-border-subtle align-middle" style={i === COMPARE_ROWS.length - 1 ? { borderBottom: 0 } : {}}>
                    <span className={toneClass(row.tones[1])}>● {row.cells[1]}</span>
                  </td>
                  <td className="px-[18px] py-[14px] text-[13.5px] border-b border-border-subtle align-middle" style={i === COMPARE_ROWS.length - 1 ? { borderBottom: 0 } : {}}>
                    <span className={toneClass(row.tones[2])}>● {row.cells[2]}</span>
                  </td>
                  <td className="px-[18px] py-[14px] text-[13.5px] border-b border-border-subtle align-middle" style={i === COMPARE_ROWS.length - 1 ? { borderBottom: 0 } : {}}>
                    <span className={toneClass(row.tones[3])}>● {row.cells[3]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ── Install ─────────────────────────────────────────────────────────────────

function InstallSection() {
  return (
    <section id="install" className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="06" label="Install" />
        <SectionTitle>Three commands. <span style={{ color: ACCENT }}>No setup.</span></SectionTitle>
        <SectionLead>The first run launches a setup wizard that creates the first admin account.</SectionLead>
        <div className="grid grid-cols-2 gap-3.5">
          <Terminal title="install · build · run">
            <span className="text-accent select-none">$</span> bun install<br />
            <span className="text-accent select-none">$</span> bun run build           <span className="text-text-muted italic">→ ./vaultbase</span><br />
            <span className="text-accent select-none">$</span> ./vaultbase             <span className="text-text-muted italic">→ :8091</span><br />
            <br />
            <span className="text-text-muted italic"># http://localhost:8091/_/  → setup wizard</span>
          </Terminal>
          <Terminal title="cross-compile">
            <span className="text-accent select-none">$</span> bun run build:linux-x64<br />
            <span className="text-accent select-none">$</span> bun run build:macos-arm64<br />
            <span className="text-accent select-none">$</span> bun run build:windows-x64<br />
            <span className="text-text-muted italic"># or all five</span><br />
            <span className="text-accent select-none">$</span> bun run build:all<br />
            <br />
            <span className="text-text-muted italic"># → releases/vaultbase-&lt;target&gt;[.exe]</span>
          </Terminal>
        </div>
      </div>
    </section>
  );
}

// ── Architecture ────────────────────────────────────────────────────────────

const MODULES = ["elysia", "drizzle", "bun:sqlite", "react admin", "queue engine", "oauth2", "jwt", "aes-gcm"];

function ArchitectureSection() {
  return (
    <section className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="07" label="Architecture" />
        <SectionTitle>One process. Files on disk.</SectionTitle>
        <SectionLead>
          There is no second asset server, no native module, no companion daemon. Your data is files you can <MonoCode>scp</MonoCode>.
        </SectionLead>
        <div
          className="bg-bg-panel border border-border-subtle rounded-xl p-9 relative"
          style={{
            backgroundImage:
              "linear-gradient(rgb(59 130 246 / 0.04) 1px, transparent 1px), linear-gradient(90deg, rgb(59 130 246 / 0.04) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        >
          <div className="grid items-center gap-9" style={{ gridTemplateColumns: "200px 1fr 200px" }}>
            <div className="flex flex-col gap-2.5">
              <div className="font-mono text-[10.5px] tracking-[0.1em] uppercase text-text-muted mb-1 font-semibold">Inbound</div>
              {["HTTP · :8091", "WebSocket · /realtime", "Admin UI · /_/"].map((p) => (
                <ArchPill key={p}>{p}</ArchPill>
              ))}
            </div>
            <div
              className="rounded-2xl p-7 text-center"
              style={{
                background: "linear-gradient(180deg, rgb(59 130 246 / 0.14), rgb(59 130 246 / 0.04))",
                border: "1px solid rgb(59 130 246 / 0.4)",
                boxShadow: "0 0 60px -10px rgb(59 130 246 / 0.4)",
              }}
            >
              <div className="flex justify-center"><VaultbaseLogo size={60} /></div>
              <div className="text-[22px] font-bold mt-3.5 mb-1.5">./vaultbase</div>
              <div className="font-mono text-[11.5px] text-text-tertiary mb-4">one process · ~38 MB</div>
              <div className="flex flex-wrap gap-1 justify-center">
                {MODULES.map((m) => (
                  <span
                    key={m}
                    className="font-mono text-[10.5px] px-2.5 py-[3px] rounded-full border border-border-subtle text-text-secondary"
                    style={{ background: "rgb(255 255 255 / 0.04)" }}
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="font-mono text-[10.5px] tracking-[0.1em] uppercase text-text-muted mb-1 font-semibold">On disk</div>
              {["vaultbase.db", "uploads/", "logs/*.jsonl"].map((p) => (
                <ArchPill key={p}>{p}</ArchPill>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ArchPill({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-md bg-bg-input border border-border-subtle font-mono text-[12px] text-text-secondary">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: ACCENT }} />
      {children}
    </div>
  );
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const NUMBERS: Array<{ n: string; l: string }> = [
  { n: "1",    l: "binary, self-contained" },
  { n: "14",   l: "field types" },
  { n: "13",   l: "OAuth2 providers" },
  { n: "6",    l: "record-event hook points" },
  { n: "3",    l: "collection kinds" },
  { n: "400+", l: "server-side tests" },
];

function NumbersSection() {
  return (
    <section className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="08" label="Numbers" />
        <SectionTitle>Specifics, not slogans.</SectionTitle>
        <div className="grid grid-cols-6 gap-3 mt-3">
          {NUMBERS.map((x) => (
            <div key={x.l} className="bg-bg-panel border border-border-subtle rounded-lg px-5 py-[22px]">
              <div className="text-[36px] font-bold tracking-[-0.03em] leading-none mb-2" style={{ color: ACCENT }}>{x.n}</div>
              <div className="text-[12px] text-text-secondary leading-[1.4]">{x.l}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Stack + Out of scope ────────────────────────────────────────────────────

const STACK_TAGS: Array<{ k: string; v: string }> = [
  { k: "Runtime", v: "Bun" },
  { k: "HTTP", v: "Elysia" },
  { k: "DB", v: "SQLite via bun:sqlite" },
  { k: "ORM", v: "Drizzle" },
  { k: "Admin", v: "React 19 + Vite" },
  { k: "Routing", v: "React Router v7" },
  { k: "State", v: "Zustand" },
  { k: "Editor", v: "Monaco" },
  { k: "Build", v: "bun --compile" },
];

function StackSection() {
  return (
    <section id="stack" className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <SectionEyebrow num="09" label="Stack & scope" />
        <SectionTitle>TypeScript end-to-end.</SectionTitle>
        <SectionLead>No native binaries shipped alongside the executable. The whole thing is one self-contained build.</SectionLead>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-bg-panel border border-border-subtle rounded-xl p-[26px]">
            <h3 className="m-0 mb-3.5 text-[15px] font-semibold">The stack</h3>
            <div className="flex flex-wrap gap-2 mt-3">
              {STACK_TAGS.map((t) => (
                <span
                  key={t.k}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-bg-panel border border-border-subtle font-mono text-[12px] text-text-secondary"
                >
                  <b className="text-text-primary font-medium">{t.k}</b> {t.v}
                </span>
              ))}
            </div>
          </div>
          <div
            className="rounded-xl px-7 py-6"
            style={{
              background: "rgb(245 158 11 / 0.05)",
              border: "1px solid rgb(245 158 11 / 0.2)",
            }}
          >
            <h4 className="text-[14px] m-0 mb-3 font-semibold" style={{ color: "#fbbf24" }}>
              Not in scope for v1.0
            </h4>
            <ul className="m-0 pl-5 list-disc leading-[1.8] text-[13.5px] text-text-secondary">
              <li>Multi-region — single process on a single host</li>
              <li>Horizontal scale — Phase 2 (Redis-backed queues + cache) is on the roadmap</li>
              <li>A managed service — there is no <span className="font-mono" style={{ color: "#fbbf24" }}>vaultbase.cloud</span></li>
              <li>Apps with 100k+ concurrent connections</li>
            </ul>
            <p className="mt-3 mb-0 text-[13px] text-text-tertiary">
              If you have a dedicated platform team and run your own Postgres + Redis + S3 stack, vaultbase isn't for you. That's by design.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Final CTA ───────────────────────────────────────────────────────────────

function FinalCTA() {
  return (
    <section className="py-22">
      <div className="max-w-[1200px] mx-auto px-8">
        <div
          className="rounded-2xl p-14 text-center relative overflow-hidden"
          style={{
            background: "linear-gradient(180deg, rgb(59 130 246 / 0.10), transparent)",
            border: "1px solid rgb(59 130 246 / 0.25)",
          }}
        >
          <h2 className="text-[44px] leading-[1.1] tracking-[-0.025em] m-0 mb-3.5 font-bold">
            One binary. Five minutes.<br />
            <span style={{ color: ACCENT }}>Your backend.</span>
          </h2>
          <p className="text-[16px] text-text-secondary m-0 mb-7 max-w-[520px] mx-auto">
            Download {VERSION}, run <MonoCode>./vaultbase</MonoCode>, walk away with your data
            whenever you want.
          </p>
          <div className="flex gap-2.5 justify-center">
            <Btn variant="primary" size="lg" href="#">
              <DownloadIcon size={14} /> Download {VERSION}
            </Btn>
            <Btn size="lg" href="#">
              <GitHubIcon size={14} /> GitHub
            </Btn>
            <Btn size="lg" href="#">Read the docs</Btn>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Footer ──────────────────────────────────────────────────────────────────

function FooterBar() {
  return (
    <footer className="border-t border-border-subtle">
      <div className="max-w-[1200px] mx-auto px-8 py-8 flex items-center gap-4">
        <VaultbaseLogo size={20} />
        <span className="font-mono text-[11.5px] text-text-muted flex-1">
          vaultbase {VERSION} · MIT · github.com/vaultbase/vaultbase
        </span>
        <div className="flex gap-[18px] text-[12.5px] text-text-tertiary">
          {["Docs", "GitHub", "Releases", "Discord"].map((l) => (
            <a key={l} href="#" className="hover:text-text-primary transition-colors">
              {l}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <div className="min-h-screen">
      <TopNav />
      <Hero />
      <WhySection />
      <ReplacesSection />
      <PillarsSection />
      <AdminPreviewSection />
      <CompareSection />
      <InstallSection />
      <ArchitectureSection />
      <NumbersSection />
      <StackSection />
      <FinalCTA />
      <FooterBar />
    </div>
  );
}
