// Complaint read/write operations. Runs through the request's branch-context
// runner (RLS applied) — same pattern as modules/orders/queries.ts.

import type { Sql } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import type { CreateComplaintInput, UpdateComplaintInput } from "./schema.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export class ComplaintError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ComplaintRow {
  publicId: string;
  orderPublicId: string;
  trackingCode: string;
  category: string;
  message: string;
  status: string;
  response: string | null;
  createdAt: string;
  updatedAt: string;
}

const SELECT_FIELDS = `
  c.public_id, o.public_id AS order_public_id, o.tracking_code,
  c.category, c.message, c.status, c.response, c.created_at, c.updated_at
`;

function mapRow(r: Record<string, unknown>): ComplaintRow {
  return {
    publicId: r.public_id as string,
    orderPublicId: r.order_public_id as string,
    trackingCode: r.tracking_code as string,
    category: r.category as string,
    message: r.message as string,
    status: r.status as string,
    response: (r.response as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * CUSTOMER: file a complaint against one of their own orders. Verifies the
 * order both resolves (branch RLS) AND belongs to this customer before
 * inserting — branch RLS alone would allow filing against a branch-mate's
 * order, which isn't the customer's to complain about.
 */
export async function createComplaint(
  run: Run,
  customerId: string,
  branchId: string,
  input: CreateComplaintInput,
): Promise<{ orderId: string } & ComplaintRow> {
  return run(async (sql) => {
    const { rows: orderRows } = await sql.query<{ id: string; customer_id: string | null }>(
      "SELECT id, customer_id FROM orders WHERE public_id = $1",
      [input.orderPublicId],
    );
    const order = orderRows[0];
    if (!order) throw new ComplaintError(404, "Order not found");
    if (order.customer_id !== customerId) {
      throw new ComplaintError(403, "You can only file complaints against your own orders");
    }

    const pid = publicId();
    const { rows } = await sql.query(
      `INSERT INTO complaints (public_id, branch_id, order_id, customer_id, category, message)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, public_id`,
      [pid, branchId, order.id, customerId, input.category, input.message],
    );

    const { rows: full } = await sql.query(
      `SELECT ${SELECT_FIELDS} FROM complaints c JOIN orders o ON o.id = c.order_id
        WHERE c.public_id = $1`,
      [pid],
    );
    return { orderId: order.id, ...mapRow(full[0]!) };
  });
}

/** CUSTOMER: list their own complaints, newest first. */
export async function listCustomerComplaints(run: Run, customerId: string): Promise<ComplaintRow[]> {
  return run(async (sql) => {
    const { rows } = await sql.query(
      `SELECT ${SELECT_FIELDS} FROM complaints c JOIN orders o ON o.id = c.order_id
        WHERE c.customer_id = $1
        ORDER BY c.created_at DESC
        LIMIT 200`,
      [customerId],
    );
    return rows.map(mapRow);
  });
}

/** STAFF: list complaints in-branch (RLS-scoped), optionally filtered by status. */
export async function listComplaints(run: Run, opts: { status?: string }): Promise<
  (ComplaintRow & { customerName: string | null; customerEmail: string | null })[]
> {
  return run(async (sql) => {
    const where = opts.status ? "WHERE c.status = $1" : "";
    const params = opts.status ? [opts.status] : [];
    const { rows } = await sql.query(
      `SELECT ${SELECT_FIELDS}, cu.full_name AS customer_name, cu.email AS customer_email
         FROM complaints c
         JOIN orders o ON o.id = c.order_id
         JOIN customers cu ON cu.id = c.customer_id
         ${where}
        ORDER BY c.created_at DESC
        LIMIT 200`,
      params,
    );
    return rows.map((r) => ({
      ...mapRow(r),
      customerName: (r.customer_name as string | null) ?? null,
      customerEmail: (r.customer_email as string | null) ?? null,
    }));
  });
}

/** STAFF: update a complaint's status and/or add a response. */
export async function updateComplaint(
  run: Run,
  complaintPublicId: string,
  staffUserId: string,
  input: UpdateComplaintInput,
): Promise<{ orderId: string; branchId: string } & ComplaintRow> {
  return run(async (sql) => {
    const { rows: existing } = await sql.query<{ id: string; order_id: string; branch_id: string }>(
      "SELECT id, order_id, branch_id FROM complaints WHERE public_id = $1",
      [complaintPublicId],
    );
    const current = existing[0];
    if (!current) throw new ComplaintError(404, "Complaint not found");

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push(`status = $${params.length}`);
    }
    if (input.response !== undefined) {
      params.push(input.response);
      sets.push(`response = $${params.length}`);
    }
    params.push(staffUserId);
    sets.push(`handled_by = $${params.length}`);
    params.push(complaintPublicId);

    await sql.query(
      `UPDATE complaints SET ${sets.join(", ")} WHERE public_id = $${params.length}`,
      params,
    );

    const { rows: full } = await sql.query(
      `SELECT ${SELECT_FIELDS} FROM complaints c JOIN orders o ON o.id = c.order_id
        WHERE c.public_id = $1`,
      [complaintPublicId],
    );
    return { orderId: current.order_id, branchId: current.branch_id, ...mapRow(full[0]!) };
  });
}
export interface ComplaintMessageRow {
  publicId: string;
  complaintPublicId: string;
  sender: "customer" | "staff";
  authorName: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

function mapMessageRow(r: Record<string, unknown>): ComplaintMessageRow {
  return {
    publicId: r.public_id as string,
    complaintPublicId: r.complaint_public_id as string,
    sender: r.sender as "customer" | "staff",
    authorName: (r.author_name as string | null) ?? null,
    authorEmail: (r.author_email as string | null) ?? null,
    body: r.body as string,
    createdAt: r.created_at as string,
  };
}

const MESSAGE_SELECT = `
  cm.public_id, c.public_id AS complaint_public_id, cm.sender, cm.body, cm.created_at,
  COALESCE(cu.full_name, u.full_name) AS author_name,
  COALESCE(cu.email, u.email) AS author_email
`;

async function resolveComplaintId(sql: Sql, complaintPublicId: string): Promise<string> {
  const { rows } = await sql.query<{ id: string }>(
    "SELECT id FROM complaints WHERE public_id = $1",
    [complaintPublicId],
  );
  if (!rows[0]) throw new ComplaintError(404, "Complaint not found");
  return rows[0].id;
}

export async function listComplaintMessages(run: Run, complaintPublicId: string): Promise<ComplaintMessageRow[]> {
  return run(async (sql) => {
    const complaintId = await resolveComplaintId(sql, complaintPublicId);
    const { rows } = await sql.query(
      `SELECT ${MESSAGE_SELECT}
         FROM complaint_messages cm
         JOIN complaints c ON c.id = cm.complaint_id
         LEFT JOIN customers cu ON cu.id = cm.author_id AND cm.sender = 'customer'
         LEFT JOIN users u ON u.id = cm.author_id AND cm.sender = 'staff'
        WHERE cm.complaint_id = $1
        ORDER BY cm.created_at ASC`,
      [complaintId],
    );
    return rows.map(mapMessageRow);
  });
}

export async function addComplaintMessage(
  run: Run,
  complaintPublicId: string,
  sender: "customer" | "staff",
  authorId: string,
  body: string,
): Promise<ComplaintMessageRow> {
  return run(async (sql) => {
    const complaintId = await resolveComplaintId(sql, complaintPublicId);
    const pid = publicId();
    await sql.query(
      `INSERT INTO complaint_messages (public_id, branch_id, complaint_id, sender, author_id, body)
       SELECT $1, c.branch_id, $2, $3, $4, $5 FROM complaints c WHERE c.id = $2`,
      [pid, complaintId, sender, authorId, body],
    );
    const { rows } = await sql.query(
      `SELECT ${MESSAGE_SELECT}
         FROM complaint_messages cm
         JOIN complaints c ON c.id = cm.complaint_id
         LEFT JOIN customers cu ON cu.id = cm.author_id AND cm.sender = 'customer'
         LEFT JOIN users u ON u.id = cm.author_id AND cm.sender = 'staff'
        WHERE cm.public_id = $1`,
      [pid],
    );
    return mapMessageRow(rows[0]!);
  });
}
/** Verifies a complaint belongs to the given customer. Used by portal routes only. */
export async function verifyComplaintOwnership(
  run: Run,
  complaintPublicId: string,
  customerId: string,
): Promise<void> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ customer_id: string }>(
      "SELECT customer_id FROM complaints WHERE public_id = $1",
      [complaintPublicId],
    );
    if (!rows[0]) throw new ComplaintError(404, "Complaint not found");
    if (rows[0].customer_id !== customerId) {
      throw new ComplaintError(403, "You can only view your own complaints");
    }
  });
}