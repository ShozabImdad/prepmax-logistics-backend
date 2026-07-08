// Auth + branch-context middleware — the runtime bridge to the RLS foundation.
//
// Pipeline per request:
//   1. loadAuth        — read the session cookie, resolve the Principal (or none)
//   2. (route guards)  — requireStaff / requireCustomer / requirePermission
//   3. req.db(...)     — runs queries inside this principal's branch context
//
// The branch context is where §1's isolation actually gets enforced at runtime:
//   - staff branch_manager  → withBranchContext(their branch)
//   - customer              → withBranchContext(their branch)
//   - super_admin (default) → all-branches context (can be narrowed per route)

import type { Request, Response, NextFunction } from "express";
import { withBranchContext, withSuperAdminAllBranches, type Sql } from "../db/pool.js";
import { resolvePrincipal, SESSION_COOKIE } from "../modules/auth/index.js";
import { isStaff, isCustomer, type Principal } from "../modules/auth/types.js";

// Build the req.db helper bound to a principal's context.
function makeDbForPrincipal(p: Principal): <T>(fn: (sql: Sql) => Promise<T>) => Promise<T> {
  if (isStaff(p)) {
    if (p.role === "super_admin") {
      // Super-admin default: all-branches read/write. Individual routes may
      // instead call withBranchContext(specificBranch) to act within one branch.
      return (fn) => withSuperAdminAllBranches(fn);
    }
    // branch_manager: scoped to their branch.
    return (fn) => withBranchContext(p.branchId!, false, fn);
  }
  // customer: scoped to their branch (row-level order ownership enforced in routes).
  return (fn) => withBranchContext((p as Extract<Principal, { kind: "customer" }>).branchId, false, fn);
}

/** Populate req.auth / req.db from the session cookie. Never rejects. */
export async function loadAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) {
      req.sessionId = sid;
      const principal = await resolvePrincipal(sid);
      if (principal) {
        req.auth = principal;
        req.db = makeDbForPrincipal(principal);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ── Route guards ────────────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  if (!isStaff(req.auth)) {
    res.status(403).json({ error: "Staff access required" });
    return;
  }
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isStaff(req.auth) || req.auth.role !== "super_admin") {
    res.status(403).json({ error: "Super-admin access required" });
    return;
  }
  next();
}

export function requireCustomer(req: Request, res: Response, next: NextFunction): void {
  if (!isCustomer(req.auth)) {
    res.status(403).json({ error: "Customer access required" });
    return;
  }
  next();
}

/**
 * Enforce a permission on a staff request. super_admin passes everything (their
 * permission set includes all keys). This is the BACKEND enforcement that
 * makes the toggle page real — the UI hiding a page is only cosmetic.
 */
export function requirePermission(key: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isStaff(req.auth)) {
      res.status(403).json({ error: "Staff access required" });
      return;
    }
    if (!req.auth.permissions.has(key)) {
      res.status(403).json({ error: `Missing permission: ${key}` });
      return;
    }
    next();
  };
}
