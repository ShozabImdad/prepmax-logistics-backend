import type { InvoiceRow, VendorBillRow, LedgerEntry } from "./queries.js";
import { logoDataUri, SHARED_CSS } from "../documents/templates.js";

// ============================================================================
// HELPERS
// ============================================================================
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!),
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? esc(iso) : d.toISOString().slice(0, 10);
}

function money(n: number, currency: string): string {
  const v = Number(n ?? 0);
  const sign = v < 0 ? "-" : "";
  return `${sign}${esc(currency)} ${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Same idea as the AWB's ".flags span" tag styling — a bordered outline
// label, no fills, no brand color. Only the border/text tone shifts by
// status so it stays legible without introducing new palette colors.
function statusBadge(status: string): string {
  const tones: Record<string, string> = {
    paid: "#1a1a1a", partial: "#555", unpaid: "#000", void: "#888", draft: "#888",
  };
  const tone = tones[status] ?? "#333";
  return `<span class="badge" style="color:${tone}; border-color:${tone};">${esc(status.toUpperCase())}</span>`;
}

// ============================================================================
// EXTRA CSS — layers on top of the exact same SHARED_CSS used by the AWB and
// Receipt (imported from the documents module) so finance PDFs match their
// look precisely: black borders, no brand-blue fills, same box/grid/table
// vocabulary. This block only adds the handful of classes those templates
// don't already define (line-item + totals tables, status badge, notes box).
// ============================================================================
const FINANCE_CSS = `
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5px solid #000; padding-bottom: 10px; margin-bottom: 14px; }
  .doc-sub { text-align: right; margin-top: 4px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; }
  .items th, .items td { border: 1px solid #333; padding: 4px 6px; text-align: left; vertical-align: top; }
  .items th { background: #f0f3f8; font-size: 8px; text-transform: uppercase; letter-spacing: 0.4px; }
  .items tr:nth-child(even) td { background: #fafafa; }
  .totals { width: 260px; margin-left: auto; margin-top: 10px; }
  .totals td { padding: 3px 6px; }
  .totals .grand td { font-weight: 700; background:#f7f9fc; border-top: 1px solid #333; padding-top: 6px; }
  .badge { display:inline-block; border: 1px solid; border-radius: 3px; padding: 1px 8px; font-size: 9px; font-weight: 700; letter-spacing: 0.5px; }
  .notes { margin-top: 16px; padding: 8px 10px; background: #f7f9fc; border: 1px solid #ddd; font-size: 10px; }
`;

function brandHeader(branchName: string | null, branchCity: string | null): string {
  const sub = [branchName, branchCity].filter(Boolean).join(" — ");
  return `
    <div class="brand" style="display:flex; align-items:center; gap:10px;">
      ${logoDataUri ? `<img src="${logoDataUri}" alt="logo">` : `<div class="brand-text">PREP MAX<small>LOGISTICS</small></div>`}
      ${sub ? `<div class="muted" style="margin-left:6px;">${esc(sub)}</div>` : ""}
    </div>`;
}

// ============================================================================
// TEMPLATE: CUSTOMER INVOICE / CREDIT NOTE (AR) — A4
// ============================================================================
// Only ever called for debit invoices — credit notes are excluded at the
// route level (see finance/routes.ts), so no CN branching is needed here.
export function invoiceHtml(inv: InvoiceRow): string {
  const items = inv.items ?? [];
  const rows = (items.length ? items : [{ description: "—", quantity: 0, unitPrice: 0, lineTotal: 0 }])
    .map((it) => `<tr>
        <td>${esc(it.description)}</td>
        <td class="num">${it.quantity}</td>
        <td class="num">${money(it.unitPrice, inv.currency)}</td>
        <td class="num">${money(it.lineTotal, inv.currency)}</td>
      </tr>`).join("");

  const balanceDue = Math.max(inv.total - inv.amountPaid - inv.creditedAmount, 0);
  const custContact = [inv.customerEmail, inv.customerPhone].filter(Boolean).map(esc).join(" · ");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHARED_CSS}${FINANCE_CSS}</style></head><body>
  <div class="page">
    <div class="top">
      ${brandHeader(inv.branchName, inv.branchCity)}
      <div>
        <div class="doc-title">Invoice</div>
        <div class="doc-sub"><strong>${esc(inv.invoiceNo)}</strong></div>
        <div class="doc-sub">${statusBadge(inv.status)}</div>
      </div>
    </div>

    <div class="grid2">
      <div class="box">
        <div class="lbl">Bill To</div>
        <div><strong>${esc(inv.customerName ?? "—")}</strong></div>
        ${custContact ? `<div class="muted">${custContact}</div>` : ""}
      </div>
      <div class="box">
        <div class="lbl">Details</div>
        <div>Issue Date: <strong>${fmtDate(inv.issueDate)}</strong></div>
        <div>Due Date: <strong>${fmtDate(inv.dueDate)}</strong></div>
        ${inv.orderPublicId ? `<div>Order: <strong>${esc(inv.orderPublicId)}</strong></div>` : ""}
      </div>
    </div>

    <table class="items">
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      <tr><td>Subtotal</td><td class="num">${money(inv.subtotal, inv.currency)}</td></tr>
      <tr><td>Tax</td><td class="num">${money(inv.tax, inv.currency)}</td></tr>
      <tr class="grand"><td>Total</td><td class="num">${money(inv.total, inv.currency)}</td></tr>
      <tr><td>Amount Paid</td><td class="num">${money(inv.amountPaid, inv.currency)}</td></tr>
      ${inv.creditedAmount ? `<tr><td>Credited</td><td class="num">${money(inv.creditedAmount, inv.currency)}</td></tr>` : ""}
      <tr class="grand"><td>Balance Due</td><td class="num">${money(balanceDue, inv.currency)}</td></tr>
    </table>

    ${inv.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(inv.notes)}</div>` : ""}

    <div class="foot">Prep Max Logistics · This is a system-generated invoice and does not require a signature.</div>
  </div>
  </body></html>`;
}

// ============================================================================
// TEMPLATE: VENDOR BILL (AP) — A4
// ============================================================================
export function vendorBillHtml(bill: VendorBillRow): string {
  const items = bill.items ?? [];
  const rows = (items.length ? items : [{ description: "—", amount: 0, orderPublicId: null }])
    .map((it) => `<tr>
        <td>${esc(it.description)}${it.orderPublicId ? ` <span class="muted">(Order ${esc(it.orderPublicId)})</span>` : ""}</td>
        <td class="num">${money(it.amount, bill.currency)}</td>
      </tr>`).join("");

  const balanceDue = Math.max(bill.total - bill.amountPaid, 0);
  const vendorContact = [bill.vendorContactName, bill.vendorPhone, bill.vendorEmail].filter(Boolean).map(esc).join(" · ");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHARED_CSS}${FINANCE_CSS}</style></head><body>
  <div class="page">
    <div class="top">
      ${brandHeader(bill.branchName, bill.branchCity)}
      <div>
        <div class="doc-title">Vendor Bill</div>
        <div class="doc-sub"><strong>${esc(bill.billNo ?? bill.publicId)}</strong></div>
        <div class="doc-sub">${statusBadge(bill.status)}</div>
      </div>
    </div>

    <div class="grid2">
      <div class="box">
        <div class="lbl">Vendor</div>
        <div><strong>${esc(bill.vendorName)}</strong></div>
        ${vendorContact ? `<div class="muted">${vendorContact}</div>` : ""}
        ${bill.vendorAddress ? `<div class="muted">${esc(bill.vendorAddress)}</div>` : ""}
      </div>
      <div class="box">
        <div class="lbl">Details</div>
        <div>Bill Date: <strong>${fmtDate(bill.billDate)}</strong></div>
        <div>Due Date: <strong>${fmtDate(bill.dueDate)}</strong></div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      <tr><td>Subtotal</td><td class="num">${money(bill.subtotal, bill.currency)}</td></tr>
      <tr><td>Tax</td><td class="num">${money(bill.tax, bill.currency)}</td></tr>
      <tr class="grand"><td>Total</td><td class="num">${money(bill.total, bill.currency)}</td></tr>
      <tr><td>Amount Paid</td><td class="num">${money(bill.amountPaid, bill.currency)}</td></tr>
      <tr class="grand"><td>Balance Due</td><td class="num">${money(balanceDue, bill.currency)}</td></tr>
    </table>

    ${bill.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(bill.notes)}</div>` : ""}

    <div class="foot">Prep Max Logistics · Internal accounts-payable document.</div>
  </div>
  </body></html>`;
}

// ============================================================================
// TEMPLATE: LEDGER / STATEMENT OF ACCOUNT (AR or AP) — A4
// ============================================================================
export function ledgerHtml(opts: {
  kind: "customer" | "vendor";
  partyName: string;
  contactLine?: string | null;
  branchName: string | null;
  branchCity: string | null;
  entries: LedgerEntry[];
  closingBalance: number;
  currency?: string;
}): string {
  const currency = opts.currency ?? "PKR";
  const title = opts.kind === "customer" ? "Customer Statement" : "Vendor Statement";
  const balanceLabel = opts.kind === "customer" ? "Amount Receivable" : "Amount Payable";
  const rows = (opts.entries.length ? opts.entries : [])
    .map((e) => `<tr>
        <td>${fmtDate(e.date)}</td>
        <td>${esc(e.reference)}</td>
        <td>${esc(e.description)}</td>
        <td class="num">${e.debit ? money(e.debit, currency) : ""}</td>
        <td class="num">${e.credit ? money(e.credit, currency) : ""}</td>
        <td class="num">${money(e.balance, currency)}</td>
      </tr>`).join("") || `<tr><td colspan="6" class="muted" style="text-align:center; padding:16px;">No transactions on record.</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHARED_CSS}${FINANCE_CSS}</style></head><body>
  <div class="page">
    <div class="top">
      ${brandHeader(opts.branchName, opts.branchCity)}
      <div>
        <div class="doc-title">${esc(title)}</div>
        <div class="doc-sub">Generated ${fmtDate(new Date().toISOString())}</div>
      </div>
    </div>

    <div class="box" style="margin-bottom:16px;">
      <div class="lbl">${opts.kind === "customer" ? "Customer" : "Vendor"}</div>
      <div><strong>${esc(opts.partyName)}</strong></div>
      ${opts.contactLine ? `<div class="muted">${esc(opts.contactLine)}</div>` : ""}
    </div>

    <table class="items">
      <thead><tr><th>Date</th><th>Reference</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      <tr class="grand"><td>${esc(balanceLabel)}</td><td class="num">${money(opts.closingBalance, currency)}</td></tr>
    </table>

    <div class="foot">Prep Max Logistics · Statement reflects transactions as of the generation date above.</div>
  </div>
  </body></html>`;
}
