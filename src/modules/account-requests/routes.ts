// Account requests — public "Request an Account" submissions + staff queue.
//
// Public POST is unauthenticated (a prospect on the marketing site). It runs in
// a trusted super-admin server context (like public tracking) since the table
// is global, not branch-scoped. Staff endpoints require auth + a permission.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http.js";
import { pool, withSuperAdminAllBranches } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import { requireStaff, requirePermission } from "../../middleware/auth.js";

export const publicAccountRequestRouter: Router = Router(); // POST /api/account-requests (public)
export const accountRequestRouter: Router = Router();       // staff: /api/account-requests

// light per-IP rate limit for the public endpoint
const WINDOW_MS = 60_000;
const MAX = 5;
const hits = new Map<string, { count: number; resetAt: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const r = hits.get(ip);
  if (!r || now > r.resetAt) { hits.set(ip, { count: 1, resetAt: now + WINDOW_MS }); return false; }
  r.count++;
  return r.count > MAX;
}

const requestInput = z.object({
  fullName: z.string().min(2).max(120),
  companyName: z.string().max(160).optional(),
  email: z.string().email(),
  phone: z.string().min(5).max(40),
  message: z.string().max(2000).optional(),
});

// ── PUBLIC: submit an account request ───────────────────────────────────────
publicAccountRequestRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (limited(req.ip ?? "unknown")) {
      return res.status(429).json({ error: "Too many requests — please try again shortly." });
    }
    const parsed = requestInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Please provide your name, email, and phone." });
    }
    // Trusted server context (global table).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.is_super_admin','on',true)");
      await client.query(
        `INSERT INTO account_requests (public_id, full_name, company_name, email, phone, message)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [publicId(), parsed.data.fullName, parsed.data.companyName ?? null,
         parsed.data.email, parsed.data.phone, parsed.data.message ?? null],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return res.status(201).json({ ok: true, message: "Thanks! Our team will contact you shortly to set up your account." });
  }),
);

// ── STAFF: list account requests ────────────────────────────────────────────
accountRequestRouter.get(
  "/",
  requireStaff,
  requirePermission("customers.view"),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = await withSuperAdminAllBranches(async (sql) => {
      const where = status ? "WHERE status = $1" : "";
      const params = status ? [status] : [];
      const r = await sql.query(
        `SELECT public_id, full_name, company_name, email, phone, message, status, created_at
           FROM account_requests ${where} ORDER BY created_at DESC LIMIT 200`,
        params,
      );
      return r.rows;
    });
    return res.json({
      requests: rows.map((r) => ({
        publicId: r.public_id, fullName: r.full_name, companyName: r.company_name,
        email: r.email, phone: r.phone, message: r.message, status: r.status, createdAt: r.created_at,
      })),
    });
  }),
);

// ── STAFF: update a request's status ────────────────────────────────────────
const statusInput = z.object({ status: z.enum(["new", "contacted", "converted", "rejected"]) });
accountRequestRouter.post(
  "/:publicId/status",
  requireStaff,
  requirePermission("customers.create"),
  asyncHandler(async (req, res) => {
    const parsed = statusInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid status" });
    const pid = String(req.params.publicId ?? "");
    const updated = await withSuperAdminAllBranches(async (sql) => {
      const r = await sql.query(
        "UPDATE account_requests SET status = $2 WHERE public_id = $1",
        [pid, parsed.data.status],
      );
      return r.rowCount ?? 0;
    });
    if (updated === 0) return res.status(404).json({ error: "Request not found" });
    return res.json({ ok: true, status: parsed.data.status });
  }),
);
