// Loads and validates environment configuration.
//
// We read a .env file manually (no dotenv dependency) so the backend has zero
// hidden config magic. Two distinct DB connections are defined:
//   - admin: superuser-level, used ONLY by scripts/setup-roles.ts to create the
//     least-privilege app role. Never used at runtime.
//   - app: the least-privilege role the server actually runs as. It cannot
//     bypass RLS, which is the whole point (see the architecture plan §1).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", "..", ".env");

// Minimal .env parser: KEY=VALUE lines, ignores blanks and # comments.
function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(ENV_PATH, "utf8");
  } catch {
    return; // no .env file — rely on real process.env (e.g. in production)
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export interface DbConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export const config = {
  nodeEnv: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "4000")),
  sessionSecret: optional("SESSION_SECRET", "dev-insecure-change-me"),

  // Email (Nodemailer SMTP). When SMTP_HOST + SMTP_USER + SMTP_PASS are all
  // set, real email is sent through that relay (e.g. Brevo). When any is
  // missing, the mailer runs in LOG-ONLY mode: emails are rendered + recorded
  // in email_log but not transmitted (safe for dev). Swap providers by
  // changing these four values — no code change.
  smtp: {
    host: optional("SMTP_HOST", ""),
    port: Number(optional("SMTP_PORT", "587")),
    user: optional("SMTP_USER", ""),
    pass: optional("SMTP_PASS", ""),
    // "true" for port 465 (implicit TLS); false for 587 (STARTTLS).
    secure: optional("SMTP_SECURE", "false") === "true",
  },
  mailFrom: optional("MAIL_FROM", "Prep Max Logistics <no-reply@example.com>"),
  // Base URL of the customer portal, used to build tracking links in emails.
  portalBaseUrl: optional("PORTAL_BASE_URL", "http://localhost:3000"),

  // Admin/superuser connection — for role setup only.
  adminDb: {
    host: optional("PGADMIN_HOST", "localhost"),
    port: Number(optional("PGADMIN_PORT", "5432")),
    database: optional("PGADMIN_DATABASE", "prep_max"),
    user: optional("PGADMIN_USER", "postgres"),
    password: optional("PGADMIN_PASSWORD", ""),
  } satisfies DbConnection,

  // Runtime application connection — least privilege.
  appDb: {
    host: optional("APP_DB_HOST", "localhost"),
    port: Number(optional("APP_DB_PORT", "5432")),
    database: optional("APP_DB_DATABASE", "prep_max"),
    user: optional("APP_DB_USER", "prep_app"),
    password: optional("APP_DB_PASSWORD", ""),
  } satisfies DbConnection,
};

export function requireAdminDb(): DbConnection {
  return {
    host: config.adminDb.host,
    port: config.adminDb.port,
    database: config.adminDb.database,
    user: required("PGADMIN_USER"),
    password: required("PGADMIN_PASSWORD"),
  };
}
