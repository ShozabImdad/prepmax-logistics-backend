// ============================================================================
// Branch isolation tests — the security linchpin of the whole backend.
//
// These prove that the least-privilege app role (prep_app), which the server
// runs as, CANNOT cross branch boundaries no matter what:
//   1. With branch A context, only branch A rows are visible.
//   2. Branch A context cannot read / update / delete branch B rows.
//   3. With NO context set, NO branch rows are visible (fails closed).
//   4. INSERT with a mismatched branch_id is rejected by the WITH CHECK policy.
//   5. Super-admin all-branches context can read across branches.
//   6. The app role genuinely cannot bypass RLS (not a superuser / no bypassrls).
//
// Run: npm test    (uses the same DB as the app; seeds + cleans up its own rows)
// ============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { config } from "../src/config/env.js";
import {
  pool,
  withBranchContext,
  withSuperAdminAllBranches,
  withoutContext,
  closePool,
} from "../src/db/pool.js";
import { publicId, trackingCode } from "../src/lib/ids.js";

// Admin client (table owner) — used ONLY to seed/cleanup test rows, bypassing
// the app-role path. The app itself never uses this.
const admin = new pg.Client({
  host: config.adminDb.host,
  port: config.adminDb.port,
  database: config.adminDb.database,
  user: config.adminDb.user,
  password: config.adminDb.password,
});

let branchA = "";
let branchB = "";
let orderA = "";
let orderB = "";
const TAG = "__isolation_test__";

before(async () => {
  await admin.connect();
  // Seed two branches and one order each, as the owner (bypasses RLS for setup).
  const a = await admin.query(
    "INSERT INTO branches (public_id, name, city) VALUES ($1,$2,$3) RETURNING id",
    [publicId(), TAG + "A", "CityA"],
  );
  const b = await admin.query(
    "INSERT INTO branches (public_id, name, city) VALUES ($1,$2,$3) RETURNING id",
    [publicId(), TAG + "B", "CityB"],
  );
  branchA = a.rows[0].id;
  branchB = b.rows[0].id;

  const oa = await admin.query(
    "INSERT INTO orders (public_id, tracking_code, branch_id, order_status) VALUES ($1,$2,$3,'active') RETURNING id",
    [publicId(), trackingCode(), branchA],
  );
  const ob = await admin.query(
    "INSERT INTO orders (public_id, tracking_code, branch_id, order_status) VALUES ($1,$2,$3,'active') RETURNING id",
    [publicId(), trackingCode(), branchB],
  );
  orderA = oa.rows[0].id;
  orderB = ob.rows[0].id;
});

after(async () => {
  // Clean up as owner.
  await admin.query("DELETE FROM orders WHERE id = ANY($1)", [[orderA, orderB]]);
  await admin.query("DELETE FROM branches WHERE id = ANY($1)", [[branchA, branchB]]);
  await admin.end();
  await closePool();
});

test("1. branch A context sees only branch A orders", async () => {
  const rows = await withBranchContext(branchA, false, async (sql) => {
    const r = await sql.query("SELECT id, branch_id FROM orders WHERE branch_id = ANY($1)", [
      [branchA, branchB],
    ]);
    return r.rows;
  });
  assert.equal(rows.length, 1, "should see exactly one order");
  assert.equal(rows[0].id, orderA, "and it must be branch A's order");
});

test("2a. branch A context CANNOT read branch B's order by id", async () => {
  const rows = await withBranchContext(branchA, false, async (sql) => {
    const r = await sql.query("SELECT id FROM orders WHERE id = $1", [orderB]);
    return r.rows;
  });
  assert.equal(rows.length, 0, "branch B order must be invisible to branch A");
});

test("2b. branch A context CANNOT update branch B's order", async () => {
  const updated = await withBranchContext(branchA, false, async (sql) => {
    const r = await sql.query(
      "UPDATE orders SET notes = 'hacked' WHERE id = $1",
      [orderB],
    );
    return r.rowCount;
  });
  assert.equal(updated, 0, "update must affect 0 rows (B invisible to A)");
  // Confirm B is untouched, as owner.
  const check = await admin.query("SELECT notes FROM orders WHERE id = $1", [orderB]);
  assert.notEqual(check.rows[0].notes, "hacked");
});

test("2c. branch A context CANNOT delete branch B's order", async () => {
  const deleted = await withBranchContext(branchA, false, async (sql) => {
    const r = await sql.query("DELETE FROM orders WHERE id = $1", [orderB]);
    return r.rowCount;
  });
  assert.equal(deleted, 0, "delete must affect 0 rows");
  const check = await admin.query("SELECT count(*)::int AS n FROM orders WHERE id = $1", [orderB]);
  assert.equal(check.rows[0].n, 1, "branch B order must still exist");
});

test("3. no branch context = no rows visible (fails closed)", async () => {
  const rows = await withoutContext(async (sql) => {
    const r = await sql.query("SELECT id FROM orders WHERE id = ANY($1)", [[orderA, orderB]]);
    return r.rows;
  });
  assert.equal(rows.length, 0, "with no context, orders must be invisible");
});

test("4. INSERT with mismatched branch_id is rejected by WITH CHECK", async () => {
  await assert.rejects(
    () =>
      withBranchContext(branchA, false, async (sql) => {
        // Try to insert a branch B order while in branch A context.
        await sql.query(
          "INSERT INTO orders (public_id, tracking_code, branch_id, order_status) VALUES ($1,$2,$3,'active')",
          [publicId(), trackingCode(), branchB],
        );
      }),
    /row-level security|policy/i,
    "inserting another branch's row must be blocked by the WITH CHECK policy",
  );
});

test("5. super-admin all-branches context reads across branches", async () => {
  const rows = await withSuperAdminAllBranches(async (sql) => {
    const r = await sql.query("SELECT id FROM orders WHERE id = ANY($1)", [[orderA, orderB]]);
    return r.rows;
  });
  assert.equal(rows.length, 2, "super-admin all-branches sees both orders");
});

test("6. app role cannot bypass RLS (no superuser / no bypassrls)", async () => {
  const client = await pool.connect();
  try {
    const r = await client.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(r.rows[0].rolsuper, false, "app role must NOT be superuser");
    assert.equal(r.rows[0].rolbypassrls, false, "app role must NOT have bypassrls");
  } finally {
    client.release();
  }
});
