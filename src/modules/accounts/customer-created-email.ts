// Sends the "your account has been created" email with login credentials.
// Kept local to the accounts module (like auth/reset-email.ts) since it's
// account-setup mail, not a customer order-lifecycle notification — but
// reuses the same sendEmail() transport.
//
// Branded look + logo: the theme and CID-logo logic are modelled on
// notifications/email-templates.ts (white header, slim yellow accent rule,
// CID-attached logo with logo.png-then-logo-alt.png fallback), but kept
// fully self-contained here — nothing is imported from email-templates.ts.
// The logo builder is a local copy so this file can evolve independently,
// and the HTML shell is a local copy styled to match the rest of the Prep
// Max transactional brand.

import { sendEmail } from "../notifications/mailer.js";
import type { EmailAttachment } from "../notifications/mailer.js";
import { config } from "../../config/env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---- Brand palette (mirrors notifications/email-templates.ts) -------------
const BRAND_YELLOW = "#F5B400";
const INK = "#14161A";
const BODY_TEXT = "#33363D";
const MUTED_TEXT = "#6B7280";
const BORDER = "#E7E8EC";
const PAGE_BG = "#F4F5F7";

const LOGO_CID = "prepmax-logo";

// ---- Logo loading (mirrors notifications/email-templates.ts exactly) ------
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

/**
 * The logo as a CID attachment for the welcome email, or null if no logo
 * file is present. Cached after the first call. Same resolution strategy
 * and fallback chain as notifications/email-templates.ts.
 */
function getLogoAttachment(): EmailAttachment | null {
  if (cachedLogoAttachment !== undefined) return cachedLogoAttachment;
  const primary = resolveAssetPath("logo.png");
  const fallback = resolveAssetPath("logo-alt.png");
  const chosen = primary ?? fallback;
  if (!chosen) {
    console.warn("[customer-created] Logo file not found (checked logo.png and logo-alt.png), falling back to text wordmark.");
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
    console.error("[customer-created] Failed to load logo image:", error);
    cachedLogoAttachment = null;
  }
  return cachedLogoAttachment;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!),
  );
}

// ---- Branded HTML shell (local copy, matches email-templates.ts) ----------
function renderShell(opts: {
  title: string;
  bodyHtml: string;
  cta: { label: string; url: string } | null;
}): string {
  const { title, bodyHtml, cta } = opts;

  const ctaBlock = cta
    ? `<div style="margin:26px 0 6px;">
         <a href="${esc(cta.url)}" style="display:inline-block;background:${INK};color:#FFFFFF;
           text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;">${esc(cta.label)}</a>
       </div>`
    : "";

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
            ${ctaBlock}
          </td></tr>

          <tr><td style="padding:16px 28px;border-top:1px solid ${BORDER};color:${MUTED_TEXT};font-size:11px;background:#FAFAFB;">
            This is an automated message from Prep Max Logistics. Please do not reply.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

// ---- Welcome email --------------------------------------------------------
export async function sendCustomerCreatedEmail(opts: {
  to: string;
  fullName: string;
  email: string;
  password: string;
  loginUrl: string;
}): Promise<void> {
  const { to, fullName, email, password, loginUrl } = opts;

  const subject = "Your PrepMax Logistics account is ready";

  // Credentials card — same look as before, but using the shared brand tokens.
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

  const bodyHtml = `
    <p style="margin:0 0 10px;">Hi ${esc(fullName)},</p>
    <p style="margin:0 0 10px;">
      Your account with <strong style="color:${INK};">Prep Max Logistics</strong> has been created by our team.
      You can now log in to the customer portal to place bookings, track shipments, and manage your orders.
    </p>
    ${credentialsTable}
    <p style="margin:0;color:${MUTED_TEXT};font-size:13px;">
      For your security, we recommend changing your password after your first login.
    </p>`;

  const html = renderShell({
    title: "Your account is ready",
    bodyHtml,
    cta: { label: "Go to Login", url: `${loginUrl}/login` },
  });

  // Attach the logo as a CID inline image so the <img src="cid:prepmax-logo">
  // in the shell header renders in Gmail/Outlook/etc. Falls back to the text
  // wordmark automatically if no logo file is present.
  const logo = getLogoAttachment();
  const attachments = logo ? [logo] : [];

  await sendEmail({ to, subject, html, attachments });
}

export function buildCustomerLoginUrl(): string {
  return config.portalBaseUrl.replace(/\/+$/, "");
}