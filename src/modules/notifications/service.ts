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

/** List notifications for the current staff principal's branch. */
export async function listNotifications(run: Run, opts: { unreadOnly?: boolean; limit?: number }): Promise<NotificationRow[]> {
  return run(async (sql) => {
    const where = opts.unreadOnly ? "WHERE is_read = false" : "";
    const { rows } = await sql.query(
      `SELECT id, type, message, order_id, is_read, created_at
         FROM notifications ${where}
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
      "SELECT count(*)::int AS n FROM notifications WHERE is_read = false",
    );
    return rows[0]?.n ?? 0;
  });
}

/** Mark all notifications for the current branch read. */
export async function markAllRead(run: Run): Promise<number> {
  return run(async (sql) => {
    const r = await sql.query("UPDATE notifications SET is_read = true WHERE is_read = false");
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
