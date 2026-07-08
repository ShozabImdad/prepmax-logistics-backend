// Augments Express's Request with the authenticated principal + a helper to run
// DB work in the correct branch context for this request.

import type { Sql } from "../db/pool.js";
import type { Principal } from "../modules/auth/types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The logged-in principal (staff or customer), or undefined if anonymous. */
      auth?: Principal;
      /** Session id from the cookie, if present. */
      sessionId?: string;
      /**
       * Run DB work inside this request's branch context (RLS applied).
       * Set by attachDbContext once the principal is known. For anonymous
       * requests it is undefined.
       */
      db?: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;
    }
  }
}

export {};
