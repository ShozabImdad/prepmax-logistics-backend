// Public tracking — look up a shipment by its customer-facing Prep Max tracking
// code (e.g. PML-2026-XXXXXXX) with NO authentication.
//
// This is intentionally cross-branch (a customer tracking a code doesn't know
// or care which branch it belongs to) and keyed on the unguessable tracking
// code, so it runs in an all-branches super-admin context. It returns ONLY
// customer-safe fields: status, ETA, and the event timeline — never internal
// data, sender/cost basis, or raw carrier tracking numbers.

import { pool } from "../../db/pool.js";
import { redactCarrier } from "./sanitize.js";

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
              receiver_city, receiver_country, last_synced_at
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
      statusText: order.current_status_text,
      destinationCity: order.receiver_city,
      destinationCountry: order.receiver_country,
      estimatedDelivery: null, // not yet captured as a structured field
      lastUpdated: order.last_synced_at,
      pieceCount: pieces.rows[0]?.n ?? 0,
      // Redact carrier branding (DPD/DHL/UPS/... leak in via carriers' own
      // location/description fields) — customers must not see the real carrier.
      events: events.rows.map((e) => ({
        timestamp: e.event_time ? new Date(e.event_time).toISOString() : (e.event_time_raw ?? null),
        location: redactCarrier(e.location),
        description: redactCarrier(e.description) ?? "Shipment update",
      })),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
