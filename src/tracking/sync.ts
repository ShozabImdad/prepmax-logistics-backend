// Tracking sync — the bridge between the carrier adapters and the database.
//
// syncOrder(orderId): for one order, picks its ACTIVE shipment leg, calls the
// matching adapter, writes any NEW normalized events into tracking_events, and
// updates the cached current_status / current_status_text / last_synced_at on
// the order. Idempotent: events are de-duplicated by a stable key so
// re-polling never creates duplicates.
//
// The poller runs outside HTTP requests, so it uses withSystemTx (a transaction
// that sets the branch context to the order's own branch — RLS still applies,
// scoped to that order's branch). This is the controlled elevated path from the
// architecture plan §1, used only by the trusted background poller.

import type { Sql } from "../db/pool.js";
import { pool } from "../db/pool.js";
import { resolveAdapter } from "./adapters/index.js";
import { detectHandoff } from "./adapters/handoff.js";
import type { NormalizedTracking, TrackingEvent } from "./adapters/types.js";

// Terminal statuses we stop polling.
export const TERMINAL_STATUSES = new Set(["delivered"]);

export interface SyncResult {
  orderId: string;
  carrier: string | null;
  status: "no_active_leg" | "not_found" | "synced" | "error";
  normalizedStatus?: string;
  newEvents?: number;
  handoffCreated?: string | null; // carrier of an auto-created leg, if any
  error?: string;
}

interface ActiveLeg {
  legId: string;
  orderId: string;
  branchId: string;
  carrier: string;
  trackingNumber: string;
  sequence: number;
}

/**
 * Run a callback in a transaction scoped to a specific branch's context.
 * The poller is trusted (not a user), so it sets the branch context directly
 * for the order it's working on. RLS still constrains writes to that branch.
 */
async function withOrderBranchTx<T>(branchId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.branch_id', $1, true)", [branchId]);
    // poller acts as super-admin within the single branch context so it can
    // read/write freely for that branch (still filtered to this branch_id).
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

// Build a stable de-dupe key for an event within a leg.
function eventKey(e: TrackingEvent): string {
  const ts = e.timestamp ?? "";
  return `${ts}|${e.location ?? ""}|${e.description}`;
}

async function getActiveLeg(sql: Sql, orderId: string): Promise<ActiveLeg | null> {
  // Prefer the leg marked is_active; else the highest sequence.
  const { rows } = await sql.query(
    `SELECT id, order_id, branch_id, carrier, carrier_tracking_number, sequence
       FROM shipment_legs
      WHERE order_id = $1
      ORDER BY is_active DESC, sequence DESC
      LIMIT 1`,
    [orderId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    legId: r.id, orderId: r.order_id, branchId: r.branch_id,
    carrier: r.carrier, trackingNumber: r.carrier_tracking_number, sequence: r.sequence,
  };
}

async function writeEvents(sql: Sql, leg: ActiveLeg, result: NormalizedTracking): Promise<number> {
  // Load existing event keys for this leg to avoid duplicates.
  const existing = await sql.query<{ event_time: Date | null; event_time_raw: string | null; location: string | null; description: string }>(
    `SELECT event_time, event_time_raw, location, description FROM tracking_events WHERE shipment_leg_id = $1`,
    [leg.legId],
  );
  const seen = new Set(
    existing.rows.map((r) => `${(r.event_time_raw ?? r.event_time?.toISOString()) ?? ""}|${r.location ?? ""}|${r.description}`),
  );

  let inserted = 0;
  for (const ev of result.events) {
    const key = eventKey(ev);
    if (seen.has(key)) continue;
    // Try to parse the timestamp into a real instant; keep the raw string too
    // for timezone-ambiguous carriers (DPD/APX/SkyNet).
    const parsed = ev.timestamp ? new Date(ev.timestamp) : null;
    const validTime = parsed && !isNaN(parsed.getTime()) ? parsed : null;
    await sql.query(
      `INSERT INTO tracking_events (shipment_leg_id, branch_id, event_time, event_time_raw, location, description, raw_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [leg.legId, leg.branchId, validTime, ev.timestamp ?? null, ev.location, ev.description, result.statusText],
    );
    seen.add(key);
    inserted++;
  }
  return inserted;
}

/**
 * If the active leg is APX and it hands off to a supported carrier that we
 * don't already have a leg for, create that next leg (sequence+1) and make it
 * active. Returns the created carrier or null.
 */
async function maybeCreateHandoffLeg(sql: Sql, leg: ActiveLeg, result: NormalizedTracking): Promise<string | null> {
  const next = detectHandoff(result);
  if (!next) return null;

  // Already have a leg for this carrier?
  const dup = await sql.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM shipment_legs WHERE order_id = $1 AND carrier = $2",
    [leg.orderId, next.carrier],
  );
  if ((dup.rows[0]?.n ?? 0) > 0) return null;

  // Max 2 legs.
  const total = await sql.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM shipment_legs WHERE order_id = $1",
    [leg.orderId],
  );
  if ((total.rows[0]?.n ?? 0) >= 2) return null;

  // Create the handoff leg and make it the active one.
  await sql.query("UPDATE shipment_legs SET is_active = false WHERE order_id = $1", [leg.orderId]);
  await sql.query(
    `INSERT INTO shipment_legs (order_id, branch_id, carrier, carrier_tracking_number, sequence, is_active)
     VALUES ($1,$2,$3,$4,$5,true)`,
    [leg.orderId, leg.branchId, next.carrier, next.trackingNumber, leg.sequence + 1],
  );
  return next.carrier;
}

/**
 * Sync a single order. Loads its active leg, calls the adapter, writes new
 * events, updates cached status, and (for APX) auto-creates a handoff leg.
 */
export async function syncOrder(orderId: string): Promise<SyncResult> {
  // 1. Read the active leg + branch (short tx).
  let leg: ActiveLeg | null = null;
  let branchId = "";
  try {
    // We need the branch id first to set context. Read it with a super-admin
    // all-branches lookup limited to this order.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.is_super_admin','on',true)");
      await client.query("SELECT set_config('app.all_branches','on',true)");
      const { rows } = await client.query<{ branch_id: string }>(
        "SELECT branch_id FROM orders WHERE id = $1",
        [orderId],
      );
      await client.query("COMMIT");
      if (!rows[0]) return { orderId, carrier: null, status: "error", error: "order not found" };
      branchId = rows[0].branch_id;
    } finally {
      client.release();
    }
  } catch (e) {
    return { orderId, carrier: null, status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  return withOrderBranchTx(branchId, async (sql): Promise<SyncResult> => {
    leg = await getActiveLeg(sql, orderId);
    if (!leg) return { orderId, carrier: null, status: "no_active_leg" };

    const adapter = resolveAdapter(leg.carrier);
    if (!adapter) {
      return { orderId, carrier: leg.carrier, status: "error", error: `no adapter for "${leg.carrier}"` };
    }

    let result: NormalizedTracking | null;
    try {
      result = await adapter.track(leg.trackingNumber);
    } catch (e) {
      return { orderId, carrier: leg.carrier, status: "error", error: e instanceof Error ? e.message : String(e) };
    }

    if (result === null) {
      // Not found yet (e.g. carrier hasn't scanned it). Update last_synced_at.
      await sql.query("UPDATE orders SET last_synced_at = now() WHERE id = $1", [orderId]);
      return { orderId, carrier: leg.carrier, status: "not_found" };
    }

    const newEvents = await writeEvents(sql, leg, result);
    const handoffCreated = leg.carrier === "smartcargo-apx"
      ? await maybeCreateHandoffLeg(sql, leg, result)
      : null;

    // Update cached status on the order.
    const orderStatus = result.status === "delivered" ? "delivered" : undefined;
    await sql.query(
      `UPDATE orders
          SET current_status = $2,
              current_status_text = $3,
              last_synced_at = now()
              ${orderStatus ? ", order_status = 'delivered'" : ""}
        WHERE id = $1`,
      [orderId, result.status, result.statusText],
    );

    return {
      orderId,
      carrier: leg.carrier,
      status: "synced",
      normalizedStatus: result.status,
      newEvents,
      handoffCreated,
    };
  }).catch((e): SyncResult => ({
    orderId,
    carrier: leg?.carrier ?? null,
    status: "error",
    error: e instanceof Error ? e.message : String(e),
  }));
}
