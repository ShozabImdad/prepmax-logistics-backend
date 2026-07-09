// Domain events + background worker (plan §9).
//
// Order lifecycle code emits ONE domain event (emitEvent) and returns
// immediately — the event is pushed onto an in-process async queue and handled
// by a background worker. This is the crucial non-blocking property: a slow
// SMTP relay can never delay order creation, and a failed send is retried with
// backoff instead of erroring the user's action.
//
// The queue is intentionally simple (in-process, no Redis). It's durable enough
// for a single-node deployment; if the platform later scales to multiple nodes,
// this module is the single place to swap in pg-boss/BullMQ without touching
// the lifecycle code that emits events.

import { pool } from "../../db/pool.js";
import type { Sql } from "../../db/pool.js";
import { sendEmail } from "./mailer.js";
import { renderCustomerEmail, type CustomerEmailTemplate } from "./email-templates.js";
import { createBranchNotification, logEmail } from "./service.js";

// ── Event types ─────────────────────────────────────────────────────────────
export type DomainEvent =
  | { kind: "order_created"; orderId: string; branchId: string; createdVia: "customer" | "staff" }
  | { kind: "order_approved"; orderId: string; branchId: string }
  | { kind: "order_activated"; orderId: string; branchId: string }
  | { kind: "order_delivered"; orderId: string; branchId: string }
  | { kind: "order_exception"; orderId: string; branchId: string; statusText: string };

interface QueueItem {
  event: DomainEvent;
  attempts: number;
}

const queue: QueueItem[] = [];
let draining = false;
const MAX_ATTEMPTS = 3;

/** Enqueue a domain event. Returns immediately (non-blocking). */
export function emitEvent(event: DomainEvent): void {
  queue.push({ event, attempts: 0 });
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        await handleEvent(item.event);
      } catch (err) {
        item.attempts++;
        if (item.attempts < MAX_ATTEMPTS) {
          // simple backoff: requeue after a delay
          const delay = 500 * 2 ** item.attempts;
          setTimeout(() => {
            queue.push(item);
            void drain();
          }, delay);
        } else {
          console.error(
            `[events] gave up on ${item.event.kind} after ${MAX_ATTEMPTS} attempts:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  } finally {
    draining = false;
  }
}

// Run DB work scoped to a branch (worker runs outside HTTP; trusted).
async function withBranch<T>(branchId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.branch_id', $1, true)", [branchId]);
    await client.query("SELECT set_config('app.is_super_admin', 'on', true)");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

interface OrderInfo {
  trackingCode: string;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
}

async function loadOrderInfo(sql: Sql, orderId: string): Promise<OrderInfo | null> {
  const { rows } = await sql.query(
    `SELECT o.tracking_code, o.customer_id, c.full_name AS customer_name, c.email AS customer_email
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [orderId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    trackingCode: r.tracking_code,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
  };
}

// Send a customer email + record it in email_log.
async function emailCustomer(
  branchId: string,
  orderId: string,
  info: OrderInfo,
  template: CustomerEmailTemplate,
  statusText?: string,
): Promise<void> {
  if (!info.customerEmail) return; // no customer / no address to email
  const { subject, html } = renderCustomerEmail(template, {
    customerName: info.customerName ?? "Customer",
    trackingCode: info.trackingCode,
    statusText,
  });
  const result = await sendEmail({ to: info.customerEmail, subject, html });
  await withBranch(branchId, (sql) =>
    logEmail((fn) => fn(sql), {
      branchId, orderId, customerId: info.customerId, toEmail: info.customerEmail!,
      template, result,
    }),
  );
}

// ── Event handling (the actual notification/email work) ─────────────────────
async function handleEvent(event: DomainEvent): Promise<void> {
  switch (event.kind) {
    case "order_created": {
      const info = await withBranch(event.branchId, (sql) => loadOrderInfo(sql, event.orderId));
      if (!info) return;
      if (event.createdVia === "customer") {
        // Admin in-app alert: a new booking request needs review.
        await withBranch(event.branchId, (sql) =>
          createBranchNotification((fn) => fn(sql), event.branchId, {
            type: "booking_request",
            message: `New booking request ${info.trackingCode} from ${info.customerName ?? "a customer"}`,
            orderId: event.orderId,
          }),
        );
        // Customer confirmation: request received.
        await emailCustomer(event.branchId, event.orderId, info, "booking_received");
      } else {
        // Staff-created order: confirm to customer if one is attached.
        await emailCustomer(event.branchId, event.orderId, info, "order_confirmed");
      }
      return;
    }
    case "order_approved":
    case "order_activated": {
      const info = await withBranch(event.branchId, (sql) => loadOrderInfo(sql, event.orderId));
      if (!info) return;
      await emailCustomer(event.branchId, event.orderId, info, "order_confirmed");
      return;
    }
    case "order_delivered": {
      const info = await withBranch(event.branchId, (sql) => loadOrderInfo(sql, event.orderId));
      if (!info) return;
      await emailCustomer(event.branchId, event.orderId, info, "delivered");
      return;
    }
    case "order_exception": {
      const info = await withBranch(event.branchId, (sql) => loadOrderInfo(sql, event.orderId));
      if (!info) return;
      // Admin alert + customer email.
      await withBranch(event.branchId, (sql) =>
        createBranchNotification((fn) => fn(sql), event.branchId, {
          type: "exception",
          message: `Shipment ${info.trackingCode} exception: ${event.statusText}`,
          orderId: event.orderId,
        }),
      );
      await emailCustomer(event.branchId, event.orderId, info, "exception", event.statusText);
      return;
    }
  }
}

/** For tests: wait until the queue is fully drained. */
export async function waitForQueueDrain(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while ((queue.length > 0 || draining) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
