// Public tracking route — no auth. GET /api/track/:code
//
// Includes a light in-memory rate limit per IP to blunt scraping/enumeration
// of the public endpoint (the tracking codes are already unguessable, but this
// is defense in depth).

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { publicTrack } from "./public.js";

export const publicTrackingRouter: Router = Router();

// --- tiny fixed-window rate limiter (per IP) ---
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > MAX_PER_WINDOW;
}

publicTrackingRouter.get(
  "/:code",
  asyncHandler(async (req, res) => {
    const ip = req.ip ?? "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests — please try again shortly." });
    }
    const code = String(req.params.code ?? "").trim();
    if (!code) return res.status(400).json({ error: "Tracking code required" });

    const result = await publicTrack(code);
    if (!result) return res.status(404).json({ error: "No shipment found for that tracking number." });
    return res.json({ tracking: result });
  }),
);
