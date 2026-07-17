// Vendor (AP partner/carrier) read/write operations. Runs through the
// request's branch-context runner (RLS applied) — same pattern as
// modules/complaints/queries.ts.

import type { Sql } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import type { CreateVendorInput, UpdateVendorInput, ListVendorsQuery } from "./schema.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export class VendorError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface VendorRow {
  publicId: string;
  name: string;
  code: string | null;
  vendorType: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  openingBalance: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const SELECT_FIELDS = `
  public_id, name, code, vendor_type, contact_name, phone, email, address,
  opening_balance, is_active, created_at, updated_at
`;

function mapRow(r: Record<string, unknown>): VendorRow {
  return {
    publicId: r.public_id as string,
    name: r.name as string,
    code: (r.code as string | null) ?? null,
    vendorType: r.vendor_type as string,
    contactName: (r.contact_name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    openingBalance: Number(r.opening_balance),
    isActive: r.is_active as boolean,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * Create a vendor. `staffBranchId` is the caller's own branch (null for
 * super_admin, who must instead pass `branchPublicId` in the input — same
 * convention as modules/orders/service.ts resolveBranchAndCustomer).
 * Rejects a duplicate name (case-insensitive) up front for a clean error.
 */
export async function createVendor(
  run: Run,
  staffBranchId: string | null,
  input: CreateVendorInput,
): Promise<VendorRow> {
  return run(async (sql) => {
    let branchId: string;
    if (staffBranchId) {
      branchId = staffBranchId;
    } else {
      if (!input.branchPublicId) throw new VendorError(400, "branchPublicId is required for super-admin");
      const { rows: b } = await sql.query<{ id: string }>("SELECT id FROM branches WHERE public_id = $1", [
        input.branchPublicId,
      ]);
      if (!b[0]) throw new VendorError(404, "Branch not found");
      branchId = b[0].id;
    }

    const { rows: dupe } = await sql.query(
      "SELECT 1 FROM vendors WHERE branch_id = $1 AND lower(name) = lower($2)",
      [branchId, input.name],
    );
    if (dupe.length > 0) throw new VendorError(409, "A vendor with this name already exists");

    const pid = publicId();
    await sql.query(
      `INSERT INTO vendors (public_id, branch_id, name, code, vendor_type, contact_name, phone, email, address, opening_balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        pid,
        branchId,
        input.name,
        input.code ?? null,
        input.vendorType,
        input.contactName ?? null,
        input.phone ?? null,
        input.email || null,
        input.address ?? null,
        input.openingBalance,
      ],
    );

    const { rows } = await sql.query(`SELECT ${SELECT_FIELDS} FROM vendors WHERE public_id = $1`, [pid]);
    return mapRow(rows[0]!);
  });
}

/** List vendors in-branch (RLS-scoped), optionally filtered by type / active / name search. */
export async function listVendors(run: Run, opts: ListVendorsQuery): Promise<VendorRow[]> {
  return run(async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.vendorType) {
      params.push(opts.vendorType);
      where.push(`vendor_type = $${params.length}`);
    }
    if (opts.isActive !== undefined) {
      params.push(opts.isActive === "true");
      where.push(`is_active = $${params.length}`);
    }
    if (opts.q) {
      params.push(`%${opts.q}%`);
      where.push(`name ILIKE $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${SELECT_FIELDS} FROM vendors ${whereSql} ORDER BY name ASC LIMIT 500`,
      params,
    );
    return rows.map(mapRow);
  });
}

/** Get a single vendor by public id (RLS-scoped). */
async function getVendorByPublicId(sql: Sql, vendorPublicId: string): Promise<VendorRow> {
  const { rows } = await sql.query(`SELECT ${SELECT_FIELDS} FROM vendors WHERE public_id = $1`, [vendorPublicId]);
  const vendor = rows[0];
  if (!vendor) throw new VendorError(404, "Vendor not found");
  return mapRow(vendor);
}

export async function getVendor(run: Run, vendorPublicId: string): Promise<VendorRow> {
  return run(async (sql) => getVendorByPublicId(sql, vendorPublicId));
}

/** Update a vendor. Re-checks the name-uniqueness constraint if the name is changing. */
export async function updateVendor(
  run: Run,
  vendorPublicId: string,
  input: UpdateVendorInput,
): Promise<VendorRow> {
  return run(async (sql) => {
    const { rows: existing } = await sql.query<{ id: string; branch_id: string }>(
      "SELECT id, branch_id FROM vendors WHERE public_id = $1",
      [vendorPublicId],
    );
    const current = existing[0];
    if (!current) throw new VendorError(404, "Vendor not found");

    if (input.name !== undefined) {
      const { rows: dupe } = await sql.query(
        "SELECT 1 FROM vendors WHERE branch_id = $1 AND lower(name) = lower($2) AND public_id != $3",
        [current.branch_id, input.name, vendorPublicId],
      );
      if (dupe.length > 0) throw new VendorError(409, "A vendor with this name already exists");
    }

    const fieldMap: Record<string, unknown> = {
      name: input.name,
      code: input.code,
      vendor_type: input.vendorType,
      contact_name: input.contactName,
      phone: input.phone,
      email: input.email === "" ? null : input.email,
      address: input.address,
      opening_balance: input.openingBalance,
      is_active: input.isActive,
    };

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [col, val] of Object.entries(fieldMap)) {
      if (val === undefined) continue;
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    params.push(vendorPublicId);

    await sql.query(`UPDATE vendors SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);

    const { rows } = await sql.query(`SELECT ${SELECT_FIELDS} FROM vendors WHERE public_id = $1`, [vendorPublicId]);
    return mapRow(rows[0]!);
  });
}

/**
 * Deactivate (soft-delete) a vendor rather than hard-deleting — financial /
 * partner records should stay for history and any existing references
 * (manifests, future vendor_bills). Matches the doc's Q9 recommendation.
 */
export async function deactivateVendor(run: Run, vendorPublicId: string): Promise<VendorRow> {
  return run(async (sql) => {
    const { rows } = await sql.query("UPDATE vendors SET is_active = false WHERE public_id = $1 RETURNING public_id", [
      vendorPublicId,
    ]);
      if (!rows[0]) throw new VendorError(404, "Vendor not found");
    // Use same sql client to read back — avoids nested-transaction visibility bug.
    return getVendorByPublicId(sql, vendorPublicId);
  });
}

export async function hardDeleteVendor(run: Run, publicId: string): Promise<{ billsDeleted: number; paymentsDeleted: number }> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ id: string }>(
      "SELECT id FROM vendors WHERE public_id = $1",
      [publicId],
    );
    if (!rows[0]) throw new VendorError(404, "Vendor not found");
    const vendorId = rows[0].id;

    const { rowCount: billsDeleted } = await sql.query(
      "DELETE FROM vendor_bills WHERE vendor_id = $1", [vendorId],
    );
    const { rowCount: paymentsDeleted } = await sql.query(
      "DELETE FROM payments WHERE vendor_id = $1", [vendorId],
    );
    await sql.query("DELETE FROM vendors WHERE id = $1", [vendorId]);

    return { billsDeleted: billsDeleted ?? 0, paymentsDeleted: paymentsDeleted ?? 0 };
  });
}