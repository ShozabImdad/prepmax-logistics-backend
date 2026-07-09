// Notification routes for staff: list, unread count, mark-all-read, and the
// live SSE stream. All branch-scoped via req.db / the principal's branch.

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff } from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";
import { listNotifications, unreadCount, markAllRead } from "./service.js";
import { addSseClient } from "./sse.js";

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
  // super_admin has no single branch; they subscribe to their own id-less
  // channel only if they later pick a branch. For now, require a branch.
  const branchId = staff.branchId;
  if (!branchId) {
    res.status(400).json({ error: "SSE stream is per-branch; super-admin should select a branch context" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const remove = addSseClient(branchId, staff.userId, res);
  // heartbeat to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    remove();
  });
});
