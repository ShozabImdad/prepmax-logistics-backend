// Sends the "your password was updated" email — fired both when a
// forgot-password reset completes and when a logged-in user changes their
// own password. Shows the account email + new password, same as the
// customer-created welcome email.
//
// Branded look + logo: local copy of the shell/logo logic from
// accounts/customer-created-email.ts (same rationale as that file — kept
// self-contained rather than sharing a base so each can evolve
// independently), styled to match the rest of the Prep Max transactional
// brand.

import { sendEmail } from "../notifications/mailer.js";
import type { EmailAttachment } from "../notifications/mailer.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---- Brand palette (mirrors customer-created-email.ts) --------------------
const BRAND_YELLOW = "#F5B400";
const INK = "#14161A";
const BODY_TEXT = "#33363D";
const MUTED_TEXT = "#6B7280";
const BORDER = "#E7E8EC";
const PAGE_BG = "#F4F5F7";

const LOGO_CID = "prepmax-logo";

// ---- Logo loading (mirrors customer-created-email.ts exactly) -------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveAssetPath(filename: string): string | null {
  const candidates = [
    path.join(process.cwd(), "src", "public", filename),
    path.join(process.cwd(), "public", filename),
    path.join(__dirname, "..", "public", filename),
    path.join(__dirname, "..", "..", "src", "public", filename),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

let cachedLogoAttachment: EmailAttachment | null | undefined; // undefined = not yet resolved

function getLogoAttachment(): EmailAttachment | null {
  if (cachedLogoAttachment !== undefined) return cachedLogoAttachment;
  const primary = resolveAssetPath("logo.png");
  const fallback = resolveAssetPath("logo-alt.png");
  const chosen = primary ?? fallback;
  if (!chosen) {
    console.warn("[password-updated] Logo file not found (checked logo.png and logo-alt.png), falling back to text wordmark.");
    cachedLogoAttachment = null;
    return null;
  }
  try {
    cachedLogoAttachment = {
      filename: path.basename(chosen),
      content: fs.readFileSync(chosen),
      cid: LOGO_CID,
      contentType: "image/png",
    };
  } catch (error) {
    console.error("[password-updated] Failed to load logo image:", error);
    cachedLogoAttachment = null;
  }
  return cachedLogoAttachment;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!),
  );
}

// ---- Branded HTML shell (local copy, matches customer-created-email.ts) ---
function renderShell(opts: {
  title: string;
  bodyHtml: string;
}): string {
  const { title, bodyHtml } = opts;



  return `<!doctype html><html><body style="margin:0;background:${PAGE_BG};font-family:Segoe UI,Arial,sans-serif;color:${BODY_TEXT};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid ${BORDER};box-shadow:0 1px 3px rgba(15,15,15,0.05);">

          <!-- Header: white, with a slim yellow accent rule underneath (not a full yellow band) -->
          <tr><td style="background:#FFFFFF;padding:24px 28px 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td align="left">
                ${
                  getLogoAttachment()
                    ? `<img src="cid:${LOGO_CID}" alt="Prep Max Logistics" width="140" height="32"
                         style="display:block;height:32px;width:auto;object-fit:contain;border:0;outline:none;text-decoration:none;">`
                    : `<span style="color:${INK};font-size:17px;font-weight:800;letter-spacing:-0.3px;">PREP MAX</span>
                       <span style="color:${MUTED_TEXT};font-size:10px;letter-spacing:2px;font-weight:700;"> LOGISTICS</span>`
                }
              </td>
            </tr></table>
          </td></tr>

          <!-- Slim yellow accent rule -->
          <tr><td style="background:${BRAND_YELLOW};height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>

          <tr><td style="padding:28px 28px 24px;">
            <h1 style="margin:0 0 8px;font-size:19px;color:${INK};font-weight:700;">${esc(title)}</h1>
            <div style="font-size:14px;line-height:1.6;color:${BODY_TEXT};">
              ${bodyHtml}
            </div>
           
          </td></tr>

          <tr><td style="padding:16px 28px;border-top:1px solid ${BORDER};color:${MUTED_TEXT};font-size:11px;background:#FAFAFB;">
            This is an automated message from Prep Max Logistics. Please do not reply.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

/** Which flow triggered the password change — controls subject/copy only. */
export type PasswordUpdateReason = "reset" | "changed";

// ---- Password-updated email ------------------------------------------------
export async function sendPasswordUpdatedEmail(opts: {
  to: string;
  fullName: string;
  email: string;
  password: string;
  loginUrl: string;
  reason: PasswordUpdateReason;
}): Promise<void> {
  const { to, fullName, email, password, loginUrl, reason } = opts;

  const subject =
    reason === "reset"
      ? "Your Prep Max Logistics password has been reset"
      : "Your Prep Max Logistics password has been changed";

  const credentialsTable = `
    <table role="presentation" cellpadding="0" cellspacing="0"
           style="margin:18px 0 22px;border:1px solid ${BORDER};border-radius:8px;overflow:hidden;width:100%;">
      <tr>
        <td style="background:${PAGE_BG};padding:10px 16px;font-size:12px;font-weight:600;color:${MUTED_TEXT};text-transform:uppercase;letter-spacing:0.4px;width:40%;">Email</td>
        <td style="background:${PAGE_BG};padding:10px 16px;font-size:14px;color:${INK};font-weight:500;">${esc(email)}</td>
      </tr>
      <tr>
        <td style="padding:10px 16px;font-size:12px;font-weight:600;color:${MUTED_TEXT};text-transform:uppercase;letter-spacing:0.4px;">Password</td>
        <td style="padding:10px 16px;font-size:14px;color:${INK};font-weight:500;">
          <code style="background:${PAGE_BG};padding:2px 6px;border-radius:4px;font-size:13px;">${esc(password)}</code>
        </td>
      </tr>
    </table>`;

  const intro =
    reason === "reset"
      ? `Your password for <strong style="color:${INK};">Prep Max Logistics</strong> was just reset using the "forgot password" link. Here are your updated login details.`
      : `Your password for <strong style="color:${INK};">Prep Max Logistics</strong> was just changed. Here are your updated login details.`;

  const bodyHtml = `
    <p style="margin:0 0 10px;">Hi ${esc(fullName)},</p>
    <p style="margin:0 0 10px;">${intro}</p>
    ${credentialsTable}
    <p style="margin:0;color:${MUTED_TEXT};font-size:13px;">
      If you didn't make this change, please contact your administrator immediately.
    </p>`;

  const html = renderShell({
    title: reason === "reset" ? "Your password was reset" : "Your password was changed",
    bodyHtml
    
  });

  const logo = getLogoAttachment();
  const attachments = logo ? [logo] : [];

  await sendEmail({ to, subject, html, attachments });
}
