// Saved-contact (address book) queries. Runs through the request's
// branch-context runner (req.db), so RLS enforces branch isolation.

import type { Sql } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import type { CreateSavedContactInput, UpdateSavedContactInput } from "./schema.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export class SavedContactError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface SavedContact {
  publicId: string;
  kind: "sender" | "receiver" | "both";
  label: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  cnic: string | null;
  ntn: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postcode: string | null;
  ownerCustomerId: string | null; // present so the frontend can tell "mine" vs "branch book" when staff view a customer's contacts
  createdAt: string;
  updatedAt: string;
}

function mapRow(r: Record<string, unknown>): SavedContact {
  return {
    publicId: r.public_id as string,
    kind: r.kind as SavedContact["kind"],
    label: r.label as string,
    name: r.name as string,
    company: r.company as string | null,
    phone: r.phone as string | null,
    email: r.email as string | null,
    cnic: r.cnic as string | null,
    ntn: r.ntn as string | null,
    address: r.address as string | null,
    address2: r.address2 as string | null,
    city: r.city as string | null,
    state: r.state as string | null,
    country: r.country as string | null,
    postcode: r.postcode as string | null,
    ownerCustomerId: r.owner_customer_id as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const SELECT_COLS = `public_id, kind, label, name, company, phone, email, cnic, ntn,
  address, address2, city, state, country, postcode, owner_customer_id, created_at, updated_at`;

// ── Customer-owned (portal) ──────────────────────────────────────────────────

export async function createCustomerContact(
  run: Run,
  branchId: string,
  customerId: string,
  input: CreateSavedContactInput,
): Promise<SavedContact> {
  return run(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO saved_contacts (
         public_id, branch_id, owner_customer_id, kind, label,
         name, company, phone, email, cnic, ntn, address, address2, city, state, country, postcode
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING ${SELECT_COLS}`,
      [
        publicId(), branchId, customerId, input.kind, input.label,
        input.name, input.company || null, input.phone || null, input.email || null,
        input.cnic || null, input.ntn || null, input.address || null, input.address2 || null,
        input.city || null, input.state || null, input.country || null, input.postcode || null,
      ],
    );
    return mapRow(rows[0]!);
  });
}

export async function listCustomerContacts(run: Run, customerId: string): Promise<SavedContact[]> {
  return run(async (sql) => {
    const { rows } = await sql.query(
      `SELECT ${SELECT_COLS} FROM saved_contacts WHERE owner_customer_id = $1 ORDER BY label`,
      [customerId],
    );
    return rows.map(mapRow);
  });
}

export async function deleteCustomerContact(run: Run, customerId: string, contactPublicId: string): Promise<void> {
  await run(async (sql) => {
    const { rowCount } = await sql.query(
      "DELETE FROM saved_contacts WHERE public_id = $1 AND owner_customer_id = $2",
      [contactPublicId, customerId],
    );
    if (!rowCount) throw new SavedContactError(404, "Contact not found");
  });
}

// ── Staff (branch-wide book, or scoped to one customer) ─────────────────────

export async function createStaffContact(
  run: Run,
  branchId: string,
  userId: string,
  input: CreateSavedContactInput,
): Promise<SavedContact> {
  return run(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO saved_contacts (
         public_id, branch_id, created_by_user_id, kind, label,
         name, company, phone, email, cnic, ntn, address, address2, city, state, country, postcode
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING ${SELECT_COLS}`,
      [
        publicId(), branchId, userId, input.kind, input.label,
        input.name, input.company || null, input.phone || null, input.email || null,
        input.cnic || null, input.ntn || null, input.address || null, input.address2 || null,
        input.city || null, input.state || null, input.country || null, input.postcode || null,
      ],
    );
    return mapRow(rows[0]!);
  });
}

/**
 * List contacts visible to staff: the branch-wide book (created_by_user_id
 * set) by default, or — when customerPublicId is passed — that specific
 * customer's own saved contacts (e.g. staff building an order on behalf of a
 * known customer and wanting their usual addresses).
 */
export async function listStaffContacts(
  run: Run,
  opts: { customerPublicId?: string } = {},
): Promise<SavedContact[]> {
  return run(async (sql) => {
    if (opts.customerPublicId) {
      const { rows } = await sql.query(
        `SELECT ${SELECT_COLS} FROM saved_contacts sc
           JOIN customers c ON c.id = sc.owner_customer_id
          WHERE c.public_id = $1
          ORDER BY sc.label`,
        [opts.customerPublicId],
      );
      return rows.map(mapRow);
    }
    const { rows } = await sql.query(
      `SELECT ${SELECT_COLS} FROM saved_contacts WHERE created_by_user_id IS NOT NULL ORDER BY label`,
    );
    return rows.map(mapRow);
  });
}

export async function deleteStaffContact(run: Run, contactPublicId: string): Promise<void> {
  await run(async (sql) => {
    const { rowCount } = await sql.query(
      "DELETE FROM saved_contacts WHERE public_id = $1 AND created_by_user_id IS NOT NULL",
      [contactPublicId],
    );
    if (!rowCount) throw new SavedContactError(404, "Contact not found");
  });
}

/** Resolve a branch's internal id from its public id (super-admin path). */
export async function resolveBranchId(run: Run, branchPublicId: string): Promise<string> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ id: string }>(
      "SELECT id FROM branches WHERE public_id = $1",
      [branchPublicId],
    );
    if (!rows[0]) throw new SavedContactError(404, "Branch not found");
    return rows[0].id;
  });
}
