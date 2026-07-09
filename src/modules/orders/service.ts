// Order service — creation, approval, legs, listing, detail.
//
// All DB work runs through `run` (the request's branch-context runner from
// req.db), so RLS enforces branch isolation on every statement. Creation is
// atomic: order + boxes + items + optional legs are inserted in one
// transaction (req.db already wraps the callback in a transaction).

import type { Sql } from "../../db/pool.js";
import { publicId, trackingCode, awbNumber } from "../../lib/ids.js";
import { computeBoxWeights } from "../../lib/weight.js";
import type { CreateOrderInput, BoxInput, LegInput } from "./schema.js";

export type Creator =
  | { kind: "customer"; customerId: string; branchId: string }
  | { kind: "staff"; role: "super_admin" | "branch_manager"; userId: string; branchId: string | null };

export class OrderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Resolve which branch + customer an order belongs to, per the creator's role.
async function resolveBranchAndCustomer(
  sql: Sql,
  creator: Creator,
  input: CreateOrderInput,
): Promise<{ branchId: string; customerId: string | null; createdVia: "customer" | "staff" }> {
  if (creator.kind === "customer") {
    // Customer orders always go to the customer's own branch, for themselves.
    return { branchId: creator.branchId, customerId: creator.customerId, createdVia: "customer" };
  }

  // Staff: determine the branch.
  let branchId: string;
  if (creator.role === "branch_manager") {
    branchId = creator.branchId!;
  } else {
    // super_admin must name the branch.
    if (!input.branchPublicId) throw new OrderError(400, "branchPublicId is required for super-admin");
    const b = await sql.query<{ id: string }>("SELECT id FROM branches WHERE public_id = $1", [
      input.branchPublicId,
    ]);
    if (!b.rows[0]) throw new OrderError(404, "Branch not found");
    branchId = b.rows[0].id;
  }

  // Optional customer link.
  let customerId: string | null = null;
  if (input.customerPublicId) {
    const c = await sql.query<{ id: string }>(
      "SELECT id FROM customers WHERE public_id = $1 AND branch_id = $2",
      [input.customerPublicId, branchId],
    );
    if (!c.rows[0]) throw new OrderError(404, "Customer not found in this branch");
    customerId = c.rows[0].id;
  }
  return { branchId, customerId, createdVia: "staff" };
}

async function branchDivisor(sql: Sql, branchId: string): Promise<number> {
  const { rows } = await sql.query<{ volumetric_divisor: number }>(
    "SELECT volumetric_divisor FROM branches WHERE id = $1",
    [branchId],
  );
  return rows[0]?.volumetric_divisor ?? 5000;
}

async function insertBoxesAndItems(
  sql: Sql,
  orderId: string,
  branchId: string,
  boxes: BoxInput[],
  divisor: number,
): Promise<void> {
  let seq = 0;
  for (const box of boxes) {
    const w = computeBoxWeights(
      { weightKg: box.weightKg, lengthCm: box.lengthCm, widthCm: box.widthCm, heightCm: box.heightCm },
      divisor,
    );
    const { rows } = await sql.query<{ id: string }>(
      `INSERT INTO boxes (order_id, branch_id, label, weight_kg, length_cm, width_cm, height_cm,
                          volumetric_kg, chargeable_kg, sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [orderId, branchId, box.label ?? null, box.weightKg, box.lengthCm, box.widthCm, box.heightCm,
       w.volumetricKg, w.chargeableKg, seq++],
    );
    const boxId = rows[0]!.id;
    for (const item of box.items) {
      await sql.query(
        `INSERT INTO box_items (box_id, branch_id, description, quantity, unit_value, hs_code, country_of_origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [boxId, branchId, item.description, item.quantity, item.unitValue ?? null,
         item.hsCode ?? null, item.countryOfOrigin ?? null],
      );
    }
  }
}

/**
 * Create an order (+ boxes, items, optional legs). Returns the new order's
 * public id + tracking code. Runs inside `run` (branch context / transaction).
 *
 * Status rules (plan §5/§6):
 *   - customer-created  -> 'pending_approval'
 *   - staff-created     -> 'awaiting_carrier' (they are the approver)
 * Legs may be attached now or later; customers may not attach legs.
 */
export async function createOrder(
  run: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
  creator: Creator,
  input: CreateOrderInput,
): Promise<{ publicId: string; trackingCode: string; orderStatus: string; orderId: string; branchId: string; createdVia: "customer" | "staff" }> {
  if (creator.kind === "customer" && input.legs && input.legs.length > 0) {
    throw new OrderError(403, "Customers cannot attach carrier legs");
  }

  return run(async (sql) => {
    const { branchId, customerId, createdVia } = await resolveBranchAndCustomer(sql, creator, input);
    const divisor = await branchDivisor(sql, branchId);

    const orderStatus = createdVia === "customer" ? "pending_approval" : "awaiting_carrier";
    const createdBy = creator.kind === "staff" ? creator.userId : null;

    const s = input.sender;
    const r = input.receiver;
    const { rows } = await sql.query<{ id: string; public_id: string; tracking_code: string }>(
      `INSERT INTO orders (
          public_id, tracking_code, awb_number, branch_id, customer_id,
          order_status, created_via,
          sender_name, sender_company, sender_phone, sender_email,
          sender_address, sender_city, sender_country, sender_postcode,
          receiver_name, receiver_company, receiver_phone, receiver_email,
          receiver_address, receiver_city, receiver_country, receiver_postcode,
          service_type, contents_nature, declared_value, currency, duties,
          handling_flags, notes, created_by
       ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          $8,$9,$10,$11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23,
          $24,$25,$26,$27,$28,$29,$30,$31
       ) RETURNING id, public_id, tracking_code`,
      [
        publicId(), trackingCode(), awbNumber(), branchId, customerId,
        orderStatus, createdVia,
        s.name ?? null, s.company ?? null, s.phone ?? null, s.email || null,
        s.address ?? null, s.city ?? null, s.country ?? null, s.postcode ?? null,
        r.name ?? null, r.company ?? null, r.phone ?? null, r.email || null,
        r.address ?? null, r.city ?? null, r.country ?? null, r.postcode ?? null,
        input.serviceType ?? null, input.contentsNature ?? null, input.declaredValue ?? null,
        input.currency, input.duties ?? null, input.handlingFlags, input.notes ?? null, createdBy,
      ],
    );
    const order = rows[0]!;

    await insertBoxesAndItems(sql, order.id, branchId, input.boxes, divisor);

    // Optional legs at creation (staff only, already guarded above).
    if (input.legs && input.legs.length > 0) {
      await attachLegsInTx(sql, order.id, branchId, input.legs);
    }

    return {
      publicId: order.public_id, trackingCode: order.tracking_code, orderStatus,
      orderId: order.id, branchId, createdVia,
    };
  });
}

// Insert legs for an order (used at creation and by the standalone attach route).
async function attachLegsInTx(
  sql: Sql,
  orderId: string,
  branchId: string,
  legs: LegInput[],
): Promise<void> {
  // Determine the next sequence number for this order.
  const { rows } = await sql.query<{ max: number | null }>(
    "SELECT max(sequence) AS max FROM shipment_legs WHERE order_id = $1",
    [orderId],
  );
  let seq = (rows[0]?.max ?? 0) + 1;
  for (const leg of legs) {
    await sql.query(
      `INSERT INTO shipment_legs (order_id, branch_id, carrier, carrier_tracking_number, sequence, is_active)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orderId, branchId, leg.carrier, leg.trackingNumber, seq, seq === 1],
    );
    seq++;
  }
}

export { attachLegsInTx };
