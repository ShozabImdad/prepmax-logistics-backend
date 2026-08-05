// Password-reset token helpers.
//
// The raw token is a random 256-bit value sent to the user via email and
// held only in their browser URL. We never store it — only its SHA-256 hash,
// mirroring how session ids are opaque/unguessable and how passwords are
// hashed rather than stored in the clear. A stolen DB dump therefore can't
// be used to reset anyone's password.

import { randomBytes, createHash } from "node:crypto";

export const RESET_TOKEN_TTL_MS = 1000 * 60 * 30; // 30 minutes

export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
