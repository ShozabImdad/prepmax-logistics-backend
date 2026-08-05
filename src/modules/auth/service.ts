// Auth service: login (verify credentials → create session) and resolving a
// session into a full Principal (role, branch, effective permissions).
//
// Lookups happen before branch context exists, so they run via withoutContext.
// The users/customers RLS policies explicitly allow a SELECT when no branch
// context is set (the login path) — see migrations 0002/0003.

import type { Sql } from "../../db/pool.js";
import { withoutContext, withSuperAdminAllBranches } from "../../db/pool.js";
import { verifyPassword, hashPassword } from "../../lib/password.js";
import {
  createUserSession,
  createCustomerSession,
  loadSession,
  destroySession,
} from "../../lib/session.js";
import { generateResetToken, hashResetToken, RESET_TOKEN_TTL_MS } from "../../lib/reset-token.js";
import { sendPasswordResetEmail, buildResetUrl } from "./reset-email.js";
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

/** Names of the custom RBAC roles assigned to a staff user (via user_roles). */
async function loadRoleNames(userId: string, role: StaffRole): Promise<string[]> {
  if (role === "super_admin") return ["Super Admin"];
  const names = await withoutContext(async (sql) => {
    const { rows } = await sql.query<{ name: string }>(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [userId],
    );
    return rows.map((r) => r.name);
  });
  return names;
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
  const roleNames = await loadRoleNames(user.id, user.role);
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
    roleNames,
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
    const roleNames = await loadRoleNames(user.id, user.role);
    return {
      kind: "user",
      userId: user.id,
      publicId: user.public_id,
      role: user.role,
      branchId: user.branch_id,
      email: user.email,
      fullName: user.full_name,
      permissions,
      roleNames,
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

// ----------------------------------------------------------------------------
// Forgot / reset password
//
// Both flows return generic success regardless of whether the email exists,
// so the endpoint can't be used to enumerate registered accounts. Tokens are
// single-use, short-lived, and stored only as a hash (see lib/reset-token.ts).
// A successful reset destroys all existing sessions for that account.
// ----------------------------------------------------------------------------

async function findActiveUserByEmail(email: string): Promise<UserRow | null> {
  return withoutContext(async (sql) => {
    const { rows } = await sql.query<UserRow>(
      `SELECT id, public_id, branch_id, role, email, password_hash, full_name, is_active
         FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  });
}

async function findActiveCustomerByEmail(email: string): Promise<CustomerRow | null> {
  return withoutContext(async (sql) => {
    const { rows } = await sql.query<CustomerRow>(
      `SELECT id, public_id, branch_id, email, password_hash, full_name, is_active
         FROM customers WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  });
}

/** Staff "forgot password". Always resolves — never reveals whether the email exists. */
export async function requestStaffPasswordReset(email: string): Promise<void> {
  const user = await findActiveUserByEmail(email);
  if (!user || !user.is_active) return;

  const rawToken = generateResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await withoutContext(async (sql) => {
    await sql.query(
      `INSERT INTO password_resets (principal, user_id, token_hash, expires_at)
       VALUES ('user', $1, $2, $3)`,
      [user.id, tokenHash, expiresAt],
    );
  });

  await sendPasswordResetEmail({
    to: user.email,
    fullName: user.full_name,
    resetUrl: buildResetUrl("staff", rawToken),
  });
}

/** Customer "forgot password". Always resolves — never reveals whether the email exists. */
export async function requestCustomerPasswordReset(email: string): Promise<void> {
  const customer = await findActiveCustomerByEmail(email);
  if (!customer || !customer.is_active) return;

  const rawToken = generateResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await withoutContext(async (sql) => {
    await sql.query(
      `INSERT INTO password_resets (principal, customer_id, token_hash, expires_at)
       VALUES ('customer', $1, $2, $3)`,
      [customer.id, tokenHash, expiresAt],
    );
  });

  await sendPasswordResetEmail({
    to: customer.email,
    fullName: customer.full_name,
    resetUrl: buildResetUrl("customer", rawToken),
  });
}

interface PasswordResetRow {
  id: string;
  principal: "user" | "customer";
  user_id: string | null;
  customer_id: string | null;
  expires_at: Date;
  used_at: Date | null;
}

export type ResetPasswordError = "invalid_or_expired";

/** Shared token lookup: valid, unused, unexpired, and matching the expected principal kind. */
async function loadValidResetRecord(
  rawToken: string,
  principal: "user" | "customer",
): Promise<PasswordResetRow | null> {
  const tokenHash = hashResetToken(rawToken);
  return withoutContext(async (sql) => {
    const { rows } = await sql.query<PasswordResetRow>(
      `SELECT id, principal, user_id, customer_id, expires_at, used_at
         FROM password_resets WHERE token_hash = $1 AND principal = $2`,
      [tokenHash, principal],
    );
    const record = rows[0];
    if (!record) return null;
    if (record.used_at) return null;
    if (new Date(record.expires_at).getTime() < Date.now()) return null;
    return record;
  });
}

export type ChangePasswordError = "wrong_current_password";

/**
 * Self-service "change my password" for a logged-in staff user — distinct
 * from the forgot/reset flow: requires knowing the CURRENT password, runs
 * inside the request's own (already-authorized) branch/db context rather
 * than an elevated one, and keeps the current session alive while revoking
 * every other session for the account (other signed-in devices/tabs).
 *
 * @param db  the request's scoped db runner (req.db) — already carries the
 *   correct RLS context for this authenticated user, so no elevated context
 *   is needed here (unlike the token-based reset flow).
 */
export async function changeOwnStaffPassword(
  db: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
  userId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordError | null> {
  return db(async (sql) => {
    const { rows } = await sql.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId],
    );
    const current = rows[0];
    if (!current || !(await verifyPassword(current.password_hash, currentPassword))) {
      return "wrong_current_password";
    }

    // `users` writes are normally super-admin-only (RLS: see 0033), which is
    // right for admin CRUD on OTHER staff accounts but would also block a
    // branch_manager from updating their OWN row here. Flag "this row is the
    // acting principal's own account" for just this UPDATE — transaction-
    // local via set_config(..., true), so it never leaks to another request
    // on a pooled connection — which the 0040 users_self_update policy
    // permits regardless of role.
    await sql.query(`SELECT set_config('app.self_id', $1, true)`, [userId]);

    const passwordHash = await hashPassword(newPassword);
    const updated = await sql.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id`,
      [passwordHash, userId],
    );
    if (updated.rowCount === 0) {
      throw new Error(`Change password: users UPDATE affected 0 rows for user_id=${userId}`);
    }

    // Revoke every other session for this account, but keep the one making
    // this request alive so the user isn't logged out by changing their own
    // password.
    await sql.query(`DELETE FROM sessions WHERE user_id = $1 AND id != $2`, [userId, currentSessionId]);
    return null;
  });
}

/** Self-service "change my password" for a logged-in customer. Same shape as the staff version above. */
export async function changeOwnCustomerPassword(
  db: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
  customerId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordError | null> {
  return db(async (sql) => {
    const { rows } = await sql.query<{ password_hash: string }>(
      `SELECT password_hash FROM customers WHERE id = $1`,
      [customerId],
    );
    const current = rows[0];
    if (!current || !(await verifyPassword(current.password_hash, currentPassword))) {
      return "wrong_current_password";
    }

    const passwordHash = await hashPassword(newPassword);
    const updated = await sql.query(
      `UPDATE customers SET password_hash = $1 WHERE id = $2 RETURNING id`,
      [passwordHash, customerId],
    );
    if (updated.rowCount === 0) {
      throw new Error(`Change password: customers UPDATE affected 0 rows for customer_id=${customerId}`);
    }

    await sql.query(`DELETE FROM sessions WHERE customer_id = $1 AND id != $2`, [customerId, currentSessionId]);
    return null;
  });
}

export interface StaffProfileExtra {
  branchName: string | null;
  createdAt: string;
}

/** Extra "my account" display fields for a staff user — branch name + when the account was created. */
export async function getOwnStaffProfile(
  db: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
  userId: string,
): Promise<StaffProfileExtra | null> {
  return db(async (sql) => {
    const { rows } = await sql.query<{ branch_name: string | null; created_at: Date }>(
      `SELECT b.name AS branch_name, u.created_at
         FROM users u LEFT JOIN branches b ON b.id = u.branch_id
        WHERE u.id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    return { branchName: row.branch_name, createdAt: row.created_at.toISOString() };
  });
}

export interface CustomerProfileExtra {
  phone: string | null;
  address: string | null;
  companyName: string | null;
  ntn: string | null;
  createdAt: string;
}

/** Extra "my account" display fields for a customer — contact/business details + when the account was created. */
export async function getOwnCustomerProfile(
  db: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
  customerId: string,
): Promise<CustomerProfileExtra | null> {
  return db(async (sql) => {
    const { rows } = await sql.query<{
      phone: string | null;
      address: string | null;
      company_name: string | null;
      ntn: string | null;
      created_at: Date;
    }>(
      `SELECT phone, address, company_name, ntn, created_at FROM customers WHERE id = $1`,
      [customerId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      phone: row.phone,
      address: row.address,
      companyName: row.company_name,
      ntn: row.ntn,
      createdAt: row.created_at.toISOString(),
    };
  });
}

/** Completes a staff password reset. Returns null on success, or an error code. */
export async function resetStaffPassword(
  rawToken: string,
  newPassword: string,
): Promise<ResetPasswordError | null> {
  const record = await loadValidResetRecord(rawToken, "user");
  if (!record || !record.user_id) return "invalid_or_expired";

  const passwordHash = await hashPassword(newPassword);
  // The users/customers RLS write policies require branch (or super-admin)
  // context — withoutContext silently updates ZERO rows against them (no
  // error thrown), which was the original bug: the token got marked used
  // but the password never actually changed. The reset token has already
  // been cryptographically verified above, which is our authorization here,
  // so withSuperAdminAllBranches is the correct escape hatch — same as any
  // other legitimate cross-branch system write.
  await withSuperAdminAllBranches(async (sql) => {
    const updated = await sql.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id`,
      [passwordHash, record.user_id],
    );
    if (updated.rowCount === 0) {
      throw new Error(`Password reset: users UPDATE affected 0 rows for user_id=${record.user_id}`);
    }
    await sql.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [record.id]);
    // Invalidate all other outstanding reset tokens and existing sessions for this account.
    await sql.query(
      `UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [record.user_id],
    );
    await sql.query(`DELETE FROM sessions WHERE user_id = $1`, [record.user_id]);
  });
  return null;
}

/** Completes a customer password reset. Returns null on success, or an error code. */
export async function resetCustomerPassword(
  rawToken: string,
  newPassword: string,
): Promise<ResetPasswordError | null> {
  const record = await loadValidResetRecord(rawToken, "customer");
  if (!record || !record.customer_id) return "invalid_or_expired";

  const passwordHash = await hashPassword(newPassword);
  await withSuperAdminAllBranches(async (sql) => {
    const updated = await sql.query(
      `UPDATE customers SET password_hash = $1 WHERE id = $2 RETURNING id`,
      [passwordHash, record.customer_id],
    );
    if (updated.rowCount === 0) {
      throw new Error(`Password reset: customers UPDATE affected 0 rows for customer_id=${record.customer_id}`);
    }
    await sql.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [record.id]);
    await sql.query(
      `UPDATE password_resets SET used_at = now() WHERE customer_id = $1 AND used_at IS NULL`,
      [record.customer_id],
    );
    await sql.query(`DELETE FROM sessions WHERE customer_id = $1`, [record.customer_id]);
  });
  return null;
}
