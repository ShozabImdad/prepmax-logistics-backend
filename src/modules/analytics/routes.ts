// Analytics — aggregated dashboard stats, branch-scoped via req.db (RLS).
//   GET /api/analytics/summary?days=30
// Returns: KPI totals, orders-per-day, revenue-per-day, status breakdown,
// top destinations, and carrier usage.

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff } from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";

export const analyticsRouter: Router = Router();

analyticsRouter.get(
  "/summary",
  requireStaff,
  asyncHandler(async (req, res) => {
    const actor = req.auth!;
    if (!isStaff(actor)) return res.status(403).json({ error: "Staff only" });
    // No single permission gates the whole dashboard anymore — each section
    // is independently visible based on what the caller actually holds, so
    // e.g. a data-entry staffer without orders.view just gets an empty
    // response instead of a 403 that blanks out finance widgets they *do*
    // have rights to (or vice versa).
    const canSeeOrders = actor.permissions.has("orders.view");
    const canSeeFinancials = actor.permissions.has("finance.manage");

    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 7), 365);

    const data = await req.db!(async (sql) => {
      if (!canSeeOrders && !canSeeFinancials) {
        // Neither permission — don't touch the DB at all.
        return { totals: null, perDay: [], statusBreakdown: [], topDestinations: [], carrierUsage: [] };
      }

      // KPI totals — always run if either flag is set (cheap single query),
      // then the response mapping below picks which fields to actually send.
      const totals = await sql.query<{
        total: number; delivered: number; active: number; pending: number; exceptions: number;
        revenue: number; unpaid_amount: number;
      }>(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE order_status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE order_status = 'active')::int AS active,
           count(*) FILTER (WHERE order_status = 'pending_approval')::int AS pending,
           count(*) FILTER (WHERE current_status = 'exception')::int AS exceptions,
           COALESCE(sum(price), 0) AS revenue,
           COALESCE(sum(GREATEST(COALESCE(price,0) - COALESCE(amount_paid,0), 0)), 0) AS unpaid_amount
         FROM orders`,
      );

      // orders + revenue per day (last N days) — needed if either chart is visible.
      const perDay = canSeeOrders || canSeeFinancials
        ? await sql.query<{ day: string; orders: number; revenue: number }>(
            `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
                    count(*)::int AS orders,
                    COALESCE(sum(price), 0) AS revenue
               FROM orders
              WHERE created_at >= now() - ($1 || ' days')::interval
              GROUP BY created_at::date
              ORDER BY created_at::date`,
            [days],
          )
        : { rows: [] };

      // The rest are pure order-shape data — only worth querying for
      // canSeeOrders callers.
      const statusBreakdown = canSeeOrders
        ? await sql.query<{ status: string; count: number }>(
            `SELECT order_status AS status, count(*)::int AS count FROM orders GROUP BY order_status`,
          )
        : { rows: [] };

      const topDestinations = canSeeOrders
        ? await sql.query<{ destination: string; count: number }>(
            `SELECT COALESCE(NULLIF(receiver_country, ''), 'Unknown') AS destination, count(*)::int AS count
               FROM orders GROUP BY receiver_country ORDER BY count DESC LIMIT 8`,
          )
        : { rows: [] };

      const carrierUsage = canSeeOrders
        ? await sql.query<{ carrier: string; count: number }>(
            `SELECT sl.carrier, count(DISTINCT sl.order_id)::int AS count
               FROM shipment_legs sl
              GROUP BY sl.carrier ORDER BY count DESC`,
          )
        : { rows: [] };

      return {
        totals: totals.rows[0]!,
        perDay: perDay.rows,
        statusBreakdown: statusBreakdown.rows,
        topDestinations: topDestinations.rows,
        carrierUsage: carrierUsage.rows,
      };
    });

    return res.json({
      days,
      totals: data.totals ? {
        // Order-shape counts, only for canSeeOrders.
        total: canSeeOrders ? data.totals.total : undefined,
        delivered: canSeeOrders ? data.totals.delivered : undefined,
        active: canSeeOrders ? data.totals.active : undefined,
        pending: canSeeOrders ? data.totals.pending : undefined,
        exceptions: canSeeOrders ? data.totals.exceptions : undefined,
        // Financial figures, only for canSeeFinancials.
        revenue: canSeeFinancials ? Number(data.totals.revenue) : undefined,
        unpaidAmount: canSeeFinancials ? Number(data.totals.unpaid_amount) : undefined,
      } : undefined,
      ordersPerDay: (canSeeOrders || canSeeFinancials)
        ? data.perDay.map((r) => ({
            day: r.day,
            orders: canSeeOrders ? r.orders : undefined,
            revenue: canSeeFinancials ? Number(r.revenue) : undefined,
          }))
        : undefined,
      statusBreakdown: canSeeOrders ? data.statusBreakdown : undefined,
      topDestinations: canSeeOrders ? data.topDestinations : undefined,
      carrierUsage: canSeeOrders ? data.carrierUsage : undefined,
    });
  }),
);