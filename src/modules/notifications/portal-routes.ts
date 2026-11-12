// Customer-facing notification routes, mounted at /api/portal/notifications,
// plus the merged customer live stream (portalStreamRouter) mounted at
// /api/portal/stream.

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireCustomer } from "../../middleware/auth.js";
import { isCustomer } from "../auth/types.js";
import { addCustomerSseClient, openSseStream } from "./sse.js";
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

// One live stream per customer carrying every customer-facing event:
// "notification", "quote_message" and "complaint_message". Only events
// addressed to this customer are delivered (see pushToCustomer in sse.ts).
export const portalStreamRouter: Router = Router();

portalStreamRouter.get("/", requireCustomer, (req, res) => {
  const cust = req.auth!;
  if (!isCustomer(cust)) {
    res.status(403).end();
    return;
  }
  openSseStream(req, res, () => addCustomerSseClient(cust.branchId, cust.customerId, res));
});
