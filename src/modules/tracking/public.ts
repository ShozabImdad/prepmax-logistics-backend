// Public tracking — look up a shipment by its customer-facing Prep Max tracking
// code (e.g. PML-2026-XXXXXXX) with NO authentication.
//
// This is intentionally cross-branch (a customer tracking a code doesn't know
// or care which branch it belongs to) and keyed on the unguessable tracking
// code, so it runs in an all-branches super-admin context. It returns ONLY
// customer-safe fields: status, ETA, and the event timeline — never internal
// data, sender/cost basis, or raw carrier tracking numbers.

import { pool } from "../../db/pool.js";
import { redactCarrier, cleanEventText, cleanEventLocation } from "./sanitize.js";

export interface PublicTrackingEvent {
  timestamp: string | null;
  location: string | null;
  description: string;
}

export interface PublicTracking {
  trackingCode: string;
  status: string | null;          // normalized: in_transit | delivered | ...
  statusText: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  estimatedDelivery: string | null;
  lastUpdated: string | null;
  pieceCount: number;
  events: PublicTrackingEvent[];
}

export async function publicTrack(trackingCode: string): Promise<PublicTracking | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Read-only, all-branches context keyed on the unguessable tracking code.
    await client.query("SELECT set_config('app.is_super_admin','on',true)");
    await client.query("SELECT set_config('app.all_branches','on',true)");

    const { rows } = await client.query(
      `SELECT id, tracking_code, current_status, current_status_text,
              receiver_city, receiver_country, last_synced_at,
              estimated_delivery_min, estimated_delivery_max
         FROM orders
        WHERE tracking_code = $1`,
      [trackingCode],
    );
    const order = rows[0];
    if (!order) {
      await client.query("COMMIT");
      return null;
    }

    const pieces = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM boxes WHERE order_id = $1",
      [order.id],
    );

    // All tracking events across the order's legs, newest first. We do NOT
    // expose which carrier — only the location + description the customer needs.
    const events = await client.query(
      `SELECT te.event_time, te.event_time_raw, te.location, te.description
         FROM tracking_events te
         JOIN shipment_legs sl ON sl.id = te.shipment_leg_id
        WHERE sl.order_id = $1
        ORDER BY te.event_time DESC NULLS LAST, te.created_at DESC`,
      [order.id],
    );

    await client.query("COMMIT");

    return {
      trackingCode: order.tracking_code,
      status: order.current_status,
      // Redact carrier branding — the cached status text is a carrier event
      // string (e.g. "Processed at APX LOGISTICS Facility") and leaks otherwise.
      statusText: redactCarrier(order.current_status_text),
      destinationCity: order.receiver_city,
      destinationCountry: order.receiver_country,
      // Not a confirmed date — use the later (safer) end of the working-day
      // window as the single estimate shown to customers. Unset until the
      // order is activated (first carrier leg attached).
      estimatedDelivery: order.estimated_delivery_max
        ? new Date(order.estimated_delivery_max).toISOString().slice(0, 10)
        : null,
      lastUpdated: order.last_synced_at,
      pieceCount: pieces.rows[0]?.n ?? 0,
      // Two-stage cleanup for customer display: redactCarrier() strips carrier
      // brand names (DPD/DHL/UPS/... leak in via carriers' own location/
      // description fields); cleanEventText()/cleanEventLocation() then strip
      // operational noise (flight numbers, linehaul/bag/weight detail, IMO/GPO
      // postal-facility tags). Applied at read time so historical events are
      // cleaned too.
      events: events.rows.map((e) => ({
        timestamp: e.event_time ? new Date(e.event_time).toISOString() : (e.event_time_raw ?? null),
        location: cleanEventLocation(redactCarrier(e.location)),
        description: cleanEventText(redactCarrier(e.description)) || "Shipment update",
      })),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
