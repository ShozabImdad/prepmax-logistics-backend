// Password hashing with Argon2id (architecture plan §11).
// argon2 picks safe defaults; we hash on account creation and verify on login.

import argon2 from "argon2";

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false; // malformed hash, etc. — treat as no match
  }
}
