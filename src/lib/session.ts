// Server-side session management (DB-backed).
//
// The cookie only carries a random 256-bit session id; all session state lives
// in the `sessions` table. Deleting the row revokes the session immediately.
// Session rows are looked up before any branch context exists, so we use
// withoutContext (the sessions table has a permissive RLS policy and is keyed
// by the unguessable id).

import { randomBytes } from "node:crypto";
import { withoutContext } from "../db/pool.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const SESSION_COOKIE = "pml_sid";

export interface SessionRow {
  id: string;
  principal: "user" | "customer";
  user_id: string | null;
  customer_id: string | null;
  expires_at: Date;
}

function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export async function createUserSession(userId: string): Promise<string> {
  const id = newSessionId();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await withoutContext(async (sql) => {
    await sql.query(
      `INSERT INTO sessions (id, principal, user_id, expires_at) VALUES ($1,'user',$2,$3)`,
      [id, userId, expires],
    );
  });
  return id;
}

export async function createCustomerSession(customerId: string): Promise<string> {
  const id = newSessionId();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await withoutContext(async (sql) => {
    await sql.query(
      `INSERT INTO sessions (id, principal, customer_id, expires_at) VALUES ($1,'customer',$2,$3)`,
      [id, customerId, expires],
    );
  });
  return id;
}

/** Returns the (still-valid) session, or null. Expired sessions are deleted. */
export async function loadSession(id: string): Promise<SessionRow | null> {
  return withoutContext(async (sql) => {
    const { rows } = await sql.query<SessionRow>(
      `SELECT id, principal, user_id, customer_id, expires_at FROM sessions WHERE id = $1`,
      [id],
    );
    const s = rows[0];
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) {
      await sql.query(`DELETE FROM sessions WHERE id = $1`, [id]);
      return null;
    }
    await sql.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
    return s;
  });
}

export async function destroySession(id: string): Promise<void> {
  await withoutContext(async (sql) => {
    await sql.query(`DELETE FROM sessions WHERE id = $1`, [id]);
  });
}
