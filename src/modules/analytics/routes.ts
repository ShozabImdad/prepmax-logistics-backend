// Analytics — aggregated dashboard stats, branch-scoped via req.db (RLS).
//   GET /api/analytics/summary?days=30
// Returns: KPI totals, orders-per-day, revenue-per-day, status breakdown,
// top destinations, and carrier usage.

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requirePermission } from "../../middleware/auth.js";

export const analyticsRouter: Router = Router();

analyticsRouter.get(
  "/summary",
  requireStaff,
  requirePermission("orders.view"),
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 7), 365);

    const data = await req.db!(async (sql) => {
      // KPI totals
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

      // orders + revenue per day (last N days)
      const perDay = await sql.query<{ day: string; orders: number; revenue: number }>(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
                count(*)::int AS orders,
                COALESCE(sum(price), 0) AS revenue
           FROM orders
          WHERE created_at >= now() - ($1 || ' days')::interval
          GROUP BY created_at::date
          ORDER BY created_at::date`,
        [days],
      );

      // status breakdown (order_status)
      const statusBreakdown = await sql.query<{ status: string; count: number }>(
        `SELECT order_status AS status, count(*)::int AS count FROM orders GROUP BY order_status`,
      );

      // top destinations (receiver country)
      const topDestinations = await sql.query<{ destination: string; count: number }>(
        `SELECT COALESCE(NULLIF(receiver_country, ''), 'Unknown') AS destination, count(*)::int AS count
           FROM orders GROUP BY receiver_country ORDER BY count DESC LIMIT 8`,
      );

      // carrier usage (from active/first shipment leg)
      const carrierUsage = await sql.query<{ carrier: string; count: number }>(
        `SELECT sl.carrier, count(DISTINCT sl.order_id)::int AS count
           FROM shipment_legs sl
          GROUP BY sl.carrier ORDER BY count DESC`,
      );

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
      totals: {
        total: data.totals.total,
        delivered: data.totals.delivered,
        active: data.totals.active,
        pending: data.totals.pending,
        exceptions: data.totals.exceptions,
        revenue: Number(data.totals.revenue),
        unpaidAmount: Number(data.totals.unpaid_amount),
      },
      ordersPerDay: data.perDay.map((r) => ({ day: r.day, orders: r.orders, revenue: Number(r.revenue) })),
      statusBreakdown: data.statusBreakdown,
      topDestinations: data.topDestinations,
      carrierUsage: data.carrierUsage,
    });
  }),
);
