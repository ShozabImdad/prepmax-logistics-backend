// Plain SQL migration runner.
//
//   npm run migrate         -> apply all pending migrations
//   npm run migrate:status  -> show applied vs pending
//
// Runs the numbered .sql files in src/db/migrations in order, each in its own
// transaction, recording applied ones in a _migrations table. Connects as the
// ADMIN role because migrations create tables, roles, policies, and GRANTs
// that the least-privilege app role isn't allowed to perform.

import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requireAdminDb } from "../config/env.js";

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "db", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filenames are zero-padded numeric, so lexical sort = correct order
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>("SELECT name FROM _migrations");
  return new Set(rows.map((r) => r.name));
}

async function run(): Promise<void> {
  const mode = process.argv[2] ?? "apply";
  const client = new Client(requireAdminDb());
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await appliedSet(client);
    const files = migrationFiles();

    if (mode === "status") {
      console.log("Migrations:");
      for (const f of files) {
        console.log(`  [${applied.has(f) ? "x" : " "}] ${f}`);
      }
      return;
    }

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log("No pending migrations. Database is up to date.");
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`Applying ${file} ... `);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log("ok");
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }
    console.log(`\nApplied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error("\nMigration error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
