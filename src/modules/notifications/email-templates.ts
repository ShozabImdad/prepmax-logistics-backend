// Branded Prep Max Logistics email templates for the customer-facing events
// (plan §9): booking received, order confirmed/approved, delivered, exception.
// Each returns { subject, html }. Kept as simple inline-styled HTML for broad
// email-client compatibility (no external CSS/fonts).
//
// Theme: same yellow/black brand as the AWB / Receipt / Shipping Bill PDFs,
// but styled as a clean, professional transactional email — a white header
// with a slim yellow accent rule, not a full yellow banner block.
//
// Logo: resolved with the same candidate paths / logo.png-then-logo-alt.png
// fallback as documents/templates.ts, but embedded as a CID inline
// attachment (src="cid:...") instead of a base64 data: URI. Data URIs are
// fine for the PDF templates (rendered straight to PDF, no mail client
// involved) but get stripped by most mail clients (Gmail, Outlook, Yahoo,
// corporate filters) as a spam/security precaution — that was the original
// "broken image icon" bug here. A CID attachment ships as part of the same
// MIME message the client already downloaded, so it renders immediately
// with no external fetch and no "external content" warning.

import { config } from "../../config/env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { EmailAttachment } from "./mailer.js";

const LOGO_CID = "prepmax-logo";

export type CustomerEmailTemplate =
  | "booking_received"
  | "order_confirmed"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "cancelled";

interface TemplateVars {
  customerName: string;
  trackingCode: string;
  statusText?: string;
}

// ---- Logo loading (mirrors documents/templates.ts exactly) ----------------
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

/** The logo as a CID attachment to pass to sendEmail(), or null if no logo file is present. */
function getLogoAttachment(): EmailAttachment | null {
  if (cachedLogoAttachment !== undefined) return cachedLogoAttachment;
  const primary = resolveAssetPath("logo.png");
  const fallback = resolveAssetPath("logo-alt.png");
  const chosen = primary ?? fallback;
  if (!chosen) {
    console.warn("[email-templates] Logo file not found (checked logo.png and logo-alt.png), falling back to text wordmark.");
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
    console.error("[email-templates] Failed to load logo image:", error);
    cachedLogoAttachment = null;
  }
  return cachedLogoAttachment;
}

// ---- Brand palette --------------------------------------------------------
const BRAND_YELLOW = "#F5B400";
const BRAND_YELLOW_SOFT = "#FCEBB8";
const INK = "#14161A";
const BODY_TEXT = "#33363D";
const MUTED_TEXT = "#6B7280";
const BORDER = "#E7E8EC";
const PAGE_BG = "#F4F5F7";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!),
  );
}

function trackingUrl(trackingCode: string): string {
  return `${config.portalBaseUrl.replace(/\/$/, "")}/tracking?number=${encodeURIComponent(trackingCode)}`;
}

function statusPill(label: string, tone: "yellow" | "ink" = "yellow"): string {
  const bg = tone === "yellow" ? BRAND_YELLOW_SOFT : INK;
  const fg = tone === "yellow" ? "#7A5B00" : "#FFFFFF";
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:700;
    letter-spacing:0.4px;text-transform:uppercase;padding:4px 10px;border-radius:999px;">${esc(label)}</span>`;
}

function shell(
  title: string,
  bodyHtml: string,
  trackingCode: string,
  pill?: string,
  showTracking: boolean = true,
): string {
  const url = trackingUrl(trackingCode);
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

          <!-- Slim yellow accent rule (replaces the old thick black band) -->
          <tr><td style="background:${BRAND_YELLOW};height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>

          <tr><td style="padding:28px 28px 24px;">
            <h1 style="margin:0 0 8px;font-size:19px;color:${INK};font-weight:700;">${esc(title)}</h1>
            ${pill ? `<div style="margin:0 0 14px;">${pill}</div>` : ""}
            <div style="font-size:14px;line-height:1.6;color:${BODY_TEXT};">
              ${bodyHtml}
            </div>
            ${
              showTracking
                ? `<div style="margin:26px 0 6px;">
              <a href="${esc(url)}" style="display:inline-block;background:${INK};color:#FFFFFF;
                text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;">Track your shipment</a>
            </div>
            <p style="color:${MUTED_TEXT};font-size:12px;margin-top:18px;">
              Or use tracking number <strong style="color:${INK};">${esc(trackingCode)}</strong> at Prep Max Logistics.
            </p>`
                : `<p style="color:${MUTED_TEXT};font-size:12px;margin-top:22px;">
              Reference: <strong style="color:${INK};">${esc(trackingCode)}</strong>
            </p>`
            }
          </td></tr>

          <tr><td style="padding:16px 28px;border-top:1px solid ${BORDER};color:${MUTED_TEXT};font-size:11px;background:#FAFAFB;">
            This is an automated message from Prep Max Logistics. Please do not reply.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

export function renderCustomerEmail(
  template: CustomerEmailTemplate,
  vars: TemplateVars,
): { subject: string; html: string; attachments: EmailAttachment[] } {
  const name = esc(vars.customerName || "Customer");
  const code = vars.trackingCode;
  const logo = getLogoAttachment();
  const attachments = logo ? [logo] : [];

  switch (template) {
    case "booking_received":
      return {
        subject: `We received your booking request (${code})`,
        attachments,
        html: shell(
          "Booking request received",
          `<p style="margin:0 0 10px;">Hi ${name},</p>
           <p style="margin:0 0 10px;">Thanks for your booking request. Our branch team is reviewing the details and will confirm your shipment shortly. We'll email you as soon as it's approved.</p>
           <p style="color:${MUTED_TEXT};margin:0;">Reference: <strong style="color:${INK};">${esc(code)}</strong></p>`,
          code,
          statusPill("Pending review"),
        ),
      };
    case "order_confirmed":
      return {
        subject: `Your shipment is confirmed and trackable (${code})`,
        attachments,
        html: shell(
          "Your shipment is confirmed",
          `<p style="margin:0 0 10px;">Hi ${name},</p>
           <p style="margin:0;">Good news,your shipment has been confirmed and is now trackable. You can follow its progress anytime using the button below.</p>`,
          code,
          statusPill("Confirmed"),
        ),
      };


case "out_for_delivery":
      return {
        subject: `Out for delivery today (${code})`,
        attachments,
        html: shell(
          "Out for delivery today",
          `<p style="margin:0 0 10px;">Hi ${name},</p>
           <p style="margin:0;">Good news,your shipment <strong style="color:${INK};">${esc(code)}</strong> is out for delivery today${vars.statusText ? `: <em>${esc(vars.statusText)}</em>` : "."}</p>`,
          code,
          statusPill("Out for delivery", "ink"),
        ),
      };
      
    case "delivered":
      return {
        subject: `Your parcel was delivered (${code})`,
        attachments,
        html: shell(
          "Your parcel was delivered",
          `<p style="margin:0 0 10px;">Hi ${name},</p>
           <p style="margin:0;">Your shipment <strong style="color:${INK};">${esc(code)}</strong> has been delivered. Thank you for shipping with Prep Max Logistics!</p>`,
          code,
          statusPill("Delivered", "ink"),
        ),
      };
    case "exception":
      return {
        subject: `Update on your shipment (${code})`,
        attachments,
        html: shell(
          "There's an update on your shipment",
          `<p style="margin:0 0 10px;">Hi ${name},</p>
           <p style="margin:0 0 10px;">There's been an update on your shipment <strong style="color:${INK};">${esc(code)}</strong>${vars.statusText ? `: <em>${esc(vars.statusText)}</em>` : "."}</p>
           <p style="margin:0;">Please check the latest tracking for details. If you need help, contact your Prep Max branch.</p>`,
          code,
          statusPill("Attention needed"),
        ),
      };
    case "cancelled":
      return {
        subject: `Your shipment was cancelled (${code})`,
        attachments,
        html: shell(
          "Your shipment has been cancelled",
          `<p style="margin:0 0 10px;">Hi ${name},</p>
           <p style="margin:0;">Your shipment <strong style="color:${INK};">${esc(code)}</strong> has been cancelled by our team. If this is unexpected or you have questions, please contact your Prep Max branch.</p>`,
          code,
          statusPill("Cancelled", "ink"),
          false, // no tracking CTA — there's nothing left to track on a cancelled shipment
        ),
      };
  }
}