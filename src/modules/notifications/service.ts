// In-app notification store + email-log helpers.
//
// createBranchNotification: inserts a notification row for a branch (optionally
// targeting a specific user) and pushes it live to connected staff via SSE.
// Because the poller and request handlers both create notifications, callers
// pass a `run` that already carries the right branch context.

import type { Sql } from "../../db/pool.js";
import { pushToBranch } from "./sse.js";
import type { SendResult } from "./mailer.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export interface NotificationRow {
  publicId?: string;
  type: string;
  message: string;
  orderId: string | null;
  isRead: boolean;
  createdAt: string;
}

/**
 * Create a branch-scoped in-app notification and push it to connected staff.
 * `run` must already be scoped to `branchId`'s context.
 */
export async function createBranchNotification(
  run: Run,
  branchId: string,
  input: { type: string; message: string; orderId?: string | null; userId?: string | null },
): Promise<void> {
  const row = await run(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO notifications (branch_id, user_id, type, order_id, message)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, type, message, order_id, is_read, created_at`,
      [branchId, input.userId ?? null, input.type, input.orderId ?? null, input.message],
    );
    return rows[0];
  });
  // Live push (best-effort; SSE clients may be none).
  pushToBranch(branchId, "notification", {
    type: row.type,
    message: row.message,
    orderId: row.order_id,
    createdAt: row.created_at,
  });
}

/** List notifications for the current staff principal's branch. Customer-
 *  targeted rows (customer_id set) are excluded — those belong to the
 *  portal bell only, never the staff/admin feed. */
export async function listNotifications(run: Run, opts: { unreadOnly?: boolean; limit?: number }): Promise<NotificationRow[]> {
  return run(async (sql) => {
    const conds = ["customer_id IS NULL"];
    if (opts.unreadOnly) conds.push("is_read = false");
    const { rows } = await sql.query(
      `SELECT id, type, message, order_id, is_read, created_at
         FROM notifications
        WHERE ${conds.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.min(opts.limit ?? 50, 200)],
    );
    return rows.map((r) => ({
      type: r.type, message: r.message, orderId: r.order_id,
      isRead: r.is_read, createdAt: r.created_at,
    }));
  });
}

export async function unreadCount(run: Run): Promise<number> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE is_read = false AND customer_id IS NULL",
    );
    return rows[0]?.n ?? 0;
  });
}

/** Mark all staff-facing notifications for the current branch read.
 *  Customer_id rows are excluded so this never touches a customer's own
 *  read state. */
export async function markAllRead(run: Run): Promise<number> {
  return run(async (sql) => {
    const r = await sql.query("UPDATE notifications SET is_read = true WHERE is_read = false AND customer_id IS NULL");
    return r.rowCount ?? 0;
  });
}

/** Record an email attempt in email_log. `run` scoped to branchId's context. */
export async function logEmail(
  run: Run,
  input: {
    branchId: string;
    orderId?: string | null;
    customerId?: string | null;
    toEmail: string;
    template: string;
    result: SendResult;
  },
): Promise<void> {
  await run(async (sql) => {
    const status = input.result.status === "sent" ? "sent"
      : input.result.status === "failed" ? "failed"
      : "queued"; // log-only => recorded as queued
    await sql.query(
      `INSERT INTO email_log (branch_id, order_id, customer_id, to_email, template, status, provider_id, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.branchId, input.orderId ?? null, input.customerId ?? null, input.toEmail,
       input.template, status, input.result.providerId ?? null, input.result.error ?? null],
    );
  });
}

// ── Customer-facing notifications ───────────────────────────────────────
// Same table, same shape as staff notifications — just a customer_id
// instead of user_id. Ownership is enforced by explicit customer_id filters
// below (NOT by RLS — see migration 0028's comment).

/**
 * Create a customer-scoped in-app notification. `run` must be scoped to
 * `branchId`'s context (same convention as createBranchNotification) — the
 * staff-side handler already has that via req.db!.
 */
export async function createCustomerNotification(
  run: Run,
  branchId: string,
  input: { customerId: string; type: string; message: string; orderId?: string | null },
): Promise<void> {
  await run(async (sql) => {
    await sql.query(
      `INSERT INTO notifications (branch_id, customer_id, type, order_id, message)
       VALUES ($1,$2,$3,$4,$5)`,
      [branchId, input.customerId, input.type, input.orderId ?? null, input.message],
    );
  });
}

/** List notifications for the current customer principal — explicitly
 *  filtered by customer_id, never relying on RLS alone (see 0028). */
export async function listCustomerNotifications(
  run: Run,
  customerId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  return run(async (sql) => {
    const conds = ["customer_id = $1"];
    if (opts.unreadOnly) conds.push("is_read = false");
    const { rows } = await sql.query(
      `SELECT id, type, message, order_id, is_read, created_at
         FROM notifications
        WHERE ${conds.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $2`,
      [customerId, Math.min(opts.limit ?? 50, 200)],
    );
    return rows.map((r) => ({
      type: r.type, message: r.message, orderId: r.order_id,
      isRead: r.is_read, createdAt: r.created_at,
    }));
  });
}

export async function customerUnreadCount(run: Run, customerId: string): Promise<number> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE customer_id = $1 AND is_read = false",
      [customerId],
    );
    return rows[0]?.n ?? 0;
  });
}

export async function markAllCustomerNotificationsRead(run: Run, customerId: string): Promise<number> {
  return run(async (sql) => {
    const r = await sql.query(
      "UPDATE notifications SET is_read = true WHERE customer_id = $1 AND is_read = false",
      [customerId],
    );
    return r.rowCount ?? 0;
  });
}