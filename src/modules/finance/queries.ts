// Finance queries — vendors, invoices, vendor bills, payments, expenses,
// plus DERIVED ledgers (customer & vendor) and the dashboard / reports
// rollups. Runs through req.db (RLS branch-scoped), same as every other
// module. No stored ledger_entries table — ledgers are computed at read time
// from invoices (debits on AR) + inbound payments (credits), and from
// vendor_bills (credits on AP) + outbound payments (debits). This keeps the
// balance always consistent with the underlying documents.

import type { Sql } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import type {
  CreateVendorInput, UpdateVendorInput,
  CreateInvoiceInput, UpdateInvoiceInput, InvoiceItemInput,
  CreateVendorBillInput, UpdateVendorBillInput, VendorBillItemInput,
  CreatePaymentInput,
  CreateExpenseInput, UpdateExpenseInput,
  CreateBankAccountInput, UpdateBankAccountInput,
} from "./schema.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export class FinanceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function n(v: unknown): number {
  return v == null ? 0 : Number(v);
}

// ═══════════════════════════════════════════════════════════════════════════
// BANK ACCOUNTS (cash + named bank accounts — Q7)
// ═══════════════════════════════════════════════════════════════════════════
export interface BankAccountRow {
  publicId: string;
  name: string;
  accountType: string;          // 'cash' | 'bank'
  bankName: string | null;
  accountNumber: string | null;
  openingBalance: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const BANK_ACCOUNT_FIELDS = `
  ba.public_id, ba.name, ba.account_type, ba.bank_name, ba.account_number,
  ba.opening_balance, ba.is_active, ba.created_at, ba.updated_at
`;

function mapBankAccount(r: Record<string, unknown>): BankAccountRow {
  return {
    publicId: r.public_id as string,
    name: r.name as string,
    accountType: r.account_type as string,
    bankName: (r.bank_name as string | null) ?? null,
    accountNumber: (r.account_number as string | null) ?? null,
    openingBalance: n(r.opening_balance),
    isActive: r.is_active as boolean,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function listBankAccounts(
  run: Run,
  opts: { activeOnly?: boolean; accountType?: string; branchPublicId?: string } = {},
): Promise<BankAccountRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.activeOnly) { params.push(true); conds.push(`ba.is_active = $${params.length}`); }
    if (opts.accountType) { params.push(opts.accountType); conds.push(`ba.account_type = $${params.length}`); }
    if (opts.branchPublicId) {
      params.push(opts.branchPublicId);
      conds.push(`ba.branch_id = (SELECT id FROM branches WHERE public_id = $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${BANK_ACCOUNT_FIELDS} FROM bank_accounts ba ${where} ORDER BY ba.account_type ASC, ba.name ASC`,
      params,
    );
    return rows.map(mapBankAccount);
  });
}

export async function createBankAccount(
  run: Run,
  branchId: string,
  userId: string,
  input: CreateBankAccountInput,
): Promise<BankAccountRow> {
  return run(async (sql) => {
    const pid = publicId();
    try {
      await sql.query(
        `INSERT INTO bank_accounts
           (public_id, branch_id, name, account_type, bank_name, account_number,
            opening_balance, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          pid, branchId, input.name, input.accountType, input.bankName ?? null,
          input.accountNumber ?? null, input.openingBalance, input.isActive, userId,
        ],
      );
    } catch (err) {
      if (err instanceof Error && /unique/i.test(err.message)) {
        throw new FinanceError(409, "An account with this name already exists for this branch");
      }
      throw err;
    }
    const { rows } = await sql.query(`SELECT ${BANK_ACCOUNT_FIELDS} FROM bank_accounts ba WHERE ba.public_id = $1`, [pid]);
    return mapBankAccount(rows[0]!);
  });
}

export async function updateBankAccount(run: Run, publicIdArg: string, input: UpdateBankAccountInput): Promise<BankAccountRow> {
  return run(async (sql) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (input.name !== undefined) push("name", input.name);
    if (input.accountType !== undefined) push("account_type", input.accountType);
    if (input.bankName !== undefined) push("bank_name", input.bankName);
    if (input.accountNumber !== undefined) push("account_number", input.accountNumber);
    if (input.openingBalance !== undefined) push("opening_balance", input.openingBalance);
    if (input.isActive !== undefined) push("is_active", input.isActive);
    if (!sets.length) throw new FinanceError(400, "No fields to update");
    params.push(publicIdArg);
    const { rowCount } = await sql.query(`UPDATE bank_accounts SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);
    if (rowCount === 0) throw new FinanceError(404, "Bank account not found");
    const { rows } = await sql.query(`SELECT ${BANK_ACCOUNT_FIELDS} FROM bank_accounts ba WHERE ba.public_id = $1`, [publicIdArg]);
    return mapBankAccount(rows[0]!);
  });
}

// Soft-deactivate only — never hard delete a bank account, since payments/
// expenses reference it (ON DELETE RESTRICT) and it's part of financial
// history. A deactivated account stops showing up as a selectable option
// for new payments/expenses but its past records + balance remain intact.
export async function deleteBankAccount(run: Run, publicIdArg: string): Promise<void> {
  return run(async (sql) => {
    const { rowCount } = await sql.query("UPDATE bank_accounts SET is_active = false WHERE public_id = $1", [publicIdArg]);
    if (rowCount === 0) throw new FinanceError(404, "Bank account not found");
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// VENDORS
// ═══════════════════════════════════════════════════════════════════════════
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
  isProtected: boolean;
  createdAt: string;
  updatedAt: string;
}

const VENDOR_FIELDS = `
  v.public_id, v.name, v.code, v.vendor_type, v.contact_name, v.phone, v.email,
  v.address, v.opening_balance, v.is_active, v.is_protected, v.created_at, v.updated_at
`;

function mapVendor(r: Record<string, unknown>): VendorRow {
  return {
    publicId: r.public_id as string,
    name: r.name as string,
    code: (r.code as string | null) ?? null,
    vendorType: r.vendor_type as string,
    contactName: (r.contact_name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    openingBalance: n(r.opening_balance),
    isActive: r.is_active as boolean,
    isProtected: r.is_protected as boolean,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
export async function listVendors(run: Run, opts: { activeOnly?: boolean; q?: string; branchPublicId?: string } = {}): Promise<VendorRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.activeOnly) {
      params.push(true);
      conds.push(`v.is_active = $${params.length}`);
    }
    if (opts.q) {
      params.push(`%${opts.q}%`);
      conds.push(`(v.name ILIKE $${params.length} OR v.code ILIKE $${params.length} OR v.contact_name ILIKE $${params.length})`);
    }
    if (opts.branchPublicId) {
      params.push(opts.branchPublicId);
      conds.push(`v.branch_id = (SELECT id FROM branches WHERE public_id = $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${VENDOR_FIELDS} FROM vendors v ${where} ORDER BY v.name ASC LIMIT 300`,
      params,
    );
    return rows.map(mapVendor);
  });
}

export async function createVendor(run: Run, branchId: string, userId: string, input: CreateVendorInput): Promise<VendorRow> {
  return run(async (sql) => {
    const pid = publicId();
    await sql.query(
      `INSERT INTO vendors
         (public_id, branch_id, name, code, vendor_type, contact_name, phone, email,
          address, opening_balance, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        pid, branchId, input.name, input.code ?? null, input.vendorType,
        input.contactName ?? null, input.phone ?? null, input.email || null,
        input.address ?? null, input.openingBalance, input.isActive, userId,
      ],
    );
    const { rows } = await sql.query(`SELECT ${VENDOR_FIELDS} FROM vendors v WHERE v.public_id = $1`, [pid]);
    return mapVendor(rows[0]!);
  });
}

export async function updateVendor(run: Run, publicIdArg: string, input: UpdateVendorInput): Promise<VendorRow> {
  return run(async (sql) => {
    const { rows: guardRows } = await sql.query<{ is_protected: boolean }>(
      "SELECT is_protected FROM vendors WHERE public_id = $1",
      [publicIdArg],
    );
    if (!guardRows[0]) throw new FinanceError(404, "Vendor not found");
    if (guardRows[0].is_protected) {
      throw new FinanceError(403, "This vendor is a protected system record and cannot be edited");
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.name !== undefined) push("name", input.name);
    if (input.code !== undefined) push("code", input.code);
    if (input.vendorType !== undefined) push("vendor_type", input.vendorType);
    if (input.contactName !== undefined) push("contact_name", input.contactName);
    if (input.phone !== undefined) push("phone", input.phone);
    if (input.email !== undefined) push("email", input.email || null);
    if (input.address !== undefined) push("address", input.address);
    if (input.openingBalance !== undefined) push("opening_balance", input.openingBalance);
    if (input.isActive !== undefined) push("is_active", input.isActive);
    if (!sets.length) throw new FinanceError(400, "No fields to update");
    params.push(publicIdArg);
    const { rowCount } = await sql.query(`UPDATE vendors SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);
    if (rowCount === 0) throw new FinanceError(404, "Vendor not found");
    const { rows } = await sql.query(`SELECT ${VENDOR_FIELDS} FROM vendors v WHERE v.public_id = $1`, [publicIdArg]);
    return mapVendor(rows[0]!);
  });
}

export async function deleteVendor(run: Run, publicIdArg: string): Promise<void> {
  return run(async (sql) => {
    const { rows: guardRows } = await sql.query<{ is_protected: boolean }>(
      "SELECT is_protected FROM vendors WHERE public_id = $1",
      [publicIdArg],
    );
    if (!guardRows[0]) throw new FinanceError(404, "Vendor not found");
    if (guardRows[0].is_protected) {
      throw new FinanceError(403, "This vendor is a protected system record and cannot be deactivated");
    }
    const { rowCount } = await sql.query("UPDATE vendors SET is_active = false WHERE public_id = $1", [publicIdArg]);
    if (rowCount === 0) throw new FinanceError(404, "Vendor not found");
  });
}

export async function hardDeleteVendor(run: Run, publicIdArg: string): Promise<{ billsDeleted: number; paymentsDeleted: number }> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ id: string; is_protected: boolean }>(
      "SELECT id, is_protected FROM vendors WHERE public_id = $1",
      [publicIdArg],
    );
    if (!rows[0]) throw new FinanceError(404, "Vendor not found");
    if (rows[0].is_protected) {
      throw new FinanceError(403, "This vendor is a protected system record and cannot be deleted");
    }
    const vendorId = rows[0].id;

    const { rowCount: billsDeleted } = await sql.query(
      "DELETE FROM vendor_bills WHERE vendor_id = $1",
      [vendorId],
    );
    const { rowCount: paymentsDeleted } = await sql.query(
      "DELETE FROM payments WHERE vendor_id = $1",
      [vendorId],
    );
    await sql.query("DELETE FROM vendors WHERE id = $1", [vendorId]);

    return { billsDeleted: billsDeleted ?? 0, paymentsDeleted: paymentsDeleted ?? 0 };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// INVOICES (AR)
// ═══════════════════════════════════════════════════════════════════════════
export interface InvoiceItemRow {
  publicId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface InvoiceRow {
   publicId: string;
  invoiceNo: string;
  customerPublicId: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  orderPublicId: string | null;
  branchPublicId: string;
  branchName: string | null;
  branchCity: string | null;
  isCreditNote: boolean;
  referencedInvoicePublicId: string | null;
  referencedInvoiceNo: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
 amountPaid: number;
  creditedAmount: number;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items?: InvoiceItemRow[];
}

const INVOICE_FIELDS = `
  i.public_id, i.invoice_no, cu.public_id AS customer_public_id,
  cu.full_name AS customer_name, cu.email AS customer_email, cu.phone AS customer_phone,
  o.public_id AS order_public_id,
  b.public_id AS branch_public_id, b.name AS branch_name, b.city AS branch_city,
  i.is_credit_note, i.issue_date, i.due_date, i.currency,
  i.subtotal, i.tax, i.total, i.amount_paid, i.status, i.notes,
  ri.public_id AS referenced_invoice_public_id, ri.invoice_no AS referenced_invoice_no,
  COALESCE((SELECT SUM(-cn.total) FROM invoices cn
             WHERE cn.referenced_invoice_id = i.id
               AND cn.is_credit_note AND cn.status <> 'void'), 0) AS credited_amount,
  i.created_at, i.updated_at
`;

function mapInvoice(r: Record<string, unknown>): InvoiceRow {
 return {
    publicId: r.public_id as string,
    invoiceNo: r.invoice_no as string,
    customerPublicId: r.customer_public_id as string,
    customerName: (r.customer_name as string | null) ?? null,
    customerEmail: (r.customer_email as string | null) ?? null,
    customerPhone: (r.customer_phone as string | null) ?? null,
    orderPublicId: (r.order_public_id as string | null) ?? null,
    branchPublicId: r.branch_public_id as string,
    branchName: (r.branch_name as string | null) ?? null,
    branchCity: (r.branch_city as string | null) ?? null,
    isCreditNote: r.is_credit_note as boolean,
    referencedInvoicePublicId: (r.referenced_invoice_public_id as string | null) ?? null,
    referencedInvoiceNo: (r.referenced_invoice_no as string | null) ?? null,
    issueDate: r.issue_date as string,
    dueDate: (r.due_date as string | null) ?? null,
    currency: r.currency as string,
    subtotal: n(r.subtotal),
    tax: n(r.tax),
 total: n(r.total),
    amountPaid: n(r.amount_paid),
    creditedAmount: n(r.credited_amount),
    status: r.status as string,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function listInvoices(run: Run, opts: { status?: string; q?: string; branchPublicId?: string; customerPublicId?: string } = {}): Promise<InvoiceRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      params.push(opts.status);
      conds.push(`i.status = $${params.length}`);
    }
    if (opts.q) {
      params.push(`%${opts.q}%`);
      conds.push(`(i.invoice_no ILIKE $${params.length} OR cu.full_name ILIKE $${params.length})`);
    }
    if (opts.branchPublicId) {
      params.push(opts.branchPublicId);
      conds.push(`i.branch_id = (SELECT id FROM branches WHERE public_id = $${params.length})`);
    }
    if (opts.customerPublicId) {
      params.push(opts.customerPublicId);
      conds.push(`cu.public_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${INVOICE_FIELDS} FROM invoices i
         JOIN customers cu ON cu.id = i.customer_id
         LEFT JOIN orders o ON o.id = i.order_id
         JOIN branches b ON b.id = i.branch_id
         LEFT JOIN invoices ri ON ri.id = i.referenced_invoice_id
         ${where}
        ORDER BY i.issue_date DESC, i.created_at DESC
        LIMIT 300`,
      params,
    );
    return rows.map(mapInvoice);
  });
}

// Fetches a full invoice (with items) using an ALREADY-OPEN transaction client.
// Callers that are themselves inside a run()/withBranchContext() callback must
// use this directly with their existing `sql` — never call getInvoice() (which
// opens a brand-new transaction) from inside another transaction, since the
// new transaction cannot see this one's uncommitted writes.
async function fetchInvoiceBySql(sql: Sql, publicIdArg: string): Promise<InvoiceRow> {
  const { rows } = await sql.query(
    `SELECT ${INVOICE_FIELDS} FROM invoices i
       JOIN customers cu ON cu.id = i.customer_id
       LEFT JOIN orders o ON o.id = i.order_id
       JOIN branches b ON b.id = i.branch_id
       LEFT JOIN invoices ri ON ri.id = i.referenced_invoice_id
      WHERE i.public_id = $1`,
    [publicIdArg],
  );
  if (!rows[0]) throw new FinanceError(404, "Invoice not found");
  const inv = mapInvoice(rows[0]!);
  const { rows: itemRows } = await sql.query(
    `SELECT description, quantity, unit_price, line_total
       FROM invoice_items
      WHERE invoice_id = (SELECT id FROM invoices WHERE public_id = $1)
      ORDER BY id ASC`,
    [publicIdArg],
  );
  inv.items = itemRows.map((r) => ({
    publicId: null,
    description: r.description as string,
    quantity: n(r.quantity),
    unitPrice: n(r.unit_price),
    lineTotal: n(r.line_total),
  }));
  return inv;
}

export async function getInvoice(run: Run, publicIdArg: string): Promise<InvoiceRow> {
  return run((sql) => fetchInvoiceBySql(sql, publicIdArg));
}

function computeInvoiceTotals(items: InvoiceItemInput[], tax: number, isCreditNote: boolean) {
  const subtotal = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  const total = subtotal + tax;
  // A credit note is a negative invoice — invert the sign on stored totals so
  // SUM() aggregations on the customer ledger correctly reduce what they owe.
  const sign = isCreditNote ? -1 : 1;
  return { subtotal: subtotal * sign, tax: tax * sign, total: total * sign };
}

async function nextInvoiceNo(sql: Sql, branchId: string): Promise<string> {
  const year = new Date().getFullYear();
  const { rows } = await sql.query<{ seq: number }>(
    `SELECT COALESCE(MAX(
       CASE WHEN invoice_no ~ ('^PML-INV-' || $2::text || '-\\d+$')
         THEN substring(invoice_no FROM '\\d+$')::int
         ELSE 0
       END
     ), 0) + 1 AS seq
    FROM (
  SELECT invoice_no
    FROM invoices
   WHERE branch_id = $1
     AND invoice_no LIKE ('PML-INV-' || $2::text || '-%')
   FOR UPDATE
) locked`,
    [branchId, year],
  );
  const seq = rows[0]!.seq;
  return `PML-INV-${year}-${String(seq).padStart(6, "0")}`;
}

// Vendor bills no longer take a user-supplied bill number (removed from the
// frontend form) — every bill gets one auto-assigned, same per-branch/year
// sequence pattern as invoices.
async function nextVendorBillNo(sql: Sql, branchId: string): Promise<string> {
  const year = new Date().getFullYear();
  const { rows } = await sql.query<{ seq: number }>(
    `SELECT COALESCE(MAX(
       CASE WHEN bill_no ~ ('^PML-BILL-' || $2::text || '-\\d+$')
         THEN substring(bill_no FROM '\\d+$')::int
         ELSE 0
       END
     ), 0) + 1 AS seq
    FROM (
  SELECT bill_no
    FROM vendor_bills
   WHERE branch_id = $1
     AND bill_no LIKE ('PML-BILL-' || $2::text || '-%')
   FOR UPDATE
) locked`,
    [branchId, year],
  );
  const seq = rows[0]!.seq;
  return `PML-BILL-${year}-${String(seq).padStart(6, "0")}`;
}

export async function createInvoice(
  run: Run,
  branchId: string,
  userId: string,
  input: CreateInvoiceInput,
): Promise<InvoiceRow> {
  return run(async (sql) => {
    // Resolve customer
    const { rows: custRows } = await sql.query<{ id: string }>(
      "SELECT id FROM customers WHERE public_id = $1",
      [input.customerPublicId],
    );
    if (!custRows[0]) throw new FinanceError(404, "Customer not found");

    // Resolve optional order
    let orderId: string | null = null;
    if (input.orderPublicId) {
      const { rows: orderRows } = await sql.query<{ id: string }>(
        "SELECT id FROM orders WHERE public_id = $1",
        [input.orderPublicId],
      );
      if (!orderRows[0]) throw new FinanceError(404, "Order not found");
      orderId = orderRows[0]!.id;
    }

    // Resolve optional credit-note-to-invoice link. Only meaningful for
    // credit notes, but we don't hard-require it (goodwill adjustments may
    // not reference a specific invoice).
    let referencedInvoiceId: string | null = null;
    if (input.referencedInvoicePublicId) {
    const { rows: refRows } = await sql.query<{ id: string; customer_id: string; total: string; amount_paid: string; already_credited: string }>(
        `SELECT i.id, i.customer_id, i.total, i.amount_paid,
                COALESCE((SELECT SUM(-cn.total) FROM invoices cn
                           WHERE cn.referenced_invoice_id = i.id
                             AND cn.is_credit_note AND cn.status <> 'void'), 0) AS already_credited
           FROM invoices i WHERE i.public_id = $1`,
        [input.referencedInvoicePublicId],
      );
      if (!refRows[0]) throw new FinanceError(404, "Referenced invoice not found");
      if (refRows[0].customer_id !== custRows[0]!.id) {
        throw new FinanceError(400, "Referenced invoice belongs to a different customer");
      }
      if (input.isCreditNote) {
        const creditAmount = input.items.reduce((s, it) => s + it.quantity * it.unitPrice, 0) + input.tax;
        // Remaining = total, minus what's already been paid, minus what's
        // already been credited by earlier credit notes against this same
        // invoice — otherwise a paid invoice still "shows" its original total
        // as creditable, letting a new credit note double-dip.
        const remaining = Number(refRows[0].total) - Number(refRows[0].amount_paid) - Number(refRows[0].already_credited);
        if (creditAmount > remaining) {
          throw new FinanceError(400, `Credit note amount exceeds the referenced invoice's remaining balance of ${remaining.toFixed(2)}`);
        }
      }
      referencedInvoiceId = refRows[0]!.id;
    }

    const invoiceNo = await nextInvoiceNo(sql, branchId);
    const pid = publicId();
    const { subtotal, tax, total } = computeInvoiceTotals(input.items, input.tax, input.isCreditNote);
    const status = input.status === "draft" ? "draft" : (total > 0 ? "unpaid" : "paid");

    const { rows: invRows } = await sql.query<{ id: string }>(
      `INSERT INTO invoices
         (public_id, branch_id, invoice_no, customer_id, order_id, is_credit_note,
          referenced_invoice_id,
          issue_date, due_date, currency, subtotal, tax, total, amount_paid,
          status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,CURRENT_DATE),$9,$10,$11,$12,$13,0,$14,$15,$16)
       RETURNING id`,
      [
        pid, branchId, invoiceNo, custRows[0]!.id, orderId, input.isCreditNote, referencedInvoiceId,
        input.issueDate ?? null, input.dueDate ?? null, input.currency,
        subtotal, tax, total, status, input.notes ?? null, userId,
      ],
    );
    const invoiceId = invRows[0]!.id;

    for (const it of input.items) {
      const lineTotal = it.quantity * it.unitPrice * (input.isCreditNote ? -1 : 1);
      await sql.query(
        `INSERT INTO invoice_items (invoice_id, branch_id, description, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoiceId, branchId, it.description, it.quantity, it.unitPrice, lineTotal],
      );
    }

    return fetchInvoiceBySql(sql, pid);
  });
}

export async function updateInvoice(run: Run, publicIdArg: string, input: UpdateInvoiceInput): Promise<InvoiceRow> {
  return run(async (sql) => {
const { rows: existing } = await sql.query<{ id: string; branch_id: string; is_credit_note: boolean; customer_id: string; referenced_invoice_id: string | null; total: string; status: string }>(
      "SELECT id, branch_id, is_credit_note, customer_id, referenced_invoice_id, total, status FROM invoices WHERE public_id = $1",
      [publicIdArg],
    );
    if (!existing[0]) throw new FinanceError(404, "Invoice not found");
    const inv = existing[0]!;
    // A paid invoice is settled — editing it (line items, amounts, dates…)
    // would desync it from the payments already recorded against it.
    // The only way out is a credit note or voiding, not a silent edit.
    if (inv.status === "paid" && input.status === undefined) {
      throw new FinanceError(400, "This invoice is fully paid and can no longer be edited");
    }

    // Resolve optional references
    let customerId: string | undefined;
    if (input.customerPublicId !== undefined) {
      const { rows } = await sql.query<{ id: string }>("SELECT id FROM customers WHERE public_id = $1", [input.customerPublicId]);
      if (!rows[0]) throw new FinanceError(404, "Customer not found");
      customerId = rows[0]!.id;
    }
    let orderId: string | null | undefined;
    if (input.orderPublicId !== undefined) {
      if (input.orderPublicId === null) {
        orderId = null;
      } else {
        const { rows } = await sql.query<{ id: string }>("SELECT id FROM orders WHERE public_id = $1", [input.orderPublicId]);
        if (!rows[0]) throw new FinanceError(404, "Order not found");
        orderId = rows[0]!.id;
      }
    }

    const isCreditNote = input.isCreditNote ?? inv.is_credit_note;
    const tax = input.tax ?? 0;

    let referencedInvoiceId: string | null | undefined;
    if (input.referencedInvoicePublicId !== undefined) {
      if (input.referencedInvoicePublicId === null) {
        referencedInvoiceId = null;
      } else {
        const { rows: refRows } = await sql.query<{ id: string; customer_id: string; total: string; amount_paid: string }>(
          "SELECT id, customer_id, total, amount_paid FROM invoices WHERE public_id = $1",
          [input.referencedInvoicePublicId],
        );
        if (!refRows[0]) throw new FinanceError(404, "Referenced invoice not found");
        if (refRows[0].customer_id !== (customerId ?? inv.customer_id)) {
          throw new FinanceError(400, "Referenced invoice belongs to a different customer");
        }
        referencedInvoiceId = refRows[0]!.id;
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (customerId !== undefined) push("customer_id", customerId);
    if (orderId !== undefined) push("order_id", orderId);
    if (input.isCreditNote !== undefined) push("is_credit_note", input.isCreditNote);
    if (referencedInvoiceId !== undefined) push("referenced_invoice_id", referencedInvoiceId);
    if (input.issueDate !== undefined) push("issue_date", input.issueDate);
    if (input.dueDate !== undefined) push("due_date", input.dueDate);
    if (input.currency !== undefined) push("currency", input.currency);
    if (input.notes !== undefined) push("notes", input.notes);
    if (input.status !== undefined) push("status", input.status);

  // Recompute totals if items changed OR tax changed OR credit-note flag flipped
    let finalTotal = Number(inv.total);
    if (input.items || input.tax !== undefined || input.isCreditNote !== undefined) {
      const itemRows = input.items
        ? await (async () => {
            // Replace items atomically
            await sql.query("DELETE FROM invoice_items WHERE invoice_id = $1", [inv.id]);
            for (const it of input.items!) {
              const lineTotal = it.quantity * it.unitPrice * (isCreditNote ? -1 : 1);
              await sql.query(
                `INSERT INTO invoice_items (invoice_id, branch_id, description, quantity, unit_price, line_total)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [inv.id, inv.branch_id, it.description, it.quantity, it.unitPrice, lineTotal],
              );
            }
            return input.items!;
          })()
        : await (async () => {
            const { rows } = await sql.query<{ quantity: string; unit_price: string }>(
              "SELECT quantity, unit_price FROM invoice_items WHERE invoice_id = $1",
              [inv.id],
            );
            return rows.map((r) => ({ quantity: Number(r.quantity), unitPrice: Number(r.unit_price), description: "" }));
          })();

   const { subtotal, tax: taxAdj, total } = computeInvoiceTotals(itemRows, tax, isCreditNote);
      push("subtotal", subtotal);
      push("tax", taxAdj);
      push("total", total);
      finalTotal = total;
    }

    // Cap check: runs whenever this is (or is becoming) a credit note tied to
    // an invoice — whether the trigger was an amount change OR just a
    // re-link to a different referenced invoice. Can't credit more than that
    // invoice's remaining balance: total paid, less what's already been
    // credited by OTHER credit notes against it (excluding this one).
    const effectiveReferencedInvoiceId = referencedInvoiceId !== undefined ? referencedInvoiceId : inv.referenced_invoice_id;
    if (isCreditNote && effectiveReferencedInvoiceId) {
      const { rows: refRows } = await sql.query<{ total: string; amount_paid: string; already_credited: string }>(
        `SELECT ri.total, ri.amount_paid,
                COALESCE((SELECT SUM(-cn.total) FROM invoices cn
                           WHERE cn.referenced_invoice_id = ri.id
                             AND cn.is_credit_note AND cn.status <> 'void'
                             AND cn.id <> $2), 0) AS already_credited
           FROM invoices ri WHERE ri.id = $1`,
        [effectiveReferencedInvoiceId, inv.id],
      );
      if (refRows[0]) {
        const remaining = Number(refRows[0].total) - Number(refRows[0].amount_paid) - Number(refRows[0].already_credited);
        const creditAmount = -finalTotal; // total is stored negative for credit notes
        if (creditAmount > remaining) {
          throw new FinanceError(400, `Credit note amount exceeds the referenced invoice's remaining balance of ${remaining.toFixed(2)}`);
        }
      }
    }

    if (!sets.length) throw new FinanceError(400, "No fields to update");
    params.push(publicIdArg);
    await sql.query(`UPDATE invoices SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);

    return fetchInvoiceBySql(sql, publicIdArg);
  });
}

export async function deleteInvoice(run: Run, publicIdArg: string): Promise<void> {
  return run(async (sql) => {
    // Only allow delete on draft invoices with no payments allocated.
    const { rows } = await sql.query<{ status: string; amount_paid: string }>(
      "SELECT status, amount_paid FROM invoices WHERE public_id = $1",
      [publicIdArg],
    );
    if (!rows[0]) throw new FinanceError(404, "Invoice not found");
    if (rows[0].status !== "draft" && Number(rows[0].amount_paid) > 0) {
      throw new FinanceError(400, "Cannot delete an invoice that has payments allocated; void it instead");
    }
    await sql.query("DELETE FROM invoices WHERE public_id = $1", [publicIdArg]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR BILLS (AP)
// ═══════════════════════════════════════════════════════════════════════════
export interface VendorBillItemRow {
  description: string;
  amount: number;
  orderPublicId: string | null;
}

export interface VendorBillRow {
  publicId: string;
  billNo: string | null;
  vendorPublicId: string;
  vendorName: string;
  vendorContactName: string | null;
  vendorPhone: string | null;
  vendorEmail: string | null;
  vendorAddress: string | null;
  branchName: string | null;
  branchCity: string | null;
  billDate: string;
  dueDate: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items?: VendorBillItemRow[];
}

const BILL_FIELDS = `
  vb.public_id, vb.bill_no, v.public_id AS vendor_public_id, v.name AS vendor_name,
  v.contact_name AS vendor_contact_name, v.phone AS vendor_phone,
  v.email AS vendor_email, v.address AS vendor_address,
  b.name AS branch_name, b.city AS branch_city,
  vb.bill_date, vb.due_date, vb.currency,
  vb.subtotal, vb.tax, vb.total, vb.amount_paid, vb.status, vb.notes,
  vb.created_at, vb.updated_at
`;

function mapBill(r: Record<string, unknown>): VendorBillRow {
  return {
    publicId: r.public_id as string,
    billNo: (r.bill_no as string | null) ?? null,
    vendorPublicId: r.vendor_public_id as string,
    vendorName: r.vendor_name as string,
    vendorContactName: (r.vendor_contact_name as string | null) ?? null,
    vendorPhone: (r.vendor_phone as string | null) ?? null,
    vendorEmail: (r.vendor_email as string | null) ?? null,
    vendorAddress: (r.vendor_address as string | null) ?? null,
    branchName: (r.branch_name as string | null) ?? null,
    branchCity: (r.branch_city as string | null) ?? null,
    billDate: r.bill_date as string,
    dueDate: (r.due_date as string | null) ?? null,
    currency: r.currency as string,
    subtotal: n(r.subtotal),
    tax: n(r.tax),
    total: n(r.total),
    amountPaid: n(r.amount_paid),
    status: r.status as string,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function listVendorBills(run: Run, opts: { status?: string; q?: string; branchPublicId?: string } = {}): Promise<VendorBillRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { params.push(opts.status); conds.push(`vb.status = $${params.length}`); }
    if (opts.q) {
      params.push(`%${opts.q}%`);
      conds.push(`(vb.bill_no ILIKE $${params.length} OR v.name ILIKE $${params.length})`);
    }
    if (opts.branchPublicId) {
      params.push(opts.branchPublicId);
      conds.push(`vb.branch_id = (SELECT id FROM branches WHERE public_id = $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${BILL_FIELDS} FROM vendor_bills vb
         JOIN vendors v ON v.id = vb.vendor_id
         JOIN branches b ON b.id = vb.branch_id
         ${where}
        ORDER BY vb.bill_date DESC, vb.created_at DESC
        LIMIT 300`,
      params,
    );
    return rows.map(mapBill);
  });
}

// Fetches a full vendor bill (with items) using an ALREADY-OPEN transaction
// client. Callers already inside a run()/withBranchContext() callback must
// use this directly with their existing `sql` — never call getVendorBill()
// (which opens a brand-new transaction) from inside another transaction,
// since the new transaction cannot see this one's uncommitted writes.
async function fetchVendorBillBySql(sql: Sql, publicIdArg: string): Promise<VendorBillRow> {
  const { rows } = await sql.query(
    `SELECT ${BILL_FIELDS} FROM vendor_bills vb
       JOIN vendors v ON v.id = vb.vendor_id
       JOIN branches b ON b.id = vb.branch_id
      WHERE vb.public_id = $1`,
    [publicIdArg],
  );
  if (!rows[0]) throw new FinanceError(404, "Vendor bill not found");
  const bill = mapBill(rows[0]!);
  const { rows: itemRows } = await sql.query(
    `SELECT vbi.description, vbi.amount, o.public_id AS order_public_id
       FROM vendor_bill_items vbi
       LEFT JOIN orders o ON o.id = vbi.order_id
      WHERE vbi.vendor_bill_id = (SELECT id FROM vendor_bills WHERE public_id = $1)
      ORDER BY vbi.id ASC`,
    [publicIdArg],
  );
  bill.items = itemRows.map((r) => ({
    description: r.description as string,
    amount: n(r.amount),
    orderPublicId: (r.order_public_id as string | null) ?? null,
  }));
  return bill;
}

export async function getVendorBill(run: Run, publicIdArg: string): Promise<VendorBillRow> {
  return run((sql) => fetchVendorBillBySql(sql, publicIdArg));
}
export async function createVendorBill(
  run: Run,
  branchId: string,
  userId: string,
  input: CreateVendorBillInput,
): Promise<VendorBillRow> {
  return run(async (sql) => {
    if (!input.items || input.items.length === 0) {
      throw new FinanceError(400, "A vendor bill must have at least one line item");
    }

    const { rows: vendorRows } = await sql.query<{ id: string }>(
      "SELECT id FROM vendors WHERE public_id = $1",
      [input.vendorPublicId],
    );
    if (!vendorRows[0]) throw new FinanceError(404, "Vendor not found");

    const subtotal = input.items.reduce((s, it) => s + it.amount, 0);
    const total = subtotal + input.tax;
    const pid = publicId();
    const status = total > 0 ? input.status : "paid";
    const billNo = await nextVendorBillNo(sql, branchId);

    const { rows: billRows } = await sql.query<{ id: string }>(
      `INSERT INTO vendor_bills
         (public_id, branch_id, bill_no, vendor_id, bill_date, due_date, currency,
          subtotal, tax, total, amount_paid, status, notes, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7,$8,$9,$10,0,$11,$12,$13)
       RETURNING id`,
      [
        pid, branchId, billNo, vendorRows[0]!.id,
        input.billDate ?? null, input.dueDate ?? null, input.currency,
        subtotal, input.tax, total, status, input.notes ?? null, userId,
      ],
    );
    const billId = billRows[0]!.id;

    for (const it of input.items) {
      let orderId: string | null = null;
      if (it.orderPublicId) {
        const { rows } = await sql.query<{ id: string }>("SELECT id FROM orders WHERE public_id = $1", [it.orderPublicId]);
        if (!rows[0]) throw new FinanceError(404, `Order not found: ${it.orderPublicId}`);
        orderId = rows[0]!.id;
      }
      await sql.query(
        `INSERT INTO vendor_bill_items (vendor_bill_id, branch_id, order_id, description, amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [billId, branchId, orderId, it.description, it.amount],
      );
    }

    return fetchVendorBillBySql(sql, pid);
  });
}

export async function updateVendorBill(
  run: Run,
  publicIdArg: string,
  input: UpdateVendorBillInput,
): Promise<VendorBillRow> {
  return run(async (sql) => {
    const { rows: existing } = await sql.query<{ id: string; branch_id: string; status: string }>(
      "SELECT id, branch_id, status FROM vendor_bills WHERE public_id = $1",
      [publicIdArg],
    );
    if (!existing[0]) throw new FinanceError(404, "Vendor bill not found");
    const bill = existing[0]!;
    // Same rule as invoices — a fully paid bill is settled; only a status
    // change (e.g. voiding) is allowed past this point, not a content edit.
    if (bill.status === "paid" && input.status === undefined) {
      throw new FinanceError(400, "This bill is fully paid and can no longer be edited");
    }

    let vendorId: string | undefined;
    if (input.vendorPublicId !== undefined) {
      const { rows } = await sql.query<{ id: string }>("SELECT id FROM vendors WHERE public_id = $1", [input.vendorPublicId]);
      if (!rows[0]) throw new FinanceError(404, "Vendor not found");
      vendorId = rows[0]!.id;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (vendorId !== undefined) push("vendor_id", vendorId);
    // if (input.billNo !== undefined) push("bill_no", input.billNo);
    if (input.billDate !== undefined) push("bill_date", input.billDate);
    if (input.dueDate !== undefined) push("due_date", input.dueDate);
    if (input.currency !== undefined) push("currency", input.currency);
    if (input.notes !== undefined) push("notes", input.notes);
    if (input.status !== undefined) push("status", input.status);

 if (input.items || input.tax !== undefined) {
      if (input.items && input.items.length === 0) {
        throw new FinanceError(400, "A vendor bill must have at least one line item");
      }

      // Replace items if provided, otherwise load existing for recompute
      const items: VendorBillItemInput[] = input.items
        ? await (async () => {
            await sql.query("DELETE FROM vendor_bill_items WHERE vendor_bill_id = $1", [bill.id]);
            for (const it of input.items!) {
              let orderId: string | null = null;
              if (it.orderPublicId) {
                const { rows } = await sql.query<{ id: string }>("SELECT id FROM orders WHERE public_id = $1", [it.orderPublicId]);
                if (!rows[0]) throw new FinanceError(404, `Order not found: ${it.orderPublicId}`);
                orderId = rows[0]!.id;
              }
              await sql.query(
                `INSERT INTO vendor_bill_items (vendor_bill_id, branch_id, order_id, description, amount)
                 VALUES ($1,$2,$3,$4,$5)`,
                [bill.id, bill.branch_id, orderId, it.description, it.amount],
              );
            }
            return input.items!;
          })()
        : await (async () => {
            const { rows } = await sql.query<{ amount: string }>(
              "SELECT amount FROM vendor_bill_items WHERE vendor_bill_id = $1",
              [bill.id],
            );
            return rows.map((r) => ({ amount: Number(r.amount), description: "" }));
          })();

      const tax = input.tax ?? 0;
      const subtotal = items.reduce((s, it) => s + it.amount, 0);
      const total = subtotal + tax;
      push("subtotal", subtotal);
      push("tax", tax);
      push("total", total);
    }

    if (!sets.length) throw new FinanceError(400, "No fields to update");
    params.push(publicIdArg);
    await sql.query(`UPDATE vendor_bills SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);

    return fetchVendorBillBySql(sql, publicIdArg);
  });
}

export async function deleteVendorBill(run: Run, publicIdArg: string): Promise<void> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ amount_paid: string }>(
      "SELECT amount_paid FROM vendor_bills WHERE public_id = $1",
      [publicIdArg],
    );
    if (!rows[0]) throw new FinanceError(404, "Vendor bill not found");
    if (Number(rows[0].amount_paid) > 0) {
      throw new FinanceError(400, "Cannot delete a bill with payments allocated; void it instead");
    }
    await sql.query("DELETE FROM vendor_bills WHERE public_id = $1", [publicIdArg]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENTS (both directions)
// ═══════════════════════════════════════════════════════════════════════════
export interface PaymentRow {
  publicId: string;
  direction: string;
  method: string;
  account: string;
  bankAccountPublicId: string | null;
  bankAccountName: string | null;
  amount: number;
  paidOn: string;
  customerPublicId: string | null;
  customerName: string | null;
  vendorPublicId: string | null;
  vendorName: string | null;
  invoicePublicId: string | null;
  invoiceNo: string | null;
  vendorBillPublicId: string | null;
  billNo: string | null;
  reference: string | null;
  notes: string | null;
  createdAt: string;
}

const PAYMENT_FIELDS = `
  p.public_id, p.direction, p.method, p.account, p.amount, p.paid_on,
  ba.public_id AS bank_account_public_id, ba.name AS bank_account_name,
  cu.public_id AS customer_public_id, cu.full_name AS customer_name,
  v.public_id AS vendor_public_id, v.name AS vendor_name,
  i.public_id AS invoice_public_id, i.invoice_no,
  vb.public_id AS vendor_bill_public_id, vb.bill_no,
  p.reference, p.notes, p.created_at
`;

function mapPayment(r: Record<string, unknown>): PaymentRow {
  return {
    publicId: r.public_id as string,
    direction: r.direction as string,
    method: r.method as string,
    account: r.account as string,
    bankAccountPublicId: (r.bank_account_public_id as string | null) ?? null,
    bankAccountName: (r.bank_account_name as string | null) ?? null,
    amount: n(r.amount),
    paidOn: r.paid_on as string,
    customerPublicId: (r.customer_public_id as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    vendorPublicId: (r.vendor_public_id as string | null) ?? null,
    vendorName: (r.vendor_name as string | null) ?? null,
    invoicePublicId: (r.invoice_public_id as string | null) ?? null,
    invoiceNo: (r.invoice_no as string | null) ?? null,
    vendorBillPublicId: (r.vendor_bill_public_id as string | null) ?? null,
    billNo: (r.bill_no as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export async function listPayments(
  run: Run,
  opts: { direction?: string; from?: string; to?: string; customerPublicId?: string } = {},
): Promise<PaymentRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.direction) { params.push(opts.direction); conds.push(`p.direction = $${params.length}`); }
    if (opts.from) { params.push(opts.from); conds.push(`p.paid_on >= $${params.length}`); }
    if (opts.to) { params.push(opts.to); conds.push(`p.paid_on <= $${params.length}`); }
    if (opts.customerPublicId) { params.push(opts.customerPublicId); conds.push(`cu.public_id = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${PAYMENT_FIELDS} FROM payments p
         LEFT JOIN customers cu ON cu.id = p.customer_id
         LEFT JOIN vendors    v  ON v.id  = p.vendor_id
         LEFT JOIN invoices   i  ON i.id  = p.invoice_id
         LEFT JOIN vendor_bills vb ON vb.id = p.vendor_bill_id
         LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
         ${where}
        ORDER BY p.paid_on DESC, p.created_at DESC
        LIMIT 500`,
      params,
    );
    return rows.map(mapPayment);
  });
}

export async function createPayment(
  run: Run,
  branchId: string,
  userId: string,
  input: CreatePaymentInput,
): Promise<PaymentRow> {
  return run(async (sql) => {
    // Resolve references
    let customerId: string | null = null;
    let vendorId: string | null = null;
    let invoiceId: string | null = null;
    let vendorBillId: string | null = null;
    let bankAccountId: string | null = null;
    let account = input.account;

    if (input.bankAccountPublicId) {
      const { rows } = await sql.query<{ id: string; account_type: string; is_active: boolean }>(
        "SELECT id, account_type, is_active FROM bank_accounts WHERE public_id = $1",
        [input.bankAccountPublicId],
      );
      if (!rows[0]) throw new FinanceError(404, "Bank account not found");
      if (!rows[0].is_active) throw new FinanceError(400, "This account is deactivated");
      bankAccountId = rows[0].id;
      // Keep the legacy `account` text column consistent with the chosen account.
      account = rows[0].account_type === "cash" ? "cash_in_hand" : "bank";
    }

    if (input.customerPublicId) {
      const { rows } = await sql.query<{ id: string }>("SELECT id FROM customers WHERE public_id = $1", [input.customerPublicId]);
      if (!rows[0]) throw new FinanceError(404, "Customer not found");
      customerId = rows[0]!.id;
    }
    if (input.vendorPublicId) {
      const { rows } = await sql.query<{ id: string }>("SELECT id FROM vendors WHERE public_id = $1", [input.vendorPublicId]);
      if (!rows[0]) throw new FinanceError(404, "Vendor not found");
      vendorId = rows[0]!.id;
    }
  if (input.invoicePublicId) {
      const { rows } = await sql.query<{ id: string; amount_paid: string; total: string; status: string; credited: string }>(
        `SELECT i.id, i.amount_paid, i.total, i.status,
                COALESCE((SELECT SUM(-cn.total) FROM invoices cn
                           WHERE cn.referenced_invoice_id = i.id
                             AND cn.is_credit_note AND cn.status <> 'void'), 0) AS credited
           FROM invoices i WHERE i.public_id = $1`,
        [input.invoicePublicId],
      );
      if (!rows[0]) throw new FinanceError(404, "Invoice not found");
      // Remaining collectible = total, less what's already been paid, less
      // what's been written off by credit notes referencing this invoice.
      const remaining = n(rows[0]!.total) - n(rows[0]!.amount_paid) - n(rows[0]!.credited);
      if (input.amount > remaining) {
        throw new FinanceError(400, `Payment amount exceeds remaining invoice balance of ${remaining.toFixed(2)}`);
      }
      invoiceId = rows[0]!.id;
    }
    if (input.vendorBillPublicId) {
      const { rows } = await sql.query<{ id: string; amount_paid: string; total: string }>(
        "SELECT id, amount_paid, total FROM vendor_bills WHERE public_id = $1",
        [input.vendorBillPublicId],
      );
      if (!rows[0]) throw new FinanceError(404, "Vendor bill not found");
      const remaining = n(rows[0]!.total) - n(rows[0]!.amount_paid);
      if (input.amount > remaining) {
        throw new FinanceError(400, `Payment amount exceeds remaining bill balance of ${remaining.toFixed(2)}`);
      }
      vendorBillId = rows[0]!.id;
    }

    const pid = publicId();
    await sql.query(
      `INSERT INTO payments
         (public_id, branch_id, direction, method, account, bank_account_id, amount, paid_on,
          customer_id, vendor_id, invoice_id, vendor_bill_id, reference, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,CURRENT_DATE),$9,$10,$11,$12,$13,$14,$15)`,
      [
        pid, branchId, input.direction, input.method, account, bankAccountId, input.amount,
        input.paidOn ?? null, customerId, vendorId, invoiceId, vendorBillId,
        input.reference ?? null, input.notes ?? null, userId,
      ],
    );

    // Re-derive parent document status (paid/partial/unpaid) so the ledger
    // stays consistent. Run inside the same transaction.
    if (invoiceId) {
      await sql.query(
      `UPDATE invoices SET
           amount_paid = (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id = $1 AND direction = 'in'),
           status = CASE
             WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id = $1 AND direction = 'in')
                  + (SELECT COALESCE(SUM(-cn.total),0) FROM invoices cn WHERE cn.referenced_invoice_id = $1 AND cn.is_credit_note AND cn.status <> 'void')
                  >= total THEN 'paid'
             WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id = $1 AND direction = 'in')
                  + (SELECT COALESCE(SUM(-cn.total),0) FROM invoices cn WHERE cn.referenced_invoice_id = $1 AND cn.is_credit_note AND cn.status <> 'void')
                  > 0 THEN 'partial'
             ELSE 'unpaid' END
         WHERE id = $1`,
        [invoiceId],
      );
    }
    if (vendorBillId) {
      await sql.query(
        `UPDATE vendor_bills SET
           amount_paid = (SELECT COALESCE(SUM(amount),0) FROM payments WHERE vendor_bill_id = $1 AND direction = 'out'),
           status = CASE
             WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE vendor_bill_id = $1 AND direction = 'out') >= total THEN 'paid'
             WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE vendor_bill_id = $1 AND direction = 'out') > 0 THEN 'partial'
             ELSE 'unpaid' END
         WHERE id = $1`,
        [vendorBillId],
      );
    }

    const { rows } = await sql.query(
      `SELECT ${PAYMENT_FIELDS} FROM payments p
         LEFT JOIN customers cu ON cu.id = p.customer_id
         LEFT JOIN vendors    v  ON v.id  = p.vendor_id
         LEFT JOIN invoices   i  ON i.id  = p.invoice_id
         LEFT JOIN vendor_bills vb ON vb.id = p.vendor_bill_id
         LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
        WHERE p.public_id = $1`,
      [pid],
    );
    return mapPayment(rows[0]!);
  });
}

export async function deletePayment(run: Run, publicIdArg: string): Promise<void> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ invoice_id: string | null; vendor_bill_id: string | null }>(
      "SELECT invoice_id, vendor_bill_id FROM payments WHERE public_id = $1",
      [publicIdArg],
    );
    if (!rows[0]) throw new FinanceError(404, "Payment not found");
    const { invoice_id: invoiceId, vendor_bill_id: vendorBillId } = rows[0]!;

    await sql.query("DELETE FROM payments WHERE public_id = $1", [publicIdArg]);

    // Re-derive parent status after deletion (mirror createPayment logic)
    if (invoiceId) {
      await sql.query(
        `UPDATE invoices SET
           amount_paid = (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id = $1 AND direction = 'in'),
           status = CASE
             WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id = $1 AND direction = 'in')
                  + (SELECT COALESCE(SUM(-cn.total),0) FROM invoices cn WHERE cn.referenced_invoice_id = $1 AND cn.is_credit_note AND cn.status <> 'void')
                  >= total THEN 'paid'
             WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id = $1 AND direction = 'in')
                  + (SELECT COALESCE(SUM(-cn.total),0) FROM invoices cn WHERE cn.referenced_invoice_id = $1 AND cn.is_credit_note AND cn.status <> 'void')
                  > 0 THEN 'partial'
             ELSE 'unpaid' END
         WHERE id = $1`,
        [invoiceId],
      );
    }
    if (vendorBillId) {
      await sql.query(
        `UPDATE vendor_bills SET
           amount_paid = (SELECT COALESCE(SUM(amount),0) FROM payments WHERE vendor_bill_id = $1 AND direction = 'out'),
           status = CASE
             WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE vendor_bill_id = $1 AND direction = 'out') >= total THEN 'paid'
             WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE vendor_bill_id = $1 AND direction = 'out') > 0 THEN 'partial'
             ELSE 'unpaid' END
         WHERE id = $1`,
        [vendorBillId],
      );
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPENSES
// ═══════════════════════════════════════════════════════════════════════════
export interface ExpenseRow {
  publicId: string;
  category: string;
  amount: number;
  account: string;
  bankAccountPublicId: string | null;
  bankAccountName: string | null;
  spentOn: string;
  payee: string | null;
  description: string | null;
  reference: string | null;
  createdAt: string;
}

const EXPENSE_FIELDS = `
  e.public_id, e.category, e.amount, e.account, e.spent_on,
  ba.public_id AS bank_account_public_id, ba.name AS bank_account_name,
  e.payee, e.description, e.reference, e.created_at
`;

function mapExpense(r: Record<string, unknown>): ExpenseRow {
  return {
    publicId: r.public_id as string,
    category: r.category as string,
    amount: n(r.amount),
    account: r.account as string,
    bankAccountPublicId: (r.bank_account_public_id as string | null) ?? null,
    bankAccountName: (r.bank_account_name as string | null) ?? null,
    spentOn: r.spent_on as string,
    payee: (r.payee as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export async function listExpenses(
  run: Run,
  opts: { category?: string; from?: string; to?: string } = {},
): Promise<ExpenseRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.category) { params.push(opts.category); conds.push(`e.category = $${params.length}`); }
    if (opts.from) { params.push(opts.from); conds.push(`e.spent_on >= $${params.length}`); }
    if (opts.to) { params.push(opts.to); conds.push(`e.spent_on <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${EXPENSE_FIELDS} FROM expenses e
         LEFT JOIN bank_accounts ba ON ba.id = e.bank_account_id
         ${where} ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 500`,
      params,
    );
    return rows.map(mapExpense);
  });
}

export async function createExpense(
  run: Run,
  branchId: string,
  userId: string,
  input: CreateExpenseInput,
): Promise<ExpenseRow> {
  return run(async (sql) => {
    let bankAccountId: string | null = null;
    let account = input.account;

    if (input.bankAccountPublicId) {
      const { rows } = await sql.query<{ id: string; account_type: string; is_active: boolean }>(
        "SELECT id, account_type, is_active FROM bank_accounts WHERE public_id = $1",
        [input.bankAccountPublicId],
      );
      if (!rows[0]) throw new FinanceError(404, "Bank account not found");
      if (!rows[0].is_active) throw new FinanceError(400, "This account is deactivated");
      bankAccountId = rows[0].id;
      account = rows[0].account_type === "cash" ? "cash_in_hand" : "bank";
    }

    const pid = publicId();
    await sql.query(
      `INSERT INTO expenses
         (public_id, branch_id, category, amount, account, bank_account_id, spent_on,
          payee, description, reference, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),$8,$9,$10,$11)`,
      [
        pid, branchId, input.category, input.amount, account, bankAccountId,
        input.spentOn ?? null, input.payee ?? null, input.description ?? null,
        input.reference ?? null, userId,
      ],
    );
    const { rows } = await sql.query(
      `SELECT ${EXPENSE_FIELDS} FROM expenses e LEFT JOIN bank_accounts ba ON ba.id = e.bank_account_id WHERE e.public_id = $1`,
      [pid],
    );
    return mapExpense(rows[0]!);
  });
}

export async function updateExpense(run: Run, publicIdArg: string, input: UpdateExpenseInput): Promise<ExpenseRow> {
  return run(async (sql) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (input.category !== undefined) push("category", input.category);
    if (input.amount !== undefined) push("amount", input.amount);
    if (input.bankAccountPublicId !== undefined) {
      const { rows } = await sql.query<{ id: string; account_type: string; is_active: boolean }>(
        "SELECT id, account_type, is_active FROM bank_accounts WHERE public_id = $1",
        [input.bankAccountPublicId],
      );
      if (!rows[0]) throw new FinanceError(404, "Bank account not found");
      if (!rows[0].is_active) throw new FinanceError(400, "This account is deactivated");
      push("bank_account_id", rows[0].id);
      push("account", rows[0].account_type === "cash" ? "cash_in_hand" : "bank");
    } else if (input.account !== undefined) {
      push("account", input.account);
    }
    if (input.spentOn !== undefined) push("spent_on", input.spentOn);
    if (input.payee !== undefined) push("payee", input.payee);
    if (input.description !== undefined) push("description", input.description);
    if (input.reference !== undefined) push("reference", input.reference);
    if (!sets.length) throw new FinanceError(400, "No fields to update");
    params.push(publicIdArg);
    const { rowCount } = await sql.query(`UPDATE expenses SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);
    if (rowCount === 0) throw new FinanceError(404, "Expense not found");
    const { rows } = await sql.query(
      `SELECT ${EXPENSE_FIELDS} FROM expenses e LEFT JOIN bank_accounts ba ON ba.id = e.bank_account_id WHERE e.public_id = $1`,
      [publicIdArg],
    );
    return mapExpense(rows[0]!);
  });
}

export async function deleteExpense(run: Run, publicIdArg: string): Promise<void> {
  return run(async (sql) => {
    const { rowCount } = await sql.query("DELETE FROM expenses WHERE public_id = $1", [publicIdArg]);
    if (rowCount === 0) throw new FinanceError(404, "Expense not found");
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DERIVED LEDGERS — customer (AR) and vendor (AP)
// Each ledger entry: Date · Reference · Description · Debit · Credit · Balance
// Customer Ledger: invoice issue = debit (we owe them service, they owe us money);
//                   inbound payment = credit; opening balance = opening debit.
// Vendor Ledger:   vendor bill = credit (we owe them); outbound payment = debit;
//                   opening balance = opening credit.
// ═══════════════════════════════════════════════════════════════════════════
export interface LedgerEntry {
  date: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export async function getCustomerLedger(run: Run, customerPublicId: string): Promise<{ entries: LedgerEntry[]; closingBalance: number }> {
  return run(async (sql) => {
    const { rows: custRows } = await sql.query<{ id: string }>(
      "SELECT id FROM customers WHERE public_id = $1",
      [customerPublicId],
    );
    if (!custRows[0]) throw new FinanceError(404, "Customer not found");

    const { rows } = await sql.query(
      `SELECT i.issue_date AS dt, i.invoice_no AS ref,
              CASE
                WHEN i.is_credit_note AND ri.invoice_no IS NOT NULL
                  THEN COALESCE(NULLIF(i.notes,''), 'Credit Note — credits ' || ri.invoice_no)
                WHEN i.is_credit_note
                  THEN COALESCE(NULLIF(i.notes,''), 'Credit Note (general adjustment, no invoice referenced)')
                ELSE COALESCE(NULLIF(i.notes,''), 'Invoice ' || i.invoice_no)
              END AS descr,
             CASE WHEN i.is_credit_note THEN 0 ELSE i.total END AS debit,
              CASE WHEN i.is_credit_note THEN -i.total ELSE 0 END AS credit
         FROM invoices i
         LEFT JOIN invoices ri ON ri.id = i.referenced_invoice_id
        WHERE i.customer_id = $1 AND i.status <> 'void'
     UNION ALL
       SELECT p.paid_on AS dt, COALESCE(i.invoice_no, '') AS ref,
              COALESCE(NULLIF(p.reference,''), NULLIF(p.notes,''), 'Payment received') AS descr,
              0 AS debit, p.amount AS credit
         FROM payments p
         LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE p.customer_id = $1 AND p.direction = 'in'
        ORDER BY dt ASC, ref ASC`,
      [custRows[0].id],
    );

   const entries: LedgerEntry[] = [];
    let balance = 0;
    for (const r of rows) {
      balance = balance + n(r.debit) - n(r.credit);
      entries.push({
        date: r.dt as string,
        reference: (r.ref as string | null) ?? "",
        description: r.descr as string,
        debit: n(r.debit),
        credit: n(r.credit),
        balance,
      });
    }
    return { entries, closingBalance: balance };
  });
}

export async function getVendorLedger(run: Run, vendorPublicId: string): Promise<{ entries: LedgerEntry[]; closingBalance: number }> {
  return run(async (sql) => {
    const { rows: vRows } = await sql.query<{ id: string; opening_balance: string }>(
      "SELECT id, opening_balance FROM vendors WHERE public_id = $1",
      [vendorPublicId],
    );
    if (!vRows[0]) throw new FinanceError(404, "Vendor not found");
    const opening = n(vRows[0].opening_balance);

    const { rows } = await sql.query(
      `SELECT vb.bill_date AS dt, COALESCE(vb.bill_no, vb.public_id) AS ref,
              COALESCE(NULLIF(vb.notes,''), 'Vendor bill') AS descr,
              0 AS debit, vb.total AS credit
         FROM vendor_bills vb
        WHERE vb.vendor_id = $1 AND vb.status <> 'void'
      UNION ALL
       SELECT p.paid_on AS dt, COALESCE(vb.bill_no, '') AS ref,
              COALESCE(NULLIF(p.reference,''), NULLIF(p.notes,''), 'Payment made') AS descr,
              p.amount AS debit, 0 AS credit
         FROM payments p
         LEFT JOIN vendor_bills vb ON vb.id = p.vendor_bill_id
        WHERE p.vendor_id = $1 AND p.direction = 'out'
        ORDER BY dt ASC, ref ASC`,
      [vRows[0].id],
    );

    const entries: LedgerEntry[] = [];
    let balance = opening; // positive = we owe them
    if (opening !== 0) {
      entries.push({
        date: rows[0]?.dt ?? new Date().toISOString().slice(0, 10),
        reference: "OPENING",
        description: "Opening balance",
        debit: opening < 0 ? -opening : 0,
        credit: opening > 0 ? opening : 0,
        balance,
      });
    }
    for (const r of rows) {
      // AP convention: bills credit (we owe more), payments debit (we owe less)
      balance = balance + n(r.credit) - n(r.debit);
      entries.push({
        date: r.dt as string,
        reference: (r.ref as string | null) ?? "",
        description: r.descr as string,
        debit: n(r.debit),
        credit: n(r.credit),
        balance,
      });
    }
    return { entries, closingBalance: balance };
  });
}

// ── Ledger PDF letterhead helpers ────────────────────────────────────────────
export interface CustomerHeaderInfo {
  name: string;
  email: string | null;
  phone: string | null;
  branchName: string | null;
  branchCity: string | null;
}

export async function getCustomerHeaderInfo(run: Run, customerPublicId: string): Promise<CustomerHeaderInfo> {
  return run(async (sql) => {
    const { rows } = await sql.query(
      `SELECT cu.full_name, cu.email, cu.phone, b.name AS branch_name, b.city AS branch_city
         FROM customers cu JOIN branches b ON b.id = cu.branch_id
        WHERE cu.public_id = $1`,
      [customerPublicId],
    );
    if (!rows[0]) throw new FinanceError(404, "Customer not found");
    const r = rows[0]!;
    return {
      name: r.full_name as string,
      email: (r.email as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      branchName: (r.branch_name as string | null) ?? null,
      branchCity: (r.branch_city as string | null) ?? null,
    };
  });
}

export interface VendorHeaderInfo {
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  branchName: string | null;
  branchCity: string | null;
}

export async function getVendorHeaderInfo(run: Run, vendorPublicId: string): Promise<VendorHeaderInfo> {
  return run(async (sql) => {
    const { rows } = await sql.query(
      `SELECT v.name, v.contact_name, v.phone, v.email, v.address,
              b.name AS branch_name, b.city AS branch_city
         FROM vendors v JOIN branches b ON b.id = v.branch_id
        WHERE v.public_id = $1`,
      [vendorPublicId],
    );
    if (!rows[0]) throw new FinanceError(404, "Vendor not found");
    const r = rows[0]!;
    return {
      name: r.name as string,
      contactName: (r.contact_name as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      address: (r.address as string | null) ?? null,
      branchName: (r.branch_name as string | null) ?? null,
      branchCity: (r.branch_city as string | null) ?? null,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// Total Income (inbound payments) · Total Expenses (outbound payments +
// operational expenses) · Pending Payments (unpaid+partial invoices total
// minus amount_paid) · Profit/Loss are period-scoped (respect from/to).
//
// Cash in Hand / Bank Balance are ALL-TIME running balances — independent of
// the from/to window — computed as each account's opening_balance plus the
// full history of payments/expenses ever posted to it. Filtering the
// dashboard to "this month" must not make Cash in Hand look like it only
// holds this month's net movement (design-doc Part 2 §C-3 / Part 4 §J.7).
//
// Legacy rows recorded before bank_accounts existed (bank_account_id IS
// NULL) are still counted, matched by their old `account` text
// ('cash_in_hand' | 'bank'), so historical totals stay correct even for
// data written before this migration.
// ═══════════════════════════════════════════════════════════════════════════
export interface FinanceDashboard {
  totalIncome: number;
  totalExpenses: number;
  pendingPayments: number;          // what customers still owe us
  pendingVendorBills: number;       // what we still owe vendors
  profitLoss: number;
  cashInHand: number;               // all-time, all cash-type accounts combined
  bankBalance: number;              // all-time, all bank-type accounts combined
  bankAccounts: Array<{
    publicId: string;
    name: string;
    accountType: string;
    openingBalance: number;
    balance: number;                // all-time running balance for this one account
  }>;
  invoiceCount: number;
  unpaidInvoiceCount: number;
  vendorBillCount: number;
  unpaidVendorBillCount: number;
}

export async function getFinanceDashboard(run: Run, opts: { from?: string; to?: string } = {}): Promise<FinanceDashboard> {
  return run(async (sql) => {
    const from = opts.from ?? "1970-01-01";
    const to = opts.to ?? "2999-12-31";

    const { rows } = await sql.query(
      `SELECT
         COALESCE((SELECT SUM(amount) FROM payments WHERE direction = 'in'  AND paid_on BETWEEN $1 AND $2), 0)::numeric AS total_income,
         COALESCE((SELECT SUM(amount) FROM payments WHERE direction = 'out' AND paid_on BETWEEN $1 AND $2), 0)
           + COALESCE((SELECT SUM(amount) FROM expenses WHERE spent_on BETWEEN $1 AND $2), 0)::numeric AS total_expenses,
         COALESCE((SELECT SUM(total - amount_paid) FROM invoices WHERE status IN ('unpaid','partial')), 0)::numeric AS pending_ar,
         COALESCE((SELECT SUM(total - amount_paid) FROM vendor_bills WHERE status IN ('unpaid','partial')), 0)::numeric AS pending_ap,

         -- Cash in Hand: ALL-TIME, opening balances + full history, no date filter.
         COALESCE((SELECT SUM(opening_balance) FROM bank_accounts WHERE account_type = 'cash'), 0)
           + COALESCE((SELECT SUM(p.amount) FROM payments p LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
                        WHERE p.direction = 'in'
                          AND (ba.account_type = 'cash' OR (p.bank_account_id IS NULL AND p.account = 'cash_in_hand'))), 0)
           - COALESCE((SELECT SUM(p.amount) FROM payments p LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
                        WHERE p.direction = 'out'
                          AND (ba.account_type = 'cash' OR (p.bank_account_id IS NULL AND p.account = 'cash_in_hand'))), 0)
           - COALESCE((SELECT SUM(e.amount) FROM expenses e LEFT JOIN bank_accounts ba ON ba.id = e.bank_account_id
                        WHERE (ba.account_type = 'cash' OR (e.bank_account_id IS NULL AND e.account = 'cash_in_hand'))), 0)
           AS cash_in_hand,

         -- Bank Balance: ALL-TIME, sum across every named bank account, no date filter.
         COALESCE((SELECT SUM(opening_balance) FROM bank_accounts WHERE account_type = 'bank'), 0)
           + COALESCE((SELECT SUM(p.amount) FROM payments p LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
                        WHERE p.direction = 'in'
                          AND (ba.account_type = 'bank' OR (p.bank_account_id IS NULL AND p.account = 'bank'))), 0)
           - COALESCE((SELECT SUM(p.amount) FROM payments p LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
                        WHERE p.direction = 'out'
                          AND (ba.account_type = 'bank' OR (p.bank_account_id IS NULL AND p.account = 'bank'))), 0)
           - COALESCE((SELECT SUM(e.amount) FROM expenses e LEFT JOIN bank_accounts ba ON ba.id = e.bank_account_id
                        WHERE (ba.account_type = 'bank' OR (e.bank_account_id IS NULL AND e.account = 'bank'))), 0)
           AS bank_balance,

         (SELECT COUNT(*)::int FROM invoices)::int AS invoice_count,
         (SELECT COUNT(*)::int FROM invoices WHERE status IN ('unpaid','partial'))::int AS unpaid_invoice_count,
         (SELECT COUNT(*)::int FROM vendor_bills)::int AS vendor_bill_count,
         (SELECT COUNT(*)::int FROM vendor_bills WHERE status IN ('unpaid','partial'))::int AS unpaid_vendor_bill_count`,
      [from, to],
    );
    const r = rows[0]!;
    const totalIncome = n(r.total_income);
    const totalExpenses = n(r.total_expenses);

    // Per-account breakdown — exact linked balance for each named account
    // (opening balance + only the payments/expenses explicitly posted to
    // it). Legacy unlinked rows aren't attributable to one specific
    // account, so they aren't part of this per-account list, but they are
    // still included in the combined cash_in_hand / bank_balance totals
    // above.
    const { rows: acctRows } = await sql.query(
      `SELECT
         ba.public_id, ba.name, ba.account_type, ba.opening_balance,
         ba.opening_balance
           + COALESCE((SELECT SUM(amount) FROM payments WHERE bank_account_id = ba.id AND direction = 'in'), 0)
           - COALESCE((SELECT SUM(amount) FROM payments WHERE bank_account_id = ba.id AND direction = 'out'), 0)
           - COALESCE((SELECT SUM(amount) FROM expenses WHERE bank_account_id = ba.id), 0)
           AS balance
       FROM bank_accounts ba
       WHERE ba.is_active = true
       ORDER BY ba.account_type ASC, ba.name ASC`,
    );

    return {
      totalIncome,
      totalExpenses,
      pendingPayments: n(r.pending_ar),
      pendingVendorBills: n(r.pending_ap),
      profitLoss: totalIncome - totalExpenses,
      cashInHand: n(r.cash_in_hand),
      bankBalance: n(r.bank_balance),
      bankAccounts: acctRows.map((a) => ({
        publicId: a.public_id as string,
        name: a.name as string,
        accountType: a.account_type as string,
        openingBalance: n(a.opening_balance),
        balance: n(a.balance),
      })),
      invoiceCount: r.invoice_count as number,
      unpaidInvoiceCount: r.unpaid_invoice_count as number,
      vendorBillCount: r.vendor_bill_count as number,
      unpaidVendorBillCount: r.unpaid_vendor_bill_count as number,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORTS — daily / monthly / yearly rollups of income vs. expenses.
// ═══════════════════════════════════════════════════════════════════════════
export interface ReportRow {
  bucket: string;
  income: number;
  expensePayments: number;
  expenses: number;
  net: number;
}

export async function getFinanceReport(
  run: Run,
  opts: { period: "daily" | "monthly" | "yearly"; from?: string; to?: string },
): Promise<ReportRow[]> {
  return run(async (sql) => {
    const from = opts.from ?? "1970-01-01";
    const to = opts.to ?? "2999-12-31";
    const trunc = opts.period === "daily" ? "day" : opts.period === "monthly" ? "month" : "year";

    const { rows } = await sql.query(
      `WITH income AS (
         SELECT date_trunc($3, paid_on)::date AS bucket, SUM(amount) AS amt
           FROM payments
          WHERE direction = 'in' AND paid_on BETWEEN $1 AND $2
          GROUP BY 1
       ), expense_payments AS (
         SELECT date_trunc($3, paid_on)::date AS bucket, SUM(amount) AS amt
           FROM payments
          WHERE direction = 'out' AND paid_on BETWEEN $1 AND $2
          GROUP BY 1
       ), op_expenses AS (
         SELECT date_trunc($3, spent_on)::date AS bucket, SUM(amount) AS amt
           FROM expenses
          WHERE spent_on BETWEEN $1 AND $2
          GROUP BY 1
       )
       SELECT
         COALESCE(i.bucket, ep.bucket, oe.bucket) AS bucket,
         COALESCE(i.amt, 0) AS income,
         COALESCE(ep.amt, 0) AS expense_payments,
         COALESCE(oe.amt, 0) AS expenses
       FROM income i
       FULL JOIN expense_payments ep ON ep.bucket = i.bucket
       FULL JOIN op_expenses oe ON oe.bucket = COALESCE(i.bucket, ep.bucket)
       ORDER BY bucket ASC`,
      [from, to, trunc],
    );
    return rows.map((r) => ({
      bucket: r.bucket as string,
      income: n(r.income),
      expensePayments: n(r.expense_payments),
      expenses: n(r.expenses),
      net: n(r.income) - n(r.expense_payments) - n(r.expenses),
    }));
  });
}

