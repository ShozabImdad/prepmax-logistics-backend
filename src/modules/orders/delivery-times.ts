// Delivery-time lookup for computing an order's estimated delivery window.
//
// Previously this held hardcoded Direct / Via / By Sea tables mirroring the
// admin frontend's OrderForm.tsx. As of migration 0042_couriers, the
// courier catalog (category, name, min/max days) is dynamic and editable via
// Settings → Couriers, so this now reads from the `couriers` table instead —
// the single source of truth the picker and this estimate both use.
//
// `orders.service_type` is stored as "<Category> — <Option>" (see
// encodeServiceType() in OrderForm.tsx), e.g. "Direct — Skynet".

import type { Sql } from "../../db/pool.js";

export interface DeliveryRange {
  minDays: number;
  maxDays: number;
}

/**
 * Decode a stored `service_type` string ("Direct — Skynet") and look up its
 * delivery range from the couriers catalog. Returns null if the string
 * doesn't match a known category/option (e.g. legacy free-text values,
 * unset, or a courier that's since been deleted).
 *
 * Runs on the same `sql` connection as the caller (usually already inside a
 * transaction via the request's branch-context runner) — `couriers` is a
 * global table with no RLS, so this works the same regardless of branch.
 */
export async function lookupDeliveryRange(
  sql: Sql,
  serviceType: string | null | undefined,
): Promise<DeliveryRange | null> {
  if (!serviceType) return null;
  const [category, name] = serviceType.split(" — ");
  if (!category || !name) return null;

  const { rows } = await sql.query<{ min_days: number; max_days: number }>(
    "SELECT min_days, max_days FROM couriers WHERE category = $1 AND name = $2",
    [category, name],
  );
  if (!rows[0]) return null;
  return { minDays: rows[0].min_days, maxDays: rows[0].max_days };
}
