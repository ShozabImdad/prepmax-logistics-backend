// Background poller (architecture plan §4/§8).
//
// Status-aware selection: only polls orders that are worth polling, on a
// cadence that depends on their state. Runs the browser-based carriers at LOW
// concurrency to limit memory and avoid tripping Akamai.
//
// Cadence (minutes since last_synced_at) before an order is due again:
//   - out_for_delivery : 15 min   (moving fast, refresh often)
//   - active / others  : 45 min
//   - delivered / cancelled / pending_approval / awaiting_carrier : never
//     (terminal, or nothing to track yet)

import { pool, closePool } from "../db/pool.js";
import { syncOrder, type SyncResult } from "./sync.js";
import { closeDhlBrowser } from "./adapters/dhl.js";
import { closeFedexBrowser } from "./adapters/fedex.js";

const FAST_MINUTES = 15;   // out_for_delivery
const NORMAL_MINUTES = 45; // active
const CONCURRENCY = 2;     // parallel syncs (keep low for browser carriers)

interface DueOrder {
  id: string;
  carrier: string;
}

/**
 * Select orders that are due for a refresh. An order is due when:
 *  - it has at least one shipment leg (something to track),
 *  - its order_status is trackable (active, or awaiting_carrier that already
 *    got a leg — represented as 'active' after leg attach),
 *  - and last_synced_at is null or older than the cadence for its state.
 */
async function selectDueOrders(limit: number): Promise<DueOrder[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_super_admin','on',true)");
    await client.query("SELECT set_config('app.all_branches','on',true)");
    const { rows } = await client.query<DueOrder>(
      `SELECT o.id, sl.carrier
         FROM orders o
         JOIN LATERAL (
           SELECT carrier FROM shipment_legs
            WHERE order_id = o.id
            ORDER BY is_active DESC, sequence DESC
            LIMIT 1
         ) sl ON true
        WHERE o.order_status = 'active'
          AND (
            o.last_synced_at IS NULL
            OR (o.current_status = 'out_for_delivery'
                AND o.last_synced_at < now() - ($1 || ' minutes')::interval)
            OR (COALESCE(o.current_status,'') <> 'out_for_delivery'
                AND o.last_synced_at < now() - ($2 || ' minutes')::interval)
          )
        ORDER BY o.last_synced_at ASC NULLS FIRST
        LIMIT $3`,
      [FAST_MINUTES, NORMAL_MINUTES, limit],
    );
    await client.query("COMMIT");
    return rows;
  } finally {
    client.release();
  }
}

/** Run an array of async tasks with bounded concurrency. */
async function runPool<T>(items: T[], worker: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]!);
    }
  });
  await Promise.all(runners);
}

/** One poll cycle: select due orders and sync them. Returns a summary. */
export async function runPollCycle(maxOrders = 50): Promise<SyncResult[]> {
  const due = await selectDueOrders(maxOrders);
  const results: SyncResult[] = [];
  await runPool(
    due,
    async (order) => {
      const res = await syncOrder(order.id);
      results.push(res);
      const tail = res.status === "synced"
        ? `${res.normalizedStatus} (+${res.newEvents} events${res.handoffCreated ? `, handoff→${res.handoffCreated}` : ""})`
        : res.status + (res.error ? `: ${res.error}` : "");
      console.log(`[poll] ${order.carrier} ${order.id.slice(0, 8)} → ${tail}`);
    },
    CONCURRENCY,
  );
  return results;
}

/**
 * Long-running poller: run a cycle every intervalMinutes. Used as a standalone
 * process (npm run poll) or started alongside the API.
 */
export function startPoller(intervalMinutes = 5): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const results = await runPollCycle();
      if (results.length) console.log(`[poll] cycle done: ${results.length} order(s)`);
    } catch (e) {
      console.error("[poll] cycle error:", e instanceof Error ? e.message : e);
    }
    if (!stopped) timer = setTimeout(tick, intervalMinutes * 60_000);
  };

  tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// Standalone entry: `npm run poll` runs cycles until interrupted.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const handle = startPoller(Number(process.env.POLL_INTERVAL_MINUTES ?? 5));
  const shutdown = async () => {
    handle.stop();
    await closeDhlBrowser().catch(() => {});
    await closeFedexBrowser().catch(() => {});
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
