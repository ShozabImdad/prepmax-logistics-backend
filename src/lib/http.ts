// Small HTTP helpers: async handler wrapper + a cookie options helper.

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { config } from "../config/env.js";

/** Wrap an async handler so thrown errors reach Express's error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Secure cookie options for the session cookie. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.nodeEnv === "production", // requires HTTPS in prod
    sameSite: "lax" as const,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  };
}
