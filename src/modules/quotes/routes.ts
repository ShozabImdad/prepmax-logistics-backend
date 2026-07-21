// Quote routes.
//
// Customer routes (/api/portal/quotes) let a logged-in customer request a
// shipping quote and see their history. Staff routes (/api/quotes) are
// permission-gated (quotes.manage) and scoped by branch RLS beneath
// req.db, same as complaints.

import { Router, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requireCustomer, requirePermission } from "../../middleware/auth.js";
import { isStaff, isCustomer } from "../auth/types.js";
import { createQuoteSchema, updateQuoteSchema } from "./schema.js";
import {
  createQuote, listQuotes, listCustomerQuotes, updateQuote,
  listQuoteMessages, addQuoteMessage, verifyQuoteOwnership, QuoteError,
} from "./queries.js";

import { createBranchNotification } from "../notifications/service.js";
import { addSseClient } from "../notifications/sse.js";

function handleQuoteError(err: unknown, res: Response): void {
  if (err instanceof QuoteError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export const quoteRouter: Router = Router();       // staff: /api/quotes
export const portalQuoteRouter: Router = Router(); // customer: /api/portal/quotes

// ── CUSTOMER: live stream ────────────────────────────────────────────────────
// Same shared hub as complaints (see modules/complaints/routes.ts) — a
// customer connecting here and a staff member connected to
// /api/notifications/stream both sit on the same branch-scoped fan-out, they
// just listen for a different event name ("quote_message" vs "complaint_message").
portalQuoteRouter.get("/stream", requireCustomer, (req, res) => {
  const cust = req.auth!;
  if (!isCustomer(cust)) {
    res.status(403).end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const remove = addSseClient(cust.branchId, cust.customerId, res);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    remove();
  });
});

// ── CUSTOMER: request a quote ───────────────────────────────────────────────
portalQuoteRouter.post(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const parsed = createQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid quote request", details: parsed.error.flatten() });
    }
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      const result = await createQuote(req.db!, cust.customerId, cust.branchId, parsed.data);
      // Admin in-app alert. Best-effort: a notification failure shouldn't fail
      // the quote request the customer just successfully submitted.
      try {
        await createBranchNotification(req.db!, cust.branchId, {
          type: "quote_requested",
          message: `New quote request (${result.originCountry} → ${result.destinationCountry}) from ${cust.fullName}`,
          orderId: null,
        });
      } catch (err) {
        console.error("[quotes] notification failed:", err);
      }
      return res.status(201).json({ quote: result });
    } catch (err) {
      return handleQuoteError(err, res);
    }
  }),
);

// ── CUSTOMER: list own quote requests ───────────────────────────────────────
portalQuoteRouter.get(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const quotes = await listCustomerQuotes(req.db!, cust.customerId);
    return res.json({ quotes });
  }),
);

// ── STAFF: list quotes (branch-scoped via RLS) ──────────────────────────────
quoteRouter.get(
  "/",
  requireStaff,
  requirePermission("quotes.manage"),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const quotes = await listQuotes(req.db!, { status });
    return res.json({ quotes });
  }),
);

// ── STAFF: update status / add pricing & response ───────────────────────────
quoteRouter.patch(
  "/:publicId",
  requireStaff,
  requirePermission("quotes.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const result = await updateQuote(req.db!, param(req.params.publicId), staff.userId, parsed.data);
      return res.json({ quote: result });
    } catch (err) {
      return handleQuoteError(err, res);
    }
  }),
);
quoteRouter.get(
  "/:publicId/messages",
  requireStaff,
  requirePermission("quotes.manage"),
  asyncHandler(async (req, res) => {
    try {
      const messages = await listQuoteMessages(req.db!, param(req.params.publicId));
      return res.json({ messages });
    } catch (err) {
      return handleQuoteError(err, res);
    }
  }),
);

quoteRouter.post(
  "/:publicId/messages",
  requireStaff,
  requirePermission("quotes.manage"),
  asyncHandler(async (req, res) => {
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "Message body is required" });
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const message = await addQuoteMessage(req.db!, param(req.params.publicId), "staff", staff.userId, body);
      return res.status(201).json({ message });
    } catch (err) {
      return handleQuoteError(err, res);
    }
  }),
);

// ── CUSTOMER: message thread on own quote ───────────────────────────────────
// ── CUSTOMER: message thread on own quote ───────────────────────────────────
portalQuoteRouter.get(
  "/:publicId/messages",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      await verifyQuoteOwnership(req.db!, param(req.params.publicId), cust.customerId);
      const messages = await listQuoteMessages(req.db!, param(req.params.publicId));
      return res.json({ messages });
    } catch (err) {
      return handleQuoteError(err, res);
    }
  }),
);

portalQuoteRouter.post(
  "/:publicId/messages",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "Message body is required" });
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      await verifyQuoteOwnership(req.db!, param(req.params.publicId), cust.customerId);
      const message = await addQuoteMessage(req.db!, param(req.params.publicId), "customer", cust.customerId, body);
      return res.status(201).json({ message });
    } catch (err) {
      return handleQuoteError(err, res);
    }
  }),
);