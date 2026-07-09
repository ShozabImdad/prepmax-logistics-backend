// Email sending via Nodemailer SMTP.
//
// Provider-agnostic: it connects to whatever SMTP relay the env points at
// (Brevo, Postmark, SES, Gmail, ...). Swapping providers = changing env vars,
// not code.
//
// LOG-ONLY fallback: if SMTP isn't fully configured, we don't transmit — we
// return a "logged" result so the caller can still record the email in
// email_log. This lets the whole notification flow run in dev without a real
// mail account, and switches to real sending the moment credentials are set.

import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../../config/env.js";

export interface SendResult {
  status: "sent" | "logged" | "failed";
  providerId?: string;
  error?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

let transporter: Transporter | null = null;
let transporterReady = false;

function smtpConfigured(): boolean {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
}

function getTransporter(): Transporter | null {
  if (!smtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

/** Optional one-time SMTP connection check (logged at startup). */
export async function verifyMailer(): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.log("[mail] SMTP not configured — running in LOG-ONLY mode (emails will be recorded, not sent).");
    return;
  }
  try {
    await t.verify();
    transporterReady = true;
    console.log(`[mail] SMTP ready via ${config.smtp.host}:${config.smtp.port}`);
  } catch (e) {
    console.warn(`[mail] SMTP verify failed (${e instanceof Error ? e.message : e}) — will still attempt sends.`);
  }
}

/** Send (or log) one email. Never throws; returns a status the caller records. */
export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const t = getTransporter();
  if (!t) {
    console.log(`[mail:log-only] to=${msg.to} subject="${msg.subject}"`);
    return { status: "logged" };
  }
  try {
    const info = await t.sendMail({
      from: config.mailFrom,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text ?? htmlToText(msg.html),
    });
    return { status: "sent", providerId: info.messageId };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

// Very small html->text fallback for the plaintext part.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export { transporterReady };
