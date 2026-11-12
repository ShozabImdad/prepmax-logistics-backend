// Notification routes for staff: list, unread count, mark-all-read, and the
// live SSE stream. All branch-scoped via req.db / the principal's branch.

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff } from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";
import { listNotifications, unreadCount, markAllRead } from "./service.js";
import { addStaffSseClient, openSseStream } from "./sse.js";

export const notificationRouter: Router = Router();

notificationRouter.get(
  "/",
  requireStaff,
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unread === "true";
    const items = await listNotifications(req.db!, { unreadOnly });
    const unread = await unreadCount(req.db!);
    return res.json({ notifications: items, unread });
  }),
);

notificationRouter.post(
  "/read-all",
  requireStaff,
  asyncHandler(async (req, res) => {
    const n = await markAllRead(req.db!);
    return res.json({ ok: true, marked: n });
  }),
);

// Live stream (SSE). The admin panel opens this to receive notifications
// instantly. Scoped to the staff member's branch.
notificationRouter.get("/stream", requireStaff, (req, res) => {
  const staff = req.auth!;
  if (!isStaff(staff)) {
    res.status(403).end();
    return;
  }
  // branch_manager subscribes to their own branch; super_admin (branchId
  // null) subscribes to all branches — addStaffSseClient/pushToBranch both
  // understand null as "every branch".
  const branchId = staff.branchId;

  openSseStream(req, res, () => addStaffSseClient(branchId, staff.userId, res));
});