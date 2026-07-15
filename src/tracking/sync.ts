// Tracking sync — the bridge between the carrier adapters and the database.
//
// syncOrder(orderId): for one order, polls EVERY shipment leg (not just the
// active one), calls each leg's matching adapter, writes any NEW normalized
// events into tracking_events per leg, and updates the cached
// current_status / current_status_text / last_synced_at on the order based on
// the ACTIVE leg's result. Idempotent: events are de-duplicated by a stable
// key so re-polling never creates duplicates.
//
// The poller runs outside HTTP requests, so it uses withSystemTx (a transaction
// that sets the branch context to the order's own branch — RLS still applies,
// scoped to that order's branch). This is the controlled elevated path from the
// architecture plan §1, used only by the trusted background poller.

import type { Sql } from "../db/pool.js";
import { pool } from "../db/pool.js";
import { resolveAdapter } from "./adapters/index.js";
import { detectHandoff } from "./adapters/handoff.js";
import { emitEvent } from "../modules/notifications/events.js";
import type { NormalizedTracking, TrackingEvent } from "./adapters/types.js";

// Terminal statuses we stop polling.
export const TERMINAL_STATUSES = new Set(["delivered"]);

export interface LegSyncResult {
  legId: string;
  carrier: string;
  sequence: number;
  isActive: boolean;
  status: "not_found" | "synced" | "error";
  normalizedStatus?: string;
  newEvents?: number;
  error?: string;
}

export interface SyncResult {
  orderId: string;
  carrier: string | null; // active leg's carrier, kept for backward compatibility
  status: "no_legs" | "synced" | "error";
  normalizedStatus?: string; // active leg's status
  newEvents?: number; // total across all legs
  handoffCreated?: string | null; // carrier of an auto-created leg, if any
  legs?: LegSyncResult[]; // per-leg breakdown
  error?: string;
}

interface Leg {
  legId: string;
  orderId: string;
  branchId: string;
  carrier: string;
  trackingNumber: string;
  sequence: number;
  isActive: boolean;
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

// CHANGED: was getActiveLeg (LIMIT 1, active-first). Now returns ALL legs for
// the order, so every carrier gets polled — not just the currently-active one.
async function getAllLegs(sql: Sql, orderId: string): Promise<Leg[]> {
  const { rows } = await sql.query(
    `SELECT id, order_id, branch_id, carrier, carrier_tracking_number, sequence, is_active
       FROM shipment_legs
      WHERE order_id = $1
      ORDER BY sequence ASC`,
    [orderId],
  );
  return rows.map((r) => ({
    legId: r.id, orderId: r.order_id, branchId: r.branch_id,
    carrier: r.carrier, trackingNumber: r.carrier_tracking_number,
    sequence: r.sequence, isActive: r.is_active,
  }));
}

async function writeEvents(sql: Sql, leg: Leg, result: NormalizedTracking): Promise<number> {
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
async function maybeCreateHandoffLeg(sql: Sql, leg: Leg, result: NormalizedTracking): Promise<string | null> {
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
 * Sync a single order. Loads ALL legs, calls each leg's adapter, writes new
 * events per leg, updates cached status from the ACTIVE leg's result, and
 * (for APX) auto-creates a handoff leg.
 */
export async function syncOrder(orderId: string): Promise<SyncResult> {
  // 1. Read the branch id first (short tx), same as before.
  let branchId = "";
  try {
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

  let activeCarrier: string | null = null;

  return withOrderBranchTx(branchId, async (sql): Promise<SyncResult> => {
    const legs = await getAllLegs(sql, orderId);
    if (legs.length === 0) return { orderId, carrier: null, status: "no_legs" };

    const legResults: LegSyncResult[] = [];
    let totalNewEvents = 0;
    let handoffCreated: string | null = null;
    let activeResult: NormalizedTracking | null = null;
    let activeLeg: Leg | null = null;

    // Poll every leg — not just the active one.
    for (const leg of legs) {
      if (leg.isActive) activeCarrier = leg.carrier;

      const adapter = resolveAdapter(leg.carrier);
      if (!adapter) {
        legResults.push({
          legId: leg.legId, carrier: leg.carrier, sequence: leg.sequence,
          isActive: leg.isActive, status: "error", error: `no adapter for "${leg.carrier}"`,
        });
        continue;
      }

      let result: NormalizedTracking | null;
      try {
        result = await adapter.track(leg.trackingNumber);
      } catch (e) {
        legResults.push({
          legId: leg.legId, carrier: leg.carrier, sequence: leg.sequence,
          isActive: leg.isActive, status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      if (result === null) {
        legResults.push({
          legId: leg.legId, carrier: leg.carrier, sequence: leg.sequence,
          isActive: leg.isActive, status: "not_found",
        });
        continue;
      }

      const newEvents = await writeEvents(sql, leg, result);
      totalNewEvents += newEvents;
      legResults.push({
        legId: leg.legId, carrier: leg.carrier, sequence: leg.sequence,
        isActive: leg.isActive, status: "synced",
        normalizedStatus: result.status, newEvents,
      });

      // Handoff detection stays scoped to the active APX leg only, same rule
      // as before — we don't want a stale inactive leg spawning new legs.
      if (leg.isActive && leg.carrier === "smartcargo-apx") {
        handoffCreated = await maybeCreateHandoffLeg(sql, leg, result);
      }

      if (leg.isActive) {
        activeResult = result;
        activeLeg = leg;
      }
    }

    // Cached order-level status still reflects the ACTIVE leg only — that's
    // "where the shipment currently is," same semantics as before.
    if (activeResult && activeLeg) {
      const prev = await sql.query<{ current_status: string | null }>(
        "SELECT current_status FROM orders WHERE id = $1",
        [orderId],
      );
      const prevStatus = prev.rows[0]?.current_status ?? null;

      const orderStatus = activeResult.status === "delivered" ? "delivered" : undefined;
      await sql.query(
        `UPDATE orders
            SET current_status = $2,
                current_status_text = $3,
                last_synced_at = now()
                ${orderStatus ? ", order_status = 'delivered'" : ""}
          WHERE id = $1`,
        [orderId, activeResult.status, activeResult.statusText],
      );

      if (activeResult.status !== prevStatus) {
        if (activeResult.status === "delivered") {
          emitEvent({ kind: "order_delivered", orderId, branchId: activeLeg.branchId });
        } else if (activeResult.status === "exception") {
          emitEvent({ kind: "order_exception", orderId, branchId: activeLeg.branchId, statusText: activeResult.statusText });
        }
      }
    } else {
      // No active leg synced successfully (e.g. all errored/not_found) —
      // still bump last_synced_at so the poller doesn't hammer it immediately.
      await sql.query("UPDATE orders SET last_synced_at = now() WHERE id = $1", [orderId]);
    }

    return {
      orderId,
      carrier: activeCarrier,
      status: "synced",
      normalizedStatus: activeResult?.status,
      newEvents: totalNewEvents,
      handoffCreated,
      legs: legResults,
    };
  }).catch((e): SyncResult => ({
    orderId,
    carrier: activeCarrier,
    status: "error",
    error: e instanceof Error ? e.message : String(e),
  }));
}