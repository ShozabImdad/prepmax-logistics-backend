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
import type { NormalizedTracking, ShipmentStatus, TrackingEvent } from "./adapters/types.js";

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
  error?: string;        // raw technical error — for logs/debugging only, never shown to users
  userMessage?: string;  // clean, human-friendly summary safe to show staff (see legUserMessage)
}

// Friendly display name per carrier code (falls back to the raw code upper-cased).
const CARRIER_DISPLAY: Record<string, string> = {
  dpd: "DPD",
  "smartcargo-apx": "APX / SmartCargo",
  snwwe: "SkyNet",
  dhl: "DHL",
  ups: "UPS",
  fedex: "FedEx",
  pakpost: "Pakistan Post",
  emx: "EMX",
};

function carrierDisplay(carrier: string): string {
  return CARRIER_DISPLAY[carrier] ?? carrier.toUpperCase();
}

// Turn a per-leg sync outcome into a clean, non-technical message safe to show
// staff. Never leaks raw adapter errors (timeouts, stack traces, HTTP codes) —
// those stay in LegSyncResult.error for logs only.
function legUserMessage(carrier: string, status: LegSyncResult["status"], newEvents = 0): string {
  const name = carrierDisplay(carrier);
  switch (status) {
    case "synced":
      return newEvents > 0
        ? `${name}: ${newEvents} new update${newEvents === 1 ? "" : "s"}`
        : `${name}: up to date`;
    case "not_found":
      return `${name}: no tracking information available yet`;
    case "error":
    default:
      return `${name}: tracking is temporarily unavailable`;
  }
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

// Relative progress rank of a normalized status. Used to pick which leg drives
// the order-level status: a shipment moves forward through its legs, so the
// order should show the FURTHEST-ALONG leg that returned data — but measured by
// real progress, not merely by leg sequence. This prevents a last-mile leg that
// has only just printed a label ("info_received") from downgrading an order whose
// first-mile leg is already "in_transit" (e.g. cleared customs). "unknown" ranks
// below everything so a leg with no clear status never wins over one that has one.
const STATUS_RANK: Record<ShipmentStatus, number> = {
  unknown: -1,
  info_received: 0,
  in_transit: 1,
  out_for_delivery: 2,
  exception: 3,
  delivered: 4,
};

// Carrier-agnostic status inference from a stored event's text. Used only as a
// FALLBACK when a leg cannot be fetched live (e.g. FedEx is Akamai-blocked from
// the server) but we already have events stored for it from a prior successful
// fetch. Keeps an order that a last-mile carrier already delivered from being
// dragged back to the first-mile leg's status just because the last-mile leg is
// temporarily unreachable. Deliberately conservative: returns null when nothing
// matches, so an ambiguous stored event never overrides a live result.
function inferStatusFromText(text: string): ShipmentStatus | null {
  const t = text.toLowerCase();
  // Delivered variants across carriers (DPD safe-place/neighbour, FedEx "left
  // at front door", generic "delivered"). "will be delivered"/"will now be" are
  // future ETAs, not completed deliveries — exclude them.
  if (
    (t.includes("delivered") && !t.includes("will be delivered") && !t.includes("will now be delivered")) ||
    t.includes("left at front door") ||
    t.includes("left in safe place") ||
    t.includes("left in a safe place") ||
    t.includes("waiting for you at home") ||
    t.includes("left in lobby") ||
    t.includes("left with a neighbour") ||
    t.includes("left with your neighbour")
  ) {
    return "delivered";
  }
  if (t.includes("out for delivery") || t.includes("out with courier") || t.includes("with you today")) {
    return "out_for_delivery";
  }
  if (
    t.includes("attempt") || t.includes("no response") || t.includes("undelivered") ||
    t.includes("returned to") || t.includes("held") || t.includes("exception")
  ) {
    return "exception";
  }
  if (
    t.includes("transit") || t.includes("departed") || t.includes("arrived") ||
    t.includes("picked up") || t.includes("cleared") || t.includes("at our depot") ||
    t.includes("on its way")
  ) {
    return "in_transit";
  }
  return null;
}

// Latest stored event's inferred status for a leg (fallback path only).
async function storedFallbackStatus(sql: Sql, leg: Leg): Promise<ShipmentStatus | null> {
  const { rows } = await sql.query<{ description: string | null; raw_status: string | null }>(
    `SELECT description, raw_status FROM tracking_events
      WHERE shipment_leg_id = $1
      ORDER BY event_time DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [leg.legId],
  );
  const row = rows[0];
  if (!row) return null;
  return inferStatusFromText(row.raw_status ?? "") ?? inferStatusFromText(row.description ?? "");
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
    // The leg whose status the ORDER should display. Legs are iterated in
    // sequence order (leg 1 -> leg 2 ...), and a shipment physically moves
    // forward through them (e.g. APX first mile -> UPS/DHL last mile). So the
    // order's real current status is the MOST ADVANCED leg that returned data
    // — the highest-sequence leg with a successful result — NOT whichever leg
    // happens to carry is_active=true. This fixes the long-standing bug where a
    // manually-attached leg 2 (never activated) meant the order stayed frozen
    // on leg 1's status even after the last-mile carrier marked it delivered.
    let statusResult: NormalizedTracking | null = null;
    let statusLeg: Leg | null = null;
    // Legs whose live fetch failed (error/not_found) — candidates for the
    // stored-events fallback after the loop.
    const legsWithoutLiveResult: Leg[] = [];

    // Poll every leg — not just the active one.
    for (const leg of legs) {
      if (leg.isActive) activeCarrier = leg.carrier;

      const adapter = resolveAdapter(leg.carrier);
      if (!adapter) {
        legResults.push({
          legId: leg.legId, carrier: leg.carrier, sequence: leg.sequence,
          isActive: leg.isActive, status: "error", error: `no adapter for "${leg.carrier}"`,
          userMessage: legUserMessage(leg.carrier, "error"),
        });
        legsWithoutLiveResult.push(leg);
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
          userMessage: legUserMessage(leg.carrier, "error"),
        });
        legsWithoutLiveResult.push(leg);
        continue;
      }

      if (result === null) {
        legResults.push({
          legId: leg.legId, carrier: leg.carrier, sequence: leg.sequence,
          isActive: leg.isActive, status: "not_found",
          userMessage: legUserMessage(leg.carrier, "not_found"),
        });
        legsWithoutLiveResult.push(leg);
        continue;
      }

      const newEvents = await writeEvents(sql, leg, result);
      totalNewEvents += newEvents;
      legResults.push({
        legId: leg.legId, carrier: leg.carrier, sequence: leg.sequence,
        isActive: leg.isActive, status: "synced",
        normalizedStatus: result.status, newEvents,
        userMessage: legUserMessage(leg.carrier, "synced", newEvents),
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

      // Any leg that returned data is a candidate to drive the order status.
      // Pick the FURTHEST-ALONG leg by real progress rank, with later sequence
      // breaking ties. This way a delivered last-mile leg wins over an in-transit
      // first-mile leg, but a last-mile leg that has only printed a label does
      // NOT downgrade an order whose first-mile leg is already further along.
      if (
        statusResult === null || statusLeg === null ||
        STATUS_RANK[result.status] > STATUS_RANK[statusResult.status] ||
        (STATUS_RANK[result.status] === STATUS_RANK[statusResult.status] &&
          leg.sequence >= statusLeg.sequence)
      ) {
        statusResult = result;
        statusLeg = leg;
      }
    }

    // The status driver so far comes from live results. Normalize it into a
    // small shape {status, statusText, leg} so the stored-events fallback below
    // can compete with it on equal footing.
    let driveStatus: ShipmentStatus | null = (statusResult ?? activeResult)?.status ?? null;
    let driveStatusText: string = (statusResult ?? activeResult)?.statusText ?? "";
    let driveLeg: Leg | null = statusLeg ?? activeLeg;

    // FALLBACK: for legs whose live fetch failed but which already have stored
    // events (e.g. a FedEx last-mile leg that is Akamai-blocked from the server
    // yet was captured as Delivered earlier), infer status from the latest
    // stored event. If that outranks the live driver — or if there is no live
    // driver at all — let it drive the order. This keeps a delivered last-mile
    // leg authoritative even while the carrier is temporarily unreachable, and
    // is the general form of the delivered-terminal guard below.
    for (const leg of legsWithoutLiveResult) {
      const fb = await storedFallbackStatus(sql, leg);
      if (!fb) continue;
      const better =
        driveStatus === null ||
        driveLeg === null ||
        STATUS_RANK[fb] > STATUS_RANK[driveStatus] ||
        (STATUS_RANK[fb] === STATUS_RANK[driveStatus] && leg.sequence >= driveLeg.sequence);
      if (better) {
        driveStatus = fb;
        driveLeg = leg;
        // Preserve the stored event's own text where possible for statusText.
        const { rows } = await sql.query<{ description: string | null; raw_status: string | null }>(
          `SELECT description, raw_status FROM tracking_events
            WHERE shipment_leg_id = $1
            ORDER BY event_time DESC NULLS LAST, created_at DESC LIMIT 1`,
          [leg.legId],
        );
        driveStatusText = rows[0]?.raw_status || rows[0]?.description || driveStatusText;
      }
    }

    // Cached order-level status reflects the most ADVANCED leg with data (the
    // parcel's real current position — see statusLeg above), not merely the
    // is_active leg. Falls back to the active leg if that's the only one, and
    // to nothing if no leg returned data.
    if (driveStatus !== null && driveLeg) {
      const prev = await sql.query<{ current_status: string | null }>(
        "SELECT current_status FROM orders WHERE id = $1",
        [orderId],
      );
      const prevStatus = prev.rows[0]?.current_status ?? null;

      // "delivered" is terminal — a parcel does not un-deliver. When an order is
      // already delivered but this run's best leg came back lower (typically
      // because the delivering last-mile leg failed to fetch live this time —
      // e.g. an Akamai block on the browser adapter — leaving only the earlier
      // first-mile leg to contribute data), do NOT regress the order. Keep the
      // delivered status and just refresh last_synced_at. Without this guard a
      // transient fetch failure would flip a delivered order back to in_transit.
      if (prevStatus === "delivered" && driveStatus !== "delivered") {
        await sql.query("UPDATE orders SET last_synced_at = now() WHERE id = $1", [orderId]);
        return {
          orderId,
          carrier: activeCarrier,
          status: "synced",
          normalizedStatus: "delivered",
          newEvents: totalNewEvents,
          legs: legResults,
          handoffCreated,
        };
      }

      const orderStatus = driveStatus === "delivered" ? "delivered" : undefined;
      await sql.query(
        `UPDATE orders
            SET current_status = $2,
                current_status_text = $3,
                last_synced_at = now()
                ${orderStatus ? ", order_status = 'delivered'" : ""}
          WHERE id = $1`,
        [orderId, driveStatus, driveStatusText],
      );

      if (driveStatus !== prevStatus) {
        if (driveStatus === "delivered") {
          emitEvent({ kind: "order_delivered", orderId, branchId: driveLeg.branchId });
          } else if (driveStatus === "out_for_delivery") {
          emitEvent({ kind: "order_out_for_delivery", orderId, branchId: driveLeg.branchId, statusText: driveStatusText });
        } else if (driveStatus === "exception") {
          emitEvent({ kind: "order_exception", orderId, branchId: driveLeg.branchId, statusText: driveStatusText });
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
      // Reflect the leg that actually drives the order status (most advanced
      // leg with data, incl. the stored-events fallback), so the poller log /
      // sync-all summary aren't misleading.
      normalizedStatus: driveStatus ?? undefined,
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