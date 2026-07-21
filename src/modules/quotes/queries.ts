// Quote read/write operations. Runs through the request's branch-context
// runner (RLS applied) — same pattern as modules/complaints/queries.ts.

import type { Sql } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import type { CreateQuoteInput, UpdateQuoteInput, QuoteBoxInput } from "./schema.js";
import { pushToBranch } from "../notifications/sse.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export class QuoteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface QuoteRow {
  publicId: string;
  originCountry: string;
  destinationCountry: string;
  serviceLevel: string;
  contentsNature: string | null;
  boxes: QuoteBoxInput[];
  notes: string | null;
  status: string;
  quotedPrice: number | null;
  quotedCurrency: string | null;
  staffResponse: string | null;
  createdAt: string;
  updatedAt: string;
}

const SELECT_FIELDS = `
  q.public_id, q.origin_country, q.destination_country, q.service_level, q.contents_nature,
  q.boxes, q.notes, q.status, q.quoted_price, q.quoted_currency, q.staff_response,
  q.created_at, q.updated_at
`;

function mapRow(r: Record<string, unknown>): QuoteRow {
  return {
    publicId: r.public_id as string,
    originCountry: r.origin_country as string,
    destinationCountry: r.destination_country as string,
    serviceLevel: r.service_level as string,
    contentsNature: (r.contents_nature as string | null) ?? null,
    boxes: (r.boxes as QuoteBoxInput[] | null) ?? [],
    notes: (r.notes as string | null) ?? null,
    status: r.status as string,
    quotedPrice: r.quoted_price != null ? Number(r.quoted_price) : null,
    quotedCurrency: (r.quoted_currency as string | null) ?? null,
    staffResponse: (r.staff_response as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** CUSTOMER: request a quote. */
export async function createQuote(
  run: Run,
  customerId: string,
  branchId: string,
  input: CreateQuoteInput,
): Promise<QuoteRow> {
  return run(async (sql) => {
    const pid = publicId();
    await sql.query(
      `INSERT INTO quotes
         (public_id, branch_id, customer_id, origin_country, destination_country,
          service_level, contents_nature, boxes, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        pid,
        branchId,
        customerId,
        input.originCountry,
        input.destinationCountry,
        input.serviceLevel,
        input.contentsNature ?? null,
        JSON.stringify(input.boxes),
        input.notes ?? null,
      ],
    );

    const { rows } = await sql.query(`SELECT ${SELECT_FIELDS} FROM quotes q WHERE q.public_id = $1`, [pid]);
    return mapRow(rows[0]!);
  });
}

/** CUSTOMER: list their own quote requests, newest first. */
export async function listCustomerQuotes(run: Run, customerId: string): Promise<QuoteRow[]> {
  return run(async (sql) => {
    const { rows } = await sql.query(
      `SELECT ${SELECT_FIELDS} FROM quotes q
        WHERE q.customer_id = $1
        ORDER BY q.created_at DESC
        LIMIT 200`,
      [customerId],
    );
    return rows.map(mapRow);
  });
}

/** STAFF: list quotes in-branch (RLS-scoped), optionally filtered by status. */
export async function listQuotes(run: Run, opts: { status?: string }): Promise<
  (QuoteRow & { customerName: string | null; customerEmail: string | null })[]
> {
  return run(async (sql) => {
    const where = opts.status ? "WHERE q.status = $1" : "";
    const params = opts.status ? [opts.status] : [];
    const { rows } = await sql.query(
      `SELECT ${SELECT_FIELDS}, cu.full_name AS customer_name, cu.email AS customer_email
         FROM quotes q
         JOIN customers cu ON cu.id = q.customer_id
         ${where}
        ORDER BY q.created_at DESC
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

/** STAFF: update a quote's status and/or add pricing / a response. */
export async function updateQuote(
  run: Run,
  quotePublicId: string,
  staffUserId: string,
  input: UpdateQuoteInput,
): Promise<QuoteRow> {
  return run(async (sql) => {
    const { rows: existing } = await sql.query<{ id: string; branch_id: string }>(
      "SELECT id, branch_id FROM quotes WHERE public_id = $1",
      [quotePublicId],
    );
    if (!existing[0]) throw new QuoteError(404, "Quote not found");

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push(`status = $${params.length}`);
    }
    if (input.quotedPrice !== undefined) {
      params.push(input.quotedPrice);
      sets.push(`quoted_price = $${params.length}`);
    }
    if (input.quotedCurrency !== undefined) {
      params.push(input.quotedCurrency);
      sets.push(`quoted_currency = $${params.length}`);
    }
    if (input.staffResponse !== undefined) {
      params.push(input.staffResponse);
      sets.push(`staff_response = $${params.length}`);
    }
    params.push(staffUserId);
    sets.push(`handled_by = $${params.length}`);
    params.push(quotePublicId);

    await sql.query(`UPDATE quotes SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);

    const { rows: full } = await sql.query(`SELECT ${SELECT_FIELDS} FROM quotes q WHERE q.public_id = $1`, [
      quotePublicId,
    ]);
    const result = mapRow(full[0]!);

    pushToBranch(existing[0].branch_id, "quote_message", {
      quotePublicId,
      sender: "staff" as const,
      statusChanged: input.status !== undefined || input.quotedPrice !== undefined,
    });

    return result;
  });
}
export interface QuoteMessageRow {
  publicId: string;
  quotePublicId: string;
  sender: "customer" | "staff";
  authorName: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

function mapMessageRow(r: Record<string, unknown>): QuoteMessageRow {
  return {
    publicId: r.public_id as string,
    quotePublicId: r.quote_public_id as string,
    sender: r.sender as "customer" | "staff",
    authorName: (r.author_name as string | null) ?? null,
    authorEmail: (r.author_email as string | null) ?? null,
    body: r.body as string,
    createdAt: r.created_at as string,
  };
}

const MESSAGE_SELECT = `
  qm.public_id, q.public_id AS quote_public_id, qm.sender, qm.body, qm.created_at,
  COALESCE(cu.full_name, u.full_name) AS author_name,
  COALESCE(cu.email, u.email) AS author_email
`;

async function resolveQuoteId(sql: Sql, quotePublicId: string): Promise<string> {
  const { rows } = await sql.query<{ id: string }>(
    "SELECT id FROM quotes WHERE public_id = $1",
    [quotePublicId],
  );
  if (!rows[0]) throw new QuoteError(404, "Quote not found");
  return rows[0].id;
}

/** List a quote's message thread, oldest first. Used by both staff and the filing customer. */
export async function listQuoteMessages(run: Run, quotePublicId: string): Promise<QuoteMessageRow[]> {
  return run(async (sql) => {
    const quoteId = await resolveQuoteId(sql, quotePublicId);
    const { rows } = await sql.query(
      `SELECT ${MESSAGE_SELECT}
         FROM quote_messages qm
         JOIN quotes q ON q.id = qm.quote_id
         LEFT JOIN customers cu ON cu.id = qm.author_id AND qm.sender = 'customer'
         LEFT JOIN users u ON u.id = qm.author_id AND qm.sender = 'staff'
        WHERE qm.quote_id = $1
        ORDER BY qm.created_at ASC`,
      [quoteId],
    );
    return rows.map(mapMessageRow);
  });
}

/** Add a message to a quote's thread. */
export async function addQuoteMessage(
  run: Run,
  quotePublicId: string,
  sender: "customer" | "staff",
  authorId: string,
  body: string,
): Promise<QuoteMessageRow> {
  return run(async (sql) => {
    const quoteId = await resolveQuoteId(sql, quotePublicId);
    const pid = publicId();
    const { rows: branchRows } = await sql.query<{ branch_id: string }>(
      `INSERT INTO quote_messages (public_id, branch_id, quote_id, sender, author_id, body)
       SELECT $1, q.branch_id, $2, $3, $4, $5 FROM quotes q WHERE q.id = $2
       RETURNING branch_id`,
      [pid, quoteId, sender, authorId, body],
    );
    const { rows } = await sql.query(
      `SELECT ${MESSAGE_SELECT}
         FROM quote_messages qm
         JOIN quotes q ON q.id = qm.quote_id
         LEFT JOIN customers cu ON cu.id = qm.author_id AND qm.sender = 'customer'
         LEFT JOIN users u ON u.id = qm.author_id AND qm.sender = 'staff'
        WHERE qm.public_id = $1`,
      [pid],
    );
    const message = mapMessageRow(rows[0]!);

    pushToBranch(branchRows[0]!.branch_id, "quote_message", {
      quotePublicId,
      sender,
    });

    return message;
  });
}
export async function verifyQuoteOwnership(
  run: Run,
  quotePublicId: string,
  customerId: string,
): Promise<void> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ customer_id: string }>(
      "SELECT customer_id FROM quotes WHERE public_id = $1",
      [quotePublicId],
    );
    if (!rows[0]) throw new QuoteError(404, "Quote not found");
    if (rows[0].customer_id !== customerId) {
      throw new QuoteError(403, "You can only view your own quote requests");
    }
  });
}