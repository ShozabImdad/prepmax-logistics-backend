// Seeds the first super-admin account and a default branch-manager role.
//
//   npm run seed              (uses defaults below / env)
//
// Idempotent: re-running updates the super-admin password and re-ensures the
// default role + permissions. Connects as ADMIN (owner) to bypass RLS for
// seeding, same as migrations.

import pg from "pg";
import { requireAdminDb } from "../config/env.js";
import { hashPassword } from "../lib/password.js";
import { publicId } from "../lib/ids.js";

const { Client } = pg;

const SUPER_EMAIL = process.env.SEED_SUPERADMIN_EMAIL ?? "admin@prepmax.local";
const SUPER_PASSWORD = process.env.SEED_SUPERADMIN_PASSWORD ?? "ChangeMe123!";
const SUPER_NAME = process.env.SEED_SUPERADMIN_NAME ?? "Super Admin";

// The permission keys a default branch-manager role should hold. Super-admin
// implicitly has all; this is the starting toggle set for managers.
const MANAGER_PERMISSIONS = [
  "orders.view", "orders.create", "orders.edit", "orders.approve", "orders.cancel",
  "tracking.view", "tracking.manage",
  "customers.view", "customers.create", "customers.edit",
  "documents.print", "reports.view",
  "complaints.view", "complaints.manage",
];

async function run(): Promise<void> {
  const client = new Client(requireAdminDb());
  await client.connect();
  try {
    // 1. super-admin user
    const hash = await hashPassword(SUPER_PASSWORD);
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = lower($1)",
      [SUPER_EMAIL],
    );
    if (existing.rows[0]) {
      await client.query("UPDATE users SET password_hash = $1, is_active = true WHERE id = $2", [
        hash,
        existing.rows[0].id,
      ]);
      console.log(`Updated super-admin: ${SUPER_EMAIL}`);
    } else {
      await client.query(
        `INSERT INTO users (public_id, branch_id, role, email, password_hash, full_name)
         VALUES ($1, NULL, 'super_admin', $2, $3, $4)`,
        [publicId(), SUPER_EMAIL, hash, SUPER_NAME],
      );
      console.log(`Created super-admin: ${SUPER_EMAIL}  (password: ${SUPER_PASSWORD})`);
    }

    // 2. default global "Branch Manager" role + its permissions
    let roleId: string;
    const role = await client.query<{ id: string }>(
      "SELECT id FROM roles WHERE branch_id IS NULL AND name = 'Branch Manager'",
    );
    if (role.rows[0]) {
      roleId = role.rows[0].id;
    } else {
      const r = await client.query<{ id: string }>(
        "INSERT INTO roles (branch_id, name, is_system) VALUES (NULL, 'Branch Manager', true) RETURNING id",
      );
      roleId = r.rows[0]!.id;
      console.log("Created default 'Branch Manager' role.");
    }
    // (re)apply the permission set
    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE key = ANY($2)`,
      [roleId, MANAGER_PERMISSIONS],
    );
    console.log(`Applied ${MANAGER_PERMISSIONS.length} permissions to 'Branch Manager' role.`);

    console.log("\nSeed complete.");
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error("Seed error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
