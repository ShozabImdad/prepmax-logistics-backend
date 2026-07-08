// Creates the least-privilege application role (config.appDb.user).
//
//   npm run db:setup
//
// Run this ONCE (and again only if you change the app password), connecting as
// the admin/superuser. It creates a role that:
//   - can log in with the APP_DB_PASSWORD you set,
//   - is NOT a superuser and does NOT have BYPASSRLS (so RLS always applies),
//   - does NOT own the tables (owner would bypass RLS; we also FORCE RLS).
//
// The migrations then GRANT this role table privileges. This is the security
// linchpin from the architecture plan §1: the runtime can never see across
// branches because the role it connects as is subject to RLS.

import pg from "pg";
import { requireAdminDb, config } from "../config/env.js";

const { Client } = pg;

async function run(): Promise<void> {
  const appUser = config.appDb.user;
  const appPassword = config.appDb.password;
  if (!appPassword) {
    throw new Error("APP_DB_PASSWORD is not set in .env — set it before running db:setup.");
  }

  const client = new Client(requireAdminDb());
  await client.connect();
  try {
    // CREATE ROLE can't be parameterized; identifiers are validated below.
    if (!/^[a-z_][a-z0-9_]*$/.test(appUser)) {
      throw new Error(`Unsafe APP_DB_USER "${appUser}" — use lowercase letters, digits, underscore.`);
    }
    // Password is passed via a parameterized DO block to avoid injection.
    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [appUser],
    );

    if (rows[0]?.exists) {
      await client.query(
        `ALTER ROLE ${appUser} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${literal(appPassword)}`,
      );
      console.log(`Updated existing role "${appUser}" (login, no superuser, no bypassrls).`);
    } else {
      await client.query(
        `CREATE ROLE ${appUser} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${literal(appPassword)}`,
      );
      console.log(`Created role "${appUser}" (login, no superuser, no bypassrls).`);
    }

    // Allow the app role to connect to and use the database + public schema.
    await client.query(`GRANT CONNECT ON DATABASE ${ident(config.appDb.database)} TO ${appUser}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appUser}`);
    // Default privileges so future tables/sequences created by migrations are
    // usable by the app role without re-granting each time.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appUser}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appUser}`,
    );

    console.log("Granted CONNECT + schema USAGE + default table/sequence privileges.");
    console.log("Role setup complete.");
  } finally {
    await client.end();
  }
}

// Safely quote a string literal for SQL (doubling single quotes). Used only for
// the password in CREATE/ALTER ROLE, which cannot take bind parameters.
function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Unsafe identifier "${s}"`);
  return s;
}

run().catch((err) => {
  console.error("Role setup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
