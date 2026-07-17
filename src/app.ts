// Express app assembly. Kept separate from index.ts so tests can import the
// app without starting a listener.

import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import "./middleware/types.js"; // augments Express.Request
import { loadAuth } from "./middleware/auth.js";
import { authRouter } from "./modules/auth/routes.js";
import { accountsRouter } from "./modules/accounts/routes.js";
import { orderRouter, portalOrderRouter } from "./modules/orders/routes.js";
import { documentRouter, portalDocumentRouter } from "./modules/documents/routes.js";
import { notificationRouter } from "./modules/notifications/routes.js";
import { publicTrackingRouter } from "./modules/tracking/routes.js";
import { publicAccountRequestRouter, accountRequestRouter } from "./modules/account-requests/routes.js";
import { permissionsRouter } from "./modules/permissions/routes.js";
import { staffRouter } from "./modules/staff/routes.js";
import { analyticsRouter } from "./modules/analytics/routes.js";
import { complaintRouter, portalComplaintRouter } from "./modules/complaints/routes.js";
import { financeRouter } from "./modules/finance/routes.js";
import { quoteRouter, portalQuoteRouter } from "./modules/quotes/routes.js";

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());

  // Health check (no auth).
  app.get("/health", (_req, res) => res.json({ ok: true, service: "prep-max-backend" }));

  // Public endpoints (no auth).
  app.use("/api/track", publicTrackingRouter);
  app.use("/api/account-requests", publicAccountRequestRouter);

  // Populate req.auth / req.db from the session cookie on every request.
  app.use(loadAuth);

  // Feature routers.
  app.use("/api/auth", authRouter);
  app.use("/api/accounts", accountsRouter);
  app.use("/api/orders", orderRouter);
  app.use("/api/orders", documentRouter);          // /:publicId/awb.pdf, /receipt.pdf
  app.use("/api/portal/orders", portalOrderRouter);
  app.use("/api/portal/orders", portalDocumentRouter); // /:publicId/receipt.pdf
  app.use("/api/notifications", notificationRouter);
  app.use("/api/account-requests", accountRequestRouter); // staff GET/status (public POST mounted above)
  app.use("/api/permissions", permissionsRouter);
  app.use("/api/staff", staffRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/complaints", complaintRouter);
  app.use("/api/finance", financeRouter);
  app.use("/api/portal/complaints", portalComplaintRouter);
  app.use("/api/quotes", quoteRouter);
  app.use("/api/portal/quotes", portalQuoteRouter);

  // 404 for unknown API routes.
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // Central error handler.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Internal error";
    // Log full error server-side; return a safe message to the client.
    console.error("[error]", err);
    res.status(500).json({ error: message });
  });

  return app;
}
