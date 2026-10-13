import nodemailer, { type Transporter } from "nodemailer";
import { getAllSettings } from "../api/settings.ts";

/**
 * Outgoing email. A transport delivers a message; SMTP (nodemailer) is the
 * built-in one and extensions add more with `registerEmailTransport()`. The
 * `email.transport` setting picks the active transport (default "smtp").
 * The From address is the `smtp.from` setting for every transport.
 */

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Rich variant — supports cc/bcc/replyTo, custom from override, and
 * attachments. Backs `helpers.mails.send` for hooks.
 */
export interface RichEmailOptions extends EmailOptions {
  cc?: string;
  bcc?: string;
  replyTo?: string;
  from?: string;
  attachments?: Array<{
    filename: string;
    content: string | Uint8Array;
    contentType?: string;
  }>;
}

/** What a transport is asked to deliver: `from` is always filled in. */
export interface EmailMessage extends RichEmailOptions {
  from: string;
}

export interface EmailTransportDef {
  name: string;
  /** Whether settings hold what this transport needs to send. */
  isConfigured(settings: Record<string, string>): boolean;
  send(message: EmailMessage, settings: Record<string, string>): Promise<{ messageId: string }>;
  /** Check the connection or credentials without sending. Throws on failure. */
  verify?(settings: Record<string, string>): Promise<void>;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email is not configured. Set up SMTP (host, port, from) or another transport in Settings.");
  }
}

let cached: { config: SmtpConfig; transporter: Transporter; expires: number } | null = null;
const TTL_MS = 30_000;

/** Connect / greeting timeout for SMTP; the socket gets twice this. */
export const SMTP_TIMEOUT_MS = 15_000;

export function invalidateEmailCache(): void {
  cached = null;
}

function readSmtpConfig(s: Record<string, string>): SmtpConfig {
  const port = parseInt(s["smtp.port"] ?? "587");
  return {
    enabled: s["smtp.enabled"] === "1" || s["smtp.enabled"] === "true",
    host: s["smtp.host"] ?? "",
    port: Number.isFinite(port) ? port : 587,
    secure: s["smtp.secure"] === "1" || s["smtp.secure"] === "true",
    user: s["smtp.user"] ?? "",
    pass: s["smtp.pass"] ?? "",
    from: s["smtp.from"] ?? "",
  };
}

function smtpTransporter(s: Record<string, string>): Transporter {
  const now = Date.now();
  if (cached && cached.expires > now) return cached.transporter;
  const config = readSmtpConfig(s);
  if (!config.enabled || !config.host || !config.from) throw new EmailNotConfiguredError();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    // nodemailer's defaults (2 min connect, 10 min idle socket) can hold a
    // request open for minutes when the SMTP server hangs.
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS * 2,
  });
  cached = { config, transporter, expires: now + TTL_MS };
  return transporter;
}

const smtpTransport: EmailTransportDef = {
  name: "smtp",
  isConfigured: (s) => {
    const c = readSmtpConfig(s);
    return c.enabled && c.host !== "" && c.from !== "";
  },
  async send(m, s) {
    const sendOpts: Parameters<Transporter["sendMail"]>[0] = { from: m.from, to: m.to, subject: m.subject };
    if (m.cc) sendOpts.cc = m.cc;
    if (m.bcc) sendOpts.bcc = m.bcc;
    if (m.replyTo) sendOpts.replyTo = m.replyTo;
    if (m.text) sendOpts.text = m.text;
    if (m.html) sendOpts.html = m.html;
    if (m.attachments?.length) {
      sendOpts.attachments = m.attachments.map((a) => {
        const att: { filename: string; content: string | Buffer; contentType?: string } = {
          filename: a.filename,
          content: a.content instanceof Uint8Array ? Buffer.from(a.content) : a.content,
        };
        if (a.contentType) att.contentType = a.contentType;
        return att;
      });
    }
    const info = await smtpTransporter(s).sendMail(sendOpts);
    return { messageId: info.messageId };
  },
  async verify(s) {
    await smtpTransporter(s).verify();
  },
};

const transports = new Map<string, EmailTransportDef>([["smtp", smtpTransport]]);
const TRANSPORT_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** Add an email transport; select it by setting `email.transport` to its name. */
export function registerEmailTransport(def: EmailTransportDef): () => void {
  if (!TRANSPORT_NAME_RE.test(def.name)) {
    throw new Error(`invalid email transport name '${def.name}' (lowercase letters, digits, - and _)`);
  }
  if (transports.has(def.name)) throw new Error(`email transport '${def.name}' is already registered`);
  transports.set(def.name, def);
  return () => {
    if (transports.get(def.name) === def) transports.delete(def.name);
  };
}

export function listEmailTransports(): Array<{ name: string; builtin: boolean }> {
  return [...transports.keys()].map((name) => ({ name, builtin: name === "smtp" }));
}

function activeTransport(s: Record<string, string>): EmailTransportDef | undefined {
  return transports.get(s["email.transport"] || "smtp");
}

/** Whether email can be sent: the active transport is registered and configured. */
export function isEmailConfigured(): boolean {
  const s = getAllSettings();
  const t = activeTransport(s);
  return !!t && t.isConfigured(s) && (s["smtp.from"] ?? "") !== "";
}

/** Kept for existing callers: true when any email can be sent, SMTP or not. */
export const isSmtpConfigured = isEmailConfigured;

function transportOrThrow(s: Record<string, string>): EmailTransportDef {
  const t = activeTransport(s);
  if (!t || !t.isConfigured(s) || !(s["smtp.from"] ?? "")) throw new EmailNotConfiguredError();
  return t;
}

export async function sendEmail(opts: EmailOptions): Promise<{ messageId: string }> {
  if (!opts.text && !opts.html) {
    throw new Error("Email must include `text` or `html`");
  }
  return sendMailRich(opts);
}

export async function sendMailRich(opts: RichEmailOptions): Promise<{ messageId: string }> {
  const s = getAllSettings();
  const t = transportOrThrow(s);
  return t.send({ ...opts, from: opts.from ?? s["smtp.from"]! }, s);
}

export async function verifySmtp(): Promise<{ ok: boolean; error?: string }> {
  try {
    const s = getAllSettings();
    const t = transportOrThrow(s);
    await t.verify?.(s);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

export interface EmailTemplate {
  subject: string;
  body: string;
}

export const DEFAULT_TEMPLATES = {
  verify: {
    subject: "Verify your email",
    body:
      "Hi,\n\n" +
      "Click the link below to verify your email address for {{appUrl}}:\n\n" +
      "{{link}}\n\n" +
      "This link expires in 1 hour. If you didn't request this, you can ignore this email.\n",
  },
  reset: {
    subject: "Reset your password",
    body:
      "Hi,\n\n" +
      "We received a request to reset the password for your {{appUrl}} account.\n" +
      "Click the link below to choose a new password:\n\n" +
      "{{link}}\n\n" +
      "This link expires in 1 hour. If you didn't request this, you can ignore this email.\n",
  },
  email_change: {
    subject: "Confirm your new email address",
    body:
      "Hi,\n\n" +
      "You asked to change the email address of your {{appUrl}} account to {{email}}.\n" +
      "Click the link below to confirm:\n\n" +
      "{{link}}\n\n" +
      "This link expires in 1 hour. If you didn't request this, you can ignore this email.\n",
  },
  invite: {
    subject: "You're invited",
    body:
      "Hi,\n\n" +
      "You've been invited to {{appUrl}}. Click the link below to choose a password and finish setting up your account:\n\n" +
      "{{link}}\n\n" +
      "This link expires in 7 days.\n",
  },
  otp: {
    subject: "Your sign-in code",
    body:
      "Hi,\n\n" +
      "Use this code to sign in to {{appUrl}}:\n\n" +
      "    {{code}}\n\n" +
      "Or click the link below:\n\n" +
      "{{link}}\n\n" +
      "Both expire in 10 minutes. If you didn't request this, you can ignore this email.\n",
  },
} as const;

export function getAppUrl(): string {
  return getAllSettings()["app.url"] ?? "";
}

export type TemplateKind = keyof typeof DEFAULT_TEMPLATES;

export function getTemplate(kind: TemplateKind): EmailTemplate {
  const s = getAllSettings();
  const subjectKey = `email.${kind}.subject`;
  const bodyKey = `email.${kind}.body`;
  return {
    subject: s[subjectKey]?.trim() || DEFAULT_TEMPLATES[kind].subject,
    body: s[bodyKey]?.trim() || DEFAULT_TEMPLATES[kind].body,
  };
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}
