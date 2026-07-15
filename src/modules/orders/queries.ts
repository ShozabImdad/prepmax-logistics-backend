// Order read/mutation operations beyond creation: approve, attach legs, list,
// detail. All run through the request's branch-context runner (RLS applied).

import type { Sql } from "../../db/pool.js";
import { OrderError, attachLegsInTx, insertBoxesAndItems } from "./service.js";
import type { LegInput, EditOrderInput } from "./schema.js";
import { redactCarrier } from "../tracking/sanitize.js";

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
 * Permanently delete an order. Boxes, box_items, shipment_legs, and
 * tracking_events all ON DELETE CASCADE from orders, so this one statement
 * removes the whole order graph. Runs in the branch context (RLS applies).
 */
export async function deleteOrder(run: Run, orderPublicId: string): Promise<void> {
  await run(async (sql) => {
    const order = await findOrderIdByPublicId(sql, orderPublicId);
    if (!order) throw new OrderError(404, "Order not found");
    await sql.query("DELETE FROM orders WHERE id = $1", [order.id]);
  });
}

/**
 * Edit an order. Updates only the fields provided; when `boxes` is provided it
 * replaces ALL boxes + items (recomputing volumetric/chargeable weight and the
 * declared total). Runs in the branch context (RLS applies).
 */
export async function editOrder(
  run: Run,
  orderPublicId: string,
  input: EditOrderInput,
  divisorFallback = 5000,
): Promise<void> {
  await run(async (sql) => {
    const order = await findOrderIdByPublicId(sql, orderPublicId);
    if (!order) throw new OrderError(404, "Order not found");

    // Build a dynamic SET clause from provided fields. Map camelCase → column.
    const set: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };

    const s = input.sender;
    if (s) {
      if (s.name !== undefined) push("sender_name", s.name || null);
      if (s.company !== undefined) push("sender_company", s.company || null);
      if (s.phone !== undefined) push("sender_phone", s.phone || null);
      if (s.email !== undefined) push("sender_email", s.email || null);
      if (s.cnic !== undefined) push("sender_cnic", s.cnic || null);
      if (s.ntn !== undefined) push("sender_ntn", s.ntn || null);
      if (s.address !== undefined) push("sender_address", s.address || null);
      if (s.address2 !== undefined) push("sender_address2", s.address2 || null);
      if (s.city !== undefined) push("sender_city", s.city || null);
      if (s.state !== undefined) push("sender_state", s.state || null);
      if (s.country !== undefined) push("sender_country", s.country || null);
      if (s.postcode !== undefined) push("sender_postcode", s.postcode || null);
    }
    const r = input.receiver;
    if (r) {
      if (r.name !== undefined) push("receiver_name", r.name || null);
      if (r.company !== undefined) push("receiver_company", r.company || null);
      if (r.phone !== undefined) push("receiver_phone", r.phone || null);
      if (r.email !== undefined) push("receiver_email", r.email || null);
      if (r.cnic !== undefined) push("receiver_cnic", r.cnic || null);
      if (r.address !== undefined) push("receiver_address", r.address || null);
      if (r.address2 !== undefined) push("receiver_address2", r.address2 || null);
      if (r.city !== undefined) push("receiver_city", r.city || null);
      if (r.state !== undefined) push("receiver_state", r.state || null);
      if (r.country !== undefined) push("receiver_country", r.country || null);
      if (r.postcode !== undefined) push("receiver_postcode", r.postcode || null);
    }
    if (input.originCountry !== undefined) push("origin_country", input.originCountry || null);
    if (input.destinationCountry !== undefined) push("destination_country", input.destinationCountry || null);
    if (input.serviceType !== undefined) push("service_type", input.serviceType || null);
    if (input.serviceLevel !== undefined) push("service_level", input.serviceLevel || null);
    if (input.contentsNature !== undefined) push("contents_nature", input.contentsNature || null);
    if (input.duties !== undefined) push("duties", input.duties || null);
    if (input.handlingFlags !== undefined) push("handling_flags", input.handlingFlags);
    if (input.notes !== undefined) push("notes", input.notes || null);
    if (input.price !== undefined) push("price", input.price ?? null);
    if (input.priceCurrency !== undefined) push("price_currency", input.priceCurrency || null);
    if (input.paymentStatus !== undefined) push("payment_status", input.paymentStatus);
    if (input.amountPaid !== undefined) push("amount_paid", input.amountPaid ?? 0);
    if (input.declaredCurrency !== undefined) push("declared_currency", input.declaredCurrency || null);

    // If boxes are being replaced, recompute the declared total from them.
    if (input.boxes) {
      const declaredTotal = input.boxes.reduce(
        (sum, b) => sum + (b.items ?? []).reduce((s2, it) => s2 + (it.unitValue ?? 0) * (it.quantity ?? 1), 0),
        0,
      );
      push("declared_total", declaredTotal || null);
    }

    if (set.length > 0) {
      vals.push(order.id);
      await sql.query(`UPDATE orders SET ${set.join(", ")} WHERE id = $${vals.length}`, vals);
    }

    // Replace boxes + items if provided.
    if (input.boxes) {
      const divisor = await branchDivisor(sql, order.branch_id, divisorFallback);
      await sql.query("DELETE FROM boxes WHERE order_id = $1", [order.id]); // cascades items
      await insertBoxesAndItems(sql, order.id, order.branch_id, input.boxes, divisor);
    }
  });
}

async function branchDivisor(sql: Sql, branchId: string, fallback: number): Promise<number> {
  const { rows } = await sql.query<{ volumetric_divisor: number }>(
    "SELECT volumetric_divisor FROM branches WHERE id = $1",
    [branchId],
  );
  return rows[0]?.volumetric_divisor ?? fallback;
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

/**
 * Edit an existing carrier leg (identified by order publicId + leg sequence).
 * Staff can correct the carrier and/or tracking number they entered. When the
 * carrier or tracking number changes, that leg's previously-fetched tracking
 * events are stale (they belonged to a different shipment), so we clear them —
 * the next sync repopulates from the corrected number.
 */
export async function editLeg(
  run: Run,
  orderPublicId: string,
  sequence: number,
  patch: { carrier?: string; trackingNumber?: string },
): Promise<{ orderId: string; branchId: string; cleared: boolean }> {
  return run(async (sql) => {
    const order = await findOrderIdByPublicId(sql, orderPublicId);
    if (!order) throw new OrderError(404, "Order not found");

    const legRes = await sql.query<{ id: string; carrier: string; carrier_tracking_number: string }>(
      "SELECT id, carrier, carrier_tracking_number FROM shipment_legs WHERE order_id = $1 AND sequence = $2",
      [order.id, sequence],
    );
    const leg = legRes.rows[0];
    if (!leg) throw new OrderError(404, "Carrier leg not found");

    const newCarrier = patch.carrier ?? leg.carrier;
    const newTracking = patch.trackingNumber ?? leg.carrier_tracking_number;
    if (!newTracking.trim()) throw new OrderError(400, "Tracking number cannot be empty");

    const changed = newCarrier !== leg.carrier || newTracking !== leg.carrier_tracking_number;
    if (!changed) return { orderId: order.id, branchId: order.branch_id, cleared: false };

    await sql.query(
      "UPDATE shipment_legs SET carrier = $1, carrier_tracking_number = $2 WHERE id = $3",
      [newCarrier, newTracking.trim(), leg.id],
    );
    // Old events are for the previous number → clear them; next sync refills.
    await sql.query("DELETE FROM tracking_events WHERE shipment_leg_id = $1", [leg.id]);
    return { orderId: order.id, branchId: order.branch_id, cleared: true };
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
  createdVia: string;           // "customer" | "staff" — flags booking requests
  createdAt: string;
}

/**
 * List orders. Branch scoping is automatic via RLS. For a customer, we also
 * restrict to their own orders (ownership, not just branch). `mine` carries the
 * customer's id when the caller is a customer.
 */
export async function listOrders(
  run: Run,
  opts: { customerId?: string; status?: string; createdVia?: string; search?: string; limit?: number; offset?: number },
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
    if (opts.createdVia) {
      params.push(opts.createdVia);
      conds.push(`created_via = $${params.length}`);
    }
    const search = opts.search?.trim();
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      // Match across tracking, AWB, both parties' names/companies, and the
      // origin/destination location fields — one ILIKE pattern reused for all.
      conds.push(`(
        tracking_code ILIKE ${p}
        OR COALESCE(awb_number, '') ILIKE ${p}
        OR COALESCE(receiver_name, '') ILIKE ${p}
        OR COALESCE(receiver_company, '') ILIKE ${p}
        OR COALESCE(receiver_city, '') ILIKE ${p}
        OR COALESCE(receiver_country, '') ILIKE ${p}
        OR COALESCE(sender_name, '') ILIKE ${p}
        OR COALESCE(sender_company, '') ILIKE ${p}
        OR COALESCE(sender_city, '') ILIKE ${p}
        OR COALESCE(sender_country, '') ILIKE ${p}
      )`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(Math.min(opts.limit ?? 50, 200));
    const limitIdx = params.length;
    params.push(opts.offset ?? 0);
    const offsetIdx = params.length;

    const { rows } = await sql.query(
      `SELECT public_id, tracking_code, order_status, current_status,
              receiver_city, receiver_country, created_via, created_at
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
      createdVia: r.created_via,
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
      `SELECT id, label, parcel_type, weight_kg, length_cm, width_cm, height_cm, volumetric_kg, chargeable_kg, sequence
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
      parcelType: b.parcel_type,
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
      // Customers must not see the real carrier; the cached status text is a
      // carrier event string, so redact it for the portal (staff see it raw).
      currentStatusText: opts.forCustomer
        ? redactCarrier(order.current_status_text)
        : order.current_status_text,
      lastSyncedAt: order.last_synced_at,
      sender: opts.forCustomer ? undefined : {
        name: order.sender_name, company: order.sender_company, phone: order.sender_phone,
        email: order.sender_email, cnic: order.sender_cnic, ntn: order.sender_ntn,
        address: order.sender_address, address2: order.sender_address2, city: order.sender_city,
        state: order.sender_state, country: order.sender_country, postcode: order.sender_postcode,
      },
      receiver: {
        name: order.receiver_name, city: order.receiver_city, country: order.receiver_country,
        // full receiver contact only for staff
        ...(opts.forCustomer ? {} : {
          company: order.receiver_company, phone: order.receiver_phone, email: order.receiver_email,
          cnic: order.receiver_cnic, address: order.receiver_address, address2: order.receiver_address2,
          state: order.receiver_state, postcode: order.receiver_postcode,
        }),
      },
      originCountry: order.origin_country,
      destinationCountry: order.destination_country,
      serviceType: order.service_type,
      serviceLevel: order.service_level,
      contentsNature: order.contents_nature,
      declaredTotal: order.declared_total != null ? Number(order.declared_total) : null,
      declaredCurrency: order.declared_currency,
      duties: order.duties,
      handlingFlags: order.handling_flags,
      boxes: boxesOut,
      pieceCount: boxesOut.length,
      totalChargeableKg: Number(
        boxesOut.reduce((s, b) => s + (b.chargeableKg as number), 0).toFixed(3),
      ),
      // For customers, redact carrier branding from the event text (location +
      // description) and hide the carrier field entirely. Staff see it raw.
      trackingEvents: events.rows.map((e) => ({
        time: e.event_time, timeRaw: e.event_time_raw,
        location: opts.forCustomer ? redactCarrier(e.location) : e.location,
        description: opts.forCustomer
          ? (redactCarrier(e.description) ?? "Shipment update")
          : e.description,
        carrier: opts.forCustomer ? undefined : e.carrier,
        leg: e.sequence,
      })),
      createdAt: order.created_at,
    };

    if (!opts.forCustomer) {
      base.awbNumber = order.awb_number;
      base.createdVia = order.created_via;
      // pricing / finance (staff only)
      base.price = order.price != null ? Number(order.price) : null;
      base.priceCurrency = order.price_currency;
      base.paymentStatus = order.payment_status;
      base.amountPaid = order.amount_paid != null ? Number(order.amount_paid) : null;
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
