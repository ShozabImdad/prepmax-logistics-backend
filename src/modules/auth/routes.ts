// Auth routes: staff login, customer login, logout, and "who am I".

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sessionCookieOptions } from "../../lib/http.js";
import { SESSION_COOKIE } from "../../lib/session.js";
import {
  loginStaff,
  loginCustomer,
  logout,
  requestStaffPasswordReset,
  requestCustomerPasswordReset,
  resetStaffPassword,
  resetCustomerPassword,
  changeOwnStaffPassword,
  changeOwnCustomerPassword,
  getOwnStaffProfile,
  getOwnCustomerProfile,
} from "./service.js";
import { isStaff } from "./types.js";
import { requireAuth, requireStaff, requireCustomer } from "../../middleware/auth.js";

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotPasswordBody = z.object({
  email: z.string().email(),
});

const resetPasswordBody = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

// Generic response for forgot-password requests — identical whether or not
// the email is registered, so the endpoint can't be used to enumerate accounts.
const FORGOT_PASSWORD_ACK = {
  ok: true,
  message: "If an account with that email exists, a password reset link has been sent.",
};

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
        roleNames: isStaff(p) ? p.roleNames : undefined,
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

// Staff forgot password — always returns a generic ack (no enumeration).
authRouter.post(
  "/staff/forgot-password",
  asyncHandler(async (req, res) => {
    const parsed = forgotPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    await requestStaffPasswordReset(parsed.data.email);
    return res.json(FORGOT_PASSWORD_ACK);
  }),
);

// Staff reset password — consumes the emailed token, sets a new password,
// and revokes all existing sessions for that account.
authRouter.post(
  "/staff/reset-password",
  asyncHandler(async (req, res) => {
    const parsed = resetPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
    }
    const error = await resetStaffPassword(parsed.data.token, parsed.data.newPassword);
    if (error) return res.status(400).json({ error: "This reset link is invalid or has expired." });
    return res.json({ ok: true });
  }),
);

// Customer forgot password — always returns a generic ack (no enumeration).
authRouter.post(
  "/customer/forgot-password",
  asyncHandler(async (req, res) => {
    const parsed = forgotPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    await requestCustomerPasswordReset(parsed.data.email);
    return res.json(FORGOT_PASSWORD_ACK);
  }),
);

// Customer reset password — consumes the emailed token, sets a new password,
// and revokes all existing sessions for that account.
authRouter.post(
  "/customer/reset-password",
  asyncHandler(async (req, res) => {
    const parsed = resetPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
    }
    const error = await resetCustomerPassword(parsed.data.token, parsed.data.newPassword);
    if (error) return res.status(400).json({ error: "This reset link is invalid or has expired." });
    return res.json({ ok: true });
  }),
);

// Staff "change my password" — logged-in, requires current password.
// Distinct from /staff/reset-password: no token, just an authenticated
// session proving who you are plus your current password proving it's you.
authRouter.post(
  "/staff/change-password",
  requireAuth,
  requireStaff,
  asyncHandler(async (req, res) => {
    const parsed = changePasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
    }
    const p = req.auth!;
    if (!isStaff(p)) return res.status(403).json({ error: "Staff access required" });
    const error = await changeOwnStaffPassword(
      req.db!,
      p.userId,
      req.sessionId!,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    if (error === "wrong_current_password") {
      return res.status(400).json({ error: "Current password is incorrect." });
    }
    return res.json({ ok: true });
  }),
);

// Customer "change my password" — logged-in, requires current password.
authRouter.post(
  "/customer/change-password",
  requireAuth,
  requireCustomer,
  asyncHandler(async (req, res) => {
    const parsed = changePasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
    }
    const p = req.auth!;
    if (isStaff(p)) return res.status(403).json({ error: "Customer access required" });
    const error = await changeOwnCustomerPassword(
      req.db!,
      p.customerId,
      req.sessionId!,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    if (error === "wrong_current_password") {
      return res.status(400).json({ error: "Current password is incorrect." });
    }
    return res.json({ ok: true });
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
        roleNames: isStaff(p) ? p.roleNames : undefined,
      },
    });
  }),
);

// Extra "my account" display fields not carried on the session principal
// itself (branch name / created-at for staff; contact + business details for
// customers) — kept as a separate call so the hot path (every authed request
// resolving req.auth) doesn't pay for a join it rarely needs.
authRouter.get(
  "/me/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const p = req.auth!;
    if (isStaff(p)) {
      const profile = await getOwnStaffProfile(req.db!, p.userId);
      return res.json({ profile });
    }
    const profile = await getOwnCustomerProfile(req.db!, p.customerId);
    return res.json({ profile });
  }),
);
