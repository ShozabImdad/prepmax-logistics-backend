// Branded Prep Max Logistics email templates for the customer-facing events
// (plan §9): booking received, order confirmed/approved, delivered, exception.
// Each returns { subject, html }. Kept as simple inline-styled HTML for broad
// email-client compatibility (no external CSS/fonts).

import { config } from "../../config/env.js";

export type CustomerEmailTemplate =
  | "booking_received"
  | "order_confirmed"
  | "delivered"
  | "exception";

interface TemplateVars {
  customerName: string;
  trackingCode: string;
  statusText?: string;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!),
  );
}

function trackingUrl(trackingCode: string): string {
  return `${config.portalBaseUrl.replace(/\/$/, "")}/track/${encodeURIComponent(trackingCode)}`;
}

function shell(title: string, bodyHtml: string, trackingCode: string): string {
  const url = trackingUrl(trackingCode);
  return `<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:Segoe UI,Arial,sans-serif;color:#111;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #dce3ec;">
          <tr><td style="background:#0f2f6b;padding:18px 24px;">
            <span style="color:#fff;font-size:18px;font-weight:800;letter-spacing:-0.3px;">PREP MAX</span>
            <span style="color:#9bb4e6;font-size:10px;letter-spacing:2px;font-weight:600;"> LOGISTICS</span>
          </td></tr>
          <tr><td style="padding:24px;">
            <h1 style="margin:0 0 12px;font-size:18px;">${esc(title)}</h1>
            ${bodyHtml}
            <div style="margin:22px 0 6px;">
              <a href="${esc(url)}" style="display:inline-block;background:#1e40af;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px;">Track your shipment</a>
            </div>
            <p style="color:#667; font-size:12px;margin-top:14px;">Or use tracking number <strong>${esc(trackingCode)}</strong> at Prep Max Logistics.</p>
          </td></tr>
          <tr><td style="padding:14px 24px;border-top:1px solid #eef2f7;color:#98a6bd;font-size:11px;">
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
): { subject: string; html: string } {
  const name = esc(vars.customerName || "Customer");
  const code = vars.trackingCode;

  switch (template) {
    case "booking_received":
      return {
        subject: `We received your booking request (${code})`,
        html: shell(
          "Booking request received",
          `<p>Hi ${name},</p>
           <p>Thanks for your booking request. Our branch team is reviewing the details and will confirm your shipment shortly. We'll email you as soon as it's approved.</p>
           <p style="color:#667;">Reference: <strong>${esc(code)}</strong></p>`,
          code,
        ),
      };
    case "order_confirmed":
      return {
        subject: `Your shipment is confirmed and trackable (${code})`,
        html: shell(
          "Your shipment is confirmed",
          `<p>Hi ${name},</p>
           <p>Good news — your shipment has been confirmed and is now trackable. You can follow its progress anytime using the button below.</p>`,
          code,
        ),
      };
    case "delivered":
      return {
        subject: `Your parcel was delivered (${code})`,
        html: shell(
          "Your parcel was delivered",
          `<p>Hi ${name},</p>
           <p>Your shipment <strong>${esc(code)}</strong> has been delivered. Thank you for shipping with Prep Max Logistics!</p>`,
          code,
        ),
      };
    case "exception":
      return {
        subject: `Update on your shipment (${code})`,
        html: shell(
          "There's an update on your shipment",
          `<p>Hi ${name},</p>
           <p>There's been an update on your shipment <strong>${esc(code)}</strong>${vars.statusText ? `: <em>${esc(vars.statusText)}</em>` : "."}</p>
           <p>Please check the latest tracking for details. If you need help, contact your Prep Max branch.</p>`,
          code,
        ),
      };
  }
}
