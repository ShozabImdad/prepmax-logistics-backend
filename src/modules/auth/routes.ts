// Auth routes: staff login, customer login, logout, and "who am I".

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sessionCookieOptions } from "../../lib/http.js";
import { SESSION_COOKIE } from "../../lib/session.js";
import { loginStaff, loginCustomer, logout } from "./service.js";
import { isStaff } from "./types.js";
import { requireAuth } from "../../middleware/auth.js";

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter: Router = Router();

// Staff login (super-admin / branch manager).
authRouter.post(
  "/staff/login",
  asyncHandler(async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const result = await loginStaff(parsed.data.email, parsed.data.password);
    if (!result) return res.status(401).json({ error: "Invalid email or password" });

    res.cookie(SESSION_COOKIE, result.sessionId, sessionCookieOptions());
    const p = result.principal;
    return res.json({
      principal: {
        kind: p.kind,
        role: isStaff(p) ? p.role : undefined,
        branchId: p.branchId,
        email: p.email,
        fullName: p.fullName,
        permissions: isStaff(p) ? [...p.permissions] : undefined,
      },
    });
  }),
);

// Customer login (portal).
authRouter.post(
  "/customer/login",
  asyncHandler(async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const result = await loginCustomer(parsed.data.email, parsed.data.password);
    if (!result) return res.status(401).json({ error: "Invalid email or password" });

    res.cookie(SESSION_COOKIE, result.sessionId, sessionCookieOptions());
    return res.json({
      principal: {
        kind: "customer",
        branchId: result.principal.branchId,
        email: result.principal.email,
        fullName: result.principal.fullName,
      },
    });
  }),
);

// Logout — destroys the server-side session (instant revocation).
authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    if (req.sessionId) await logout(req.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return res.json({ ok: true });
  }),
);

// Current principal.
authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const p = req.auth!;
    return res.json({
      principal: {
        kind: p.kind,
        role: isStaff(p) ? p.role : undefined,
        branchId: p.branchId,
        email: p.email,
        fullName: p.fullName,
        permissions: isStaff(p) ? [...p.permissions] : undefined,
      },
    });
  }),
);
