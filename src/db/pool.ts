// The database access layer — and the heart of branch isolation.
//
// The app connects as a LEAST-PRIVILEGE role (config.appDb) that does NOT own
// the tables and does NOT have BYPASSRLS. Combined with FORCE ROW LEVEL
// SECURITY on every table, this means the app physically cannot read another
// branch's rows unless the correct branch context is set.
//
// RLS context is set PER TRANSACTION with `set_config(..., true)` (the `true`
// = transaction-local). This is essential with a connection pool: a plain
// session-level SET would leak onto the next request that reuses the pooled
// connection. Every query that touches branch-scoped data MUST run inside
// withBranchContext / withSystemContext so the context is set.

import pg from "pg";
import { config } from "../config/env.js";

const { Pool } = pg;

export const pool = new Pool({
  host: config.appDb.host,
  port: config.appDb.port,
  database: config.appDb.database,
  user: config.appDb.user,
  password: config.appDb.password,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type Sql = pg.PoolClient;

/**
 * Run `fn` inside a transaction with the branch context set, so RLS policies
 * filter every query to this branch. Commits on success, rolls back on throw.
 *
 * @param branchId  the branch whose data should be visible
 * @param isSuperAdmin  when true, also flags the session as super-admin so
 *   super-admin-only policies (cross-branch reads) apply. Still scoped to the
 *   single branchId passed — super-admin views one branch at a time by setting
 *   branchId to the branch they're viewing.
 */
export async function withBranchContext<T>(
  branchId: string,
  isSuperAdmin: boolean,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config(key, value, is_local=true) — scoped to THIS transaction only.
    await client.query("SELECT set_config('app.branch_id', $1, true)", [branchId]);
    await client.query("SELECT set_config('app.is_super_admin', $1, true)", [
      isSuperAdmin ? "on" : "off",
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Super-admin cross-branch access: sets an explicit "all branches" context.
 * ONLY call this behind a verified super-admin authorization check. It sets
 * app.is_super_admin=on and app.all_branches=on, which the RLS policies honor
 * to allow reads across every branch (see the migration policies).
 */
export async function withSuperAdminAllBranches<T>(
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_super_admin', 'on', true)");
    await client.query("SELECT set_config('app.all_branches', 'on', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * For operations that are intentionally global and not branch-scoped — e.g.
 * looking up a user by email at login (before we know their branch), or
 * managing the branches table itself. Runs in a transaction WITHOUT any branch
 * context. Tables that must never be readable this way still have RLS; this is
 * only for tables/policies explicitly designed for it (users, branches).
 */
export async function withoutContext<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
