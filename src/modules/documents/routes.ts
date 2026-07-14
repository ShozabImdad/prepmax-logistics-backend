// Document routes: printable A4 air waybill and receipt PDFs for an order.
// Permission-gated (documents.print) and branch-isolated via req.db (a caller
// can only print documents for orders visible to their branch).

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requirePermission, requireCustomer } from "../../middleware/auth.js";
import { isCustomer } from "../auth/types.js";
import { loadDocData } from "./data.js";
import { barcodeDataUri } from "./barcode.js";
import { awbHtml, receiptHtml,shippingBillHtml  } from "./templates.js";
import { htmlToPdf } from "./pdf.js";

function pubId(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

export const documentRouter: Router = Router();       // staff: /api/orders/:publicId/...
export const portalDocumentRouter: Router = Router(); // customer: /api/portal/orders/:publicId/...

// ── STAFF: air waybill ──────────────────────────────────────────────────────
documentRouter.get(
  "/:publicId/awb.pdf",
  requireStaff,
  requirePermission("documents.print"),
  asyncHandler(async (req, res) => {
    const data = await loadDocData(req.db!, pubId(req.params.publicId));
    if (!data) return res.status(404).json({ error: "Order not found" });
    const barcode = await barcodeDataUri(data.trackingCode);
    const pdf = await htmlToPdf(awbHtml(data, barcode));
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="AWB-${data.trackingCode}.pdf"`);
    return res.end(pdf);
  }),
);

// ── STAFF: receipt ──────────────────────────────────────────────────────────
documentRouter.get(
  "/:publicId/receipt.pdf",
  requireStaff,
  requirePermission("documents.print"),
  asyncHandler(async (req, res) => {
    const data = await loadDocData(req.db!, pubId(req.params.publicId));
    if (!data) return res.status(404).json({ error: "Order not found" });
    const barcode = await barcodeDataUri(data.trackingCode);
    const pdf = await htmlToPdf(receiptHtml(data, barcode));
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="Receipt-${data.trackingCode}.pdf"`);
    return res.end(pdf);
  }),
);
documentRouter.get(
  "/:publicId/shipping-bill.pdf",
  requireStaff,
  requirePermission("documents.print"),
  asyncHandler(async (req, res) => {
    const data = await loadDocData(req.db!, pubId(req.params.publicId));
    if (!data) return res.status(404).json({ error: "Order not found" });
    const barcode = await barcodeDataUri(data.awbNumber || data.trackingCode);
    const pdf = await htmlToPdf(shippingBillHtml(data, barcode));
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="ShippingBill-${data.trackingCode}.pdf"`);
    return res.end(pdf);
  }),
);
// ── CUSTOMER: their own receipt (plan §5: receipt download in portal) ───────
portalDocumentRouter.get(
  "/:publicId/receipt.pdf",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    // Scope to the customer's own order: load then verify ownership.
    const data = await req.db!(async (sql) => {
      const owns = await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM orders WHERE public_id = $1 AND customer_id = $2",
        [pubId(req.params.publicId), cust.customerId],
      );
      if ((owns.rows[0]?.n ?? 0) === 0) return null;
      return loadDocData((fn) => fn(sql), pubId(req.params.publicId));
    });
    if (!data) return res.status(404).json({ error: "Order not found" });
    const barcode = await barcodeDataUri(data.trackingCode);
    const pdf = await htmlToPdf(receiptHtml(data, barcode));
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="Receipt-${data.trackingCode}.pdf"`);
    return res.end(pdf);
  }),
);
