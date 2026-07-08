// Auth service: login (verify credentials → create session) and resolving a
// session into a full Principal (role, branch, effective permissions).
//
// Lookups happen before branch context exists, so they run via withoutContext.
// The users/customers RLS policies explicitly allow a SELECT when no branch
// context is set (the login path) — see migrations 0002/0003.

import { withoutContext } from "../../db/pool.js";
import { verifyPassword } from "../../lib/password.js";
import {
  createUserSession,
  createCustomerSession,
  loadSession,
  destroySession,
} from "../../lib/session.js";
import type { Principal, StaffPrincipal, CustomerPrincipal, StaffRole } from "./types.js";

interface UserRow {
  id: string;
  public_id: string;
  branch_id: string | null;
  role: StaffRole;
  email: string;
  password_hash: string;
  full_name: string;
  is_active: boolean;
}
interface CustomerRow {
  id: string;
  public_id: string;
  branch_id: string;
  email: string;
  password_hash: string;
  full_name: string;
  is_active: boolean;
}

/** Effective permission keys for a staff user. super_admin implicitly has all. */
async function loadPermissions(userId: string, role: StaffRole): Promise<Set<string>> {
  if (role === "super_admin") {
    const keys = await withoutContext(async (sql) => {
      const { rows } = await sql.query<{ key: string }>("SELECT key FROM permissions");
      return rows.map((r) => r.key);
    });
    return new Set(keys);
  }
  const keys = await withoutContext(async (sql) => {
    const { rows } = await sql.query<{ key: string }>(
      `SELECT DISTINCT p.key
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p       ON p.id = rp.permission_id
        WHERE ur.user_id = $1`,
      [userId],
    );
    return rows.map((r) => r.key);
  });
  return new Set(keys);
}

export interface LoginResult {
  sessionId: string;
  principal: Principal;
}

/** Staff login. Returns null on bad credentials or inactive account. */
export async function loginStaff(email: string, password: string): Promise<LoginResult | null> {
  const user = await withoutContext(async (sql) => {
    const { rows } = await sql.query<UserRow>(
      `SELECT id, public_id, branch_id, role, email, password_hash, full_name, is_active
         FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  });
  if (!user || !user.is_active) return null;
  if (!(await verifyPassword(user.password_hash, password))) return null;

  const permissions = await loadPermissions(user.id, user.role);
  const sessionId = await createUserSession(user.id);
  const principal: StaffPrincipal = {
    kind: "user",
    userId: user.id,
    publicId: user.public_id,
    role: user.role,
    branchId: user.branch_id,
    email: user.email,
    fullName: user.full_name,
    permissions,
  };
  return { sessionId, principal };
}

/** Customer login. Email is unique per branch, so we match on email globally
 *  and, if duplicates existed across branches, would need a branch selector;
 *  for now emails are treated as unique enough for the portal login. */
export async function loginCustomer(email: string, password: string): Promise<LoginResult | null> {
  const customer = await withoutContext(async (sql) => {
    const { rows } = await sql.query<CustomerRow>(
      `SELECT id, public_id, branch_id, email, password_hash, full_name, is_active
         FROM customers WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  });
  if (!customer || !customer.is_active) return null;
  if (!(await verifyPassword(customer.password_hash, password))) return null;

  const sessionId = await createCustomerSession(customer.id);
  const principal: CustomerPrincipal = {
    kind: "customer",
    customerId: customer.id,
    publicId: customer.public_id,
    branchId: customer.branch_id,
    email: customer.email,
    fullName: customer.full_name,
  };
  return { sessionId, principal };
}

/** Resolve a session id into the current Principal, or null if invalid. */
export async function resolvePrincipal(sessionId: string): Promise<Principal | null> {
  const session = await loadSession(sessionId);
  if (!session) return null;

  if (session.principal === "user" && session.user_id) {
    const user = await withoutContext(async (sql) => {
      const { rows } = await sql.query<UserRow>(
        `SELECT id, public_id, branch_id, role, email, password_hash, full_name, is_active
           FROM users WHERE id = $1`,
        [session.user_id],
      );
      return rows[0] ?? null;
    });
    if (!user || !user.is_active) return null;
    const permissions = await loadPermissions(user.id, user.role);
    return {
      kind: "user",
      userId: user.id,
      publicId: user.public_id,
      role: user.role,
      branchId: user.branch_id,
      email: user.email,
      fullName: user.full_name,
      permissions,
    };
  }

  if (session.principal === "customer" && session.customer_id) {
    const customer = await withoutContext(async (sql) => {
      const { rows } = await sql.query<CustomerRow>(
        `SELECT id, public_id, branch_id, email, password_hash, full_name, is_active
           FROM customers WHERE id = $1`,
        [session.customer_id],
      );
      return rows[0] ?? null;
    });
    if (!customer || !customer.is_active) return null;
    return {
      kind: "customer",
      customerId: customer.id,
      publicId: customer.public_id,
      branchId: customer.branch_id,
      email: customer.email,
      fullName: customer.full_name,
    };
  }

  return null;
}

export async function logout(sessionId: string): Promise<void> {
  await destroySession(sessionId);
}
