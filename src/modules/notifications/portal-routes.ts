// Customer-facing notification routes. No SSE for customers (yet) — the
// portal bell just polls, same interval pattern as useNotifications() on
// the admin side. Mounted at /api/portal/notifications.

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireCustomer } from "../../middleware/auth.js";
import { isCustomer } from "../auth/types.js";
import {
  listCustomerNotifications, customerUnreadCount, markAllCustomerNotificationsRead,
} from "./service.js";

export const portalNotificationRouter: Router = Router();

portalNotificationRouter.get(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const unreadOnly = req.query.unread === "true";
    const items = await listCustomerNotifications(req.db!, cust.customerId, { unreadOnly });
    const unread = await customerUnreadCount(req.db!, cust.customerId);
    return res.json({ notifications: items, unread });
  }),
);

portalNotificationRouter.post(
  "/read-all",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const n = await markAllCustomerNotificationsRead(req.db!, cust.customerId);
    return res.json({ ok: true, marked: n });
  }),
);