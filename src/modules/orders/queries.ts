// Order read/mutation operations beyond creation: approve, attach legs, list,
// detail. All run through the request's branch-context runner (RLS applied).

import type { Sql } from "../../db/pool.js";
import { OrderError, attachLegsInTx } from "./service.js";
import type { LegInput } from "./schema.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

/** Resolve an order's internal id from its public id, respecting RLS/context. */
export async function resolveOrderId(run: Run, orderPublicId: string): Promise<string | null> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ id: string }>(
      "SELECT id FROM orders WHERE public_id = $1",
      [orderPublicId],
    );
    return rows[0]?.id ?? null;
  });
}

async function findOrderIdByPublicId(sql: Sql, orderPublicId: string): Promise<{ id: string; branch_id: string; order_status: string; customer_id: string | null } | null> {
  const { rows } = await sql.query<{ id: string; branch_id: string; order_status: string; customer_id: string | null }>(
    "SELECT id, branch_id, order_status, customer_id FROM orders WHERE public_id = $1",
    [orderPublicId],
  );
  return rows[0] ?? null;
}

/**
 * Approve a customer booking request: pending_approval -> awaiting_carrier.
 * Only meaningful for customer-created orders awaiting review.
 */
export async function approveOrder(run: Run, orderPublicId: string, approverUserId: string): Promise<{ orderId: string; branchId: string }> {
  return run(async (sql) => {
    const order = await findOrderIdByPublicId(sql, orderPublicId);
    if (!order) throw new OrderError(404, "Order not found");
    if (order.order_status !== "pending_approval") {
      throw new OrderError(409, `Order is not pending approval (status: ${order.order_status})`);
    }
    await sql.query(
      "UPDATE orders SET order_status = 'awaiting_carrier', approved_by = $2 WHERE id = $1",
      [order.id, approverUserId],
    );
    return { orderId: order.id, branchId: order.branch_id };
  });
}

/** Cancel an order. */
export async function cancelOrder(run: Run, orderPublicId: string): Promise<void> {
  await run(async (sql) => {
    const order = await findOrderIdByPublicId(sql, orderPublicId);
    if (!order) throw new OrderError(404, "Order not found");
    if (order.order_status === "delivered") throw new OrderError(409, "Delivered orders cannot be cancelled");
    await sql.query("UPDATE orders SET order_status = 'cancelled' WHERE id = $1", [order.id]);
  });
}

/**
 * Attach one or more carrier legs to an existing order (plan §6: at creation
 * OR later). When the first leg is attached and the order is awaiting_carrier,
 * it moves to 'active' (tracking begins). Max 2 legs total.
 */
export async function attachLegs(run: Run, orderPublicId: string, legs: LegInput[]): Promise<{ orderStatus: string; legCount: number; orderId: string; branchId: string; justActivated: boolean }> {
  return run(async (sql) => {
    const order = await findOrderIdByPublicId(sql, orderPublicId);
    if (!order) throw new OrderError(404, "Order not found");
    if (order.order_status === "pending_approval") {
      throw new OrderError(409, "Approve the order before attaching a carrier");
    }
    if (order.order_status === "cancelled") throw new OrderError(409, "Order is cancelled");

    const existing = await sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM shipment_legs WHERE order_id = $1",
      [order.id],
    );
    const currentCount = existing.rows[0]!.n;
    if (currentCount + legs.length > 2) {
      throw new OrderError(400, "An order can have at most 2 carrier legs");
    }

    await attachLegsInTx(sql, order.id, order.branch_id, legs);

    // First leg activates tracking.
    let newStatus = order.order_status;
    let justActivated = false;
    if (order.order_status === "awaiting_carrier") {
      await sql.query("UPDATE orders SET order_status = 'active' WHERE id = $1", [order.id]);
      newStatus = "active";
      justActivated = true;
    }
    return { orderStatus: newStatus, legCount: currentCount + legs.length, orderId: order.id, branchId: order.branch_id, justActivated };
  });
}

// ── Read views ──────────────────────────────────────────────────────────────

export interface OrderListRow {
  publicId: string;
  trackingCode: string;
  orderStatus: string;
  currentStatus: string | null;
  receiverCity: string | null;
  receiverCountry: string | null;
  createdAt: string;
}

/**
 * List orders. Branch scoping is automatic via RLS. For a customer, we also
 * restrict to their own orders (ownership, not just branch). `mine` carries the
 * customer's id when the caller is a customer.
 */
export async function listOrders(
  run: Run,
  opts: { customerId?: string; status?: string; limit?: number; offset?: number },
): Promise<OrderListRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.customerId) {
      params.push(opts.customerId);
      conds.push(`customer_id = $${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      conds.push(`order_status = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(Math.min(opts.limit ?? 50, 200));
    const limitIdx = params.length;
    params.push(opts.offset ?? 0);
    const offsetIdx = params.length;

    const { rows } = await sql.query(
      `SELECT public_id, tracking_code, order_status, current_status,
              receiver_city, receiver_country, created_at
         FROM orders ${where}
         ORDER BY created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return rows.map((r) => ({
      publicId: r.public_id,
      trackingCode: r.tracking_code,
      orderStatus: r.order_status,
      currentStatus: r.current_status,
      receiverCity: r.receiver_city,
      receiverCountry: r.receiver_country,
      createdAt: r.created_at,
    }));
  });
}

/**
 * Full order detail with boxes, items, and legs. `forCustomer` strips internal
 * fields (declared cost basis stays, but created_by / carrier tracking numbers
 * are hidden from customers per plan §5).
 */
export async function getOrderDetail(
  run: Run,
  orderPublicId: string,
  opts: { customerId?: string; forCustomer: boolean },
): Promise<Record<string, unknown> | null> {
  return run(async (sql) => {
    const conds = ["public_id = $1"];
    const params: unknown[] = [orderPublicId];
    if (opts.customerId) {
      params.push(opts.customerId);
      conds.push(`customer_id = $${params.length}`);
    }
    const { rows } = await sql.query(
      `SELECT * FROM orders WHERE ${conds.join(" AND ")}`,
      params,
    );
    const order = rows[0];
    if (!order) return null;

    const boxes = await sql.query(
      `SELECT id, label, weight_kg, length_cm, width_cm, height_cm, volumetric_kg, chargeable_kg, sequence
         FROM boxes WHERE order_id = $1 ORDER BY sequence`,
      [order.id],
    );
    const boxIds = boxes.rows.map((b) => b.id);
    const items = boxIds.length
      ? await sql.query(
          `SELECT box_id, description, quantity, unit_value, hs_code, country_of_origin
             FROM box_items WHERE box_id = ANY($1)`,
          [boxIds],
        )
      : { rows: [] as Record<string, unknown>[] };
    const legs = await sql.query(
      `SELECT carrier, carrier_tracking_number, sequence, is_active
         FROM shipment_legs WHERE order_id = $1 ORDER BY sequence`,
      [order.id],
    );
    const events = await sql.query(
      `SELECT te.event_time, te.event_time_raw, te.location, te.description, sl.carrier, sl.sequence
         FROM tracking_events te
         JOIN shipment_legs sl ON sl.id = te.shipment_leg_id
        WHERE sl.order_id = $1
        ORDER BY te.event_time DESC NULLS LAST, te.created_at DESC`,
      [order.id],
    );

    const boxesOut = boxes.rows.map((b) => ({
      label: b.label,
      weightKg: Number(b.weight_kg),
      lengthCm: Number(b.length_cm),
      widthCm: Number(b.width_cm),
      heightCm: Number(b.height_cm),
      volumetricKg: Number(b.volumetric_kg),
      chargeableKg: Number(b.chargeable_kg),
      items: items.rows
        .filter((it) => it.box_id === b.id)
        .map((it) => ({
          description: it.description,
          quantity: it.quantity,
          unitValue: it.unit_value != null ? Number(it.unit_value) : null,
          hsCode: it.hs_code,
          countryOfOrigin: it.country_of_origin,
        })),
    }));

    const base: Record<string, unknown> = {
      publicId: order.public_id,
      trackingCode: order.tracking_code,
      orderStatus: order.order_status,
      currentStatus: order.current_status,
      currentStatusText: order.current_status_text,
      lastSyncedAt: order.last_synced_at,
      sender: opts.forCustomer ? undefined : {
        name: order.sender_name, company: order.sender_company, phone: order.sender_phone,
        email: order.sender_email, address: order.sender_address, city: order.sender_city,
        country: order.sender_country, postcode: order.sender_postcode,
      },
      receiver: {
        name: order.receiver_name, city: order.receiver_city, country: order.receiver_country,
        // full receiver contact only for staff
        ...(opts.forCustomer ? {} : {
          company: order.receiver_company, phone: order.receiver_phone, email: order.receiver_email,
          address: order.receiver_address, postcode: order.receiver_postcode,
        }),
      },
      serviceType: order.service_type,
      contentsNature: order.contents_nature,
      declaredValue: order.declared_value != null ? Number(order.declared_value) : null,
      currency: order.currency,
      duties: order.duties,
      handlingFlags: order.handling_flags,
      boxes: boxesOut,
      pieceCount: boxesOut.length,
      totalChargeableKg: Number(
        boxesOut.reduce((s, b) => s + (b.chargeableKg as number), 0).toFixed(3),
      ),
      trackingEvents: events.rows.map((e) => ({
        time: e.event_time, timeRaw: e.event_time_raw, location: e.location,
        description: e.description, carrier: opts.forCustomer ? undefined : e.carrier,
        leg: e.sequence,
      })),
      createdAt: order.created_at,
    };

    if (!opts.forCustomer) {
      base.awbNumber = order.awb_number;
      base.createdVia = order.created_via;
      base.legs = legs.rows.map((l) => ({
        carrier: l.carrier, trackingNumber: l.carrier_tracking_number,
        sequence: l.sequence, isActive: l.is_active,
      }));
      base.notes = order.notes;
    } else {
      // Customer sees leg presence but NOT the raw carrier tracking numbers.
      base.legs = legs.rows.map((l) => ({ sequence: l.sequence, isActive: l.is_active }));
    }
    return base;
  });
}
