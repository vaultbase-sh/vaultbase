import nodemailer, { type Transporter } from "nodemailer";
import { getAllSettings } from "../api/settings.ts";

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

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("SMTP is not configured. Set host/port/from in Settings → SMTP.");
  }
}

let cached: { config: SmtpConfig; transporter: Transporter; expires: number } | null = null;
const TTL_MS = 30_000;

export function invalidateEmailCache(): void {
  cached = null;
}

function readConfig(): SmtpConfig {
  const s = getAllSettings();
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

export function isSmtpConfigured(): boolean {
  const c = readConfig();
  return c.enabled && c.host !== "" && c.from !== "";
}

function getTransporter(): { config: SmtpConfig; transporter: Transporter } {
  const now = Date.now();
  if (cached && cached.expires > now) return { config: cached.config, transporter: cached.transporter };
  const config = readConfig();
  if (!config.enabled || !config.host || !config.from) {
    throw new EmailNotConfiguredError();
  }
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  cached = { config, transporter, expires: now + TTL_MS };
  return { config, transporter };
}

export async function sendEmail(opts: EmailOptions): Promise<{ messageId: string }> {
  const { config, transporter } = getTransporter();
  if (!opts.text && !opts.html) {
    throw new Error("Email must include `text` or `html`");
  }
  const sendOpts: Parameters<Transporter["sendMail"]>[0] = {
    from: config.from,
    to: opts.to,
    subject: opts.subject,
  };
  if (opts.text) sendOpts.text = opts.text;
  if (opts.html) sendOpts.html = opts.html;
  const info = await transporter.sendMail(sendOpts);
  return { messageId: info.messageId };
}

export async function verifySmtp(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { transporter } = getTransporter();
    await transporter.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
