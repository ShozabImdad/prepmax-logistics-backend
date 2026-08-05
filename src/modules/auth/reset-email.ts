// Sends the "reset your password" email. Kept local to the auth module
// (rather than notifications/email-templates.ts) since it's account-security
// mail, not a customer order-lifecycle notification — but reuses the same
// sendEmail() transport as everything else.

import { sendEmail } from "../notifications/mailer.js";
import { config } from "../../config/env.js";

export async function sendPasswordResetEmail(opts: {
  to: string;
  fullName: string;
  resetUrl: string;
}): Promise<void> {
  const { to, fullName, resetUrl } = opts;
  const subject = "Reset your Prep Max Logistics password";
  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <div style="border-top: 4px solid #f5c518; padding-top: 20px;">
        <h2 style="margin: 0 0 12px;">Reset your password</h2>
        <p>Hi ${escapeHtml(fullName)},</p>
        <p>We received a request to reset your Prep Max Logistics password. Click the button below to choose a new one. This link expires in 30 minutes.</p>
        <p style="text-align: center; margin: 28px 0;">
          <a href="${resetUrl}" style="background:#f5c518;color:#1a1a1a;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Reset Password</a>
        </p>
        <p style="font-size: 13px; color: #555;">If you didn't request this, you can safely ignore this email — your password won't be changed.</p>
        <p style="font-size: 13px; color: #555;">If the button doesn't work, copy and paste this link into your browser:<br>${resetUrl}</p>
      </div>
    </div>
  `.trim();

  await sendEmail({ to, subject, html });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

export function buildResetUrl(kind: "staff" | "customer", rawToken: string): string {
  const base = kind === "staff" ? config.staffPortalBaseUrl : config.portalBaseUrl;
  // Staff and customer reset pages live at different frontend routes
  // (/portal/admin/reset-password vs /reset-password) — this must match
  // wherever the frontend actually mounts each page, or the link sends
  // staff users to the customer reset flow (wrong principal → "invalid token").
  const path = kind === "staff" ? "/portal/admin/reset-password" : "/reset-password";
  return `${base.replace(/\/+$/, "")}${path}?token=${encodeURIComponent(rawToken)}`;
}
