// Manifest queries — outbound consolidation batches. Runs through req.db
// (RLS branch-scoped), same pattern as modules/finance/queries.ts.
//
// Weight/piece totals are DERIVED from orders.boxes.chargeable_kg and cached
// on the manifest header (total_shipments, total_weight_kg), recomputed on
// every add/remove inside the same transaction — never a second source of
// truth.

import type { Sql } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import type { CreateManifestInput, UpdateManifestInput, ListManifestsQuery } from "./schema.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export class ManifestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function n(v: unknown): number {
  return v == null ? 0 : Number(v);
}

// ═══════════════════════════════════════════════════════════════════════════
// MANIFESTS
// ═══════════════════════════════════════════════════════════════════════════
export interface ManifestRow {
  publicId: string;
  manifestNo: string;
  branchPublicId: string;
  vendorPublicId: string | null;
  vendorName: string | null;
  manifestDate: string;
  status: string;
  totalShipments: number;
  totalWeightKg: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
}

const MANIFEST_FIELDS = `
  m.public_id, m.manifest_no, br.public_id AS branch_public_id,
  v.public_id AS vendor_public_id, v.name AS vendor_name,
  m.manifest_date, m.status, m.total_shipments, m.total_weight_kg, m.notes,
  m.created_at, m.updated_at, m.dispatched_at
`;

// Every query selecting MANIFEST_FIELDS must join branches AS br and
// LEFT JOIN vendors AS v — both aliases are referenced above.
const MANIFEST_JOINS = `
  JOIN branches br ON br.id = m.branch_id
  LEFT JOIN vendors v ON v.id = m.vendor_id
`;

function mapManifest(r: Record<string, unknown>): ManifestRow {
  return {
    publicId: r.public_id as string,
    manifestNo: r.manifest_no as string,
    branchPublicId: r.branch_public_id as string,
    vendorPublicId: (r.vendor_public_id as string | null) ?? null,
    vendorName: (r.vendor_name as string | null) ?? null,
    manifestDate: r.manifest_date as string,
    status: r.status as string,
    totalShipments: r.total_shipments as number,
    totalWeightKg: n(r.total_weight_kg),
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    dispatchedAt: (r.dispatched_at as string | null) ?? null,
  };
}

export interface ManifestShipmentRow {
  orderPublicId: string;
  trackingCode: string;
  senderName: string | null;
  receiverName: string | null;
  destination: string | null;
  weightKg: number;
  charges: number;
  currency: string;
  orderStatus: string;
}

const SHIPMENT_FIELDS = `
  o.public_id AS order_public_id, o.tracking_code, o.sender_name, o.receiver_name,
  o.receiver_city, o.receiver_country, o.price, o.currency, o.order_status,
  COALESCE((SELECT SUM(b.chargeable_kg) FROM boxes b WHERE b.order_id = o.id), 0) AS weight_kg
`;

function mapShipment(r: Record<string, unknown>): ManifestShipmentRow {
  const city = (r.receiver_city as string | null) ?? "";
  const country = (r.receiver_country as string | null) ?? "";
  return {
    orderPublicId: r.order_public_id as string,
    trackingCode: r.tracking_code as string,
    senderName: (r.sender_name as string | null) ?? null,
    receiverName: (r.receiver_name as string | null) ?? null,
    destination: [city, country].filter(Boolean).join(", ") || null,
    weightKg: n(r.weight_kg),
    charges: n(r.price),
    currency: (r.currency as string) ?? "PKR",
    orderStatus: r.order_status as string,
  };
}

// ── manifest_no generator (mirrors nextInvoiceNo in finance/queries.ts) ────
async function nextManifestNo(sql: Sql, branchId: string): Promise<string> {
  const year = new Date().getFullYear();
  const { rows } = await sql.query<{ seq: number }>(
    `SELECT COALESCE(MAX(
       CASE WHEN manifest_no ~ ('^PML-MF-' || $2::text || '-\\d+$')
         THEN substring(manifest_no FROM '\\d+$')::int
         ELSE 0
       END
     ), 0) + 1 AS seq
    FROM (
      SELECT manifest_no
        FROM manifests
       WHERE branch_id = $1
         AND manifest_no LIKE ('PML-MF-' || $2::text || '-%')
       FOR UPDATE
    ) locked`,
    [branchId, year],
  );
  const seq = rows[0]!.seq;
  return `PML-MF-${year}-${String(seq).padStart(6, "0")}`;
}

// Recompute + persist cached totals from the current shipment set. Call
// after every add/remove, inside the same transaction.
async function recomputeTotals(sql: Sql, manifestId: string): Promise<void> {
  await sql.query(
    `UPDATE manifests SET
       total_shipments = (SELECT COUNT(*) FROM manifest_shipments WHERE manifest_id = $1),
       total_weight_kg = (
         SELECT COALESCE(SUM(
           (SELECT COALESCE(SUM(b.chargeable_kg), 0) FROM boxes b WHERE b.order_id = ms.order_id)
         ), 0)
         FROM manifest_shipments ms WHERE ms.manifest_id = $1
       )
     WHERE id = $1`,
    [manifestId],
  );
}

// ── List ─────────────────────────────────────────────────────────────────
export async function listManifests(run: Run, opts: ListManifestsQuery = {}): Promise<ManifestRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { params.push(opts.status); conds.push(`m.status = $${params.length}`); }
    if (opts.q) {
      params.push(`%${opts.q}%`);
      conds.push(`(m.manifest_no ILIKE $${params.length} OR v.name ILIKE $${params.length})`);
    }
    if (opts.branchPublicId) {
      params.push(opts.branchPublicId);
      conds.push(`m.branch_id = (SELECT id FROM branches WHERE public_id = $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${MANIFEST_FIELDS} FROM manifests m
         ${MANIFEST_JOINS}
         ${where}
        ORDER BY m.manifest_date DESC, m.created_at DESC
        LIMIT 300`,
      params,
    );
    return rows.map(mapManifest);
  });
}

// ── Get one (header + shipments) ────────────────────────────────────────────
async function fetchManifestBySql(
  sql: Sql,
  publicIdArg: string,
): Promise<ManifestRow & { shipments: ManifestShipmentRow[] }> {
  const { rows } = await sql.query(
    `SELECT ${MANIFEST_FIELDS} FROM manifests m
       ${MANIFEST_JOINS}
      WHERE m.public_id = $1`,
    [publicIdArg],
  );
  if (!rows[0]) throw new ManifestError(404, "Manifest not found");
  const manifest = mapManifest(rows[0]!);

  // No branches join needed here — SHIPMENT_FIELDS only references o
  // (orders) and b (boxes); the manifest's branch already came from the
  // header query above.
  const { rows: shipRows } = await sql.query(
    `SELECT ${SHIPMENT_FIELDS} FROM manifest_shipments ms
       JOIN orders o ON o.id = ms.order_id
      WHERE ms.manifest_id = (SELECT id FROM manifests WHERE public_id = $1)
      ORDER BY ms.added_at ASC`,
    [publicIdArg],
  );
  return { ...manifest, shipments: shipRows.map(mapShipment) };
}

export async function getManifest(
  run: Run,
  publicIdArg: string,
): Promise<ManifestRow & { shipments: ManifestShipmentRow[] }> {
  return run((sql) => fetchManifestBySql(sql, publicIdArg));
}

// ── Create ───────────────────────────────────────────────────────────────
export async function createManifest(
  run: Run,
  branchId: string,
  userId: string,
  input: CreateManifestInput,
): Promise<ManifestRow & { shipments: ManifestShipmentRow[] }> {
  return run(async (sql) => {
    let vendorId: string | null = null;
    if (input.vendorPublicId) {
      const { rows } = await sql.query<{ id: string }>("SELECT id FROM vendors WHERE public_id = $1", [input.vendorPublicId]);
      if (!rows[0]) throw new ManifestError(404, "Vendor not found");
      vendorId = rows[0]!.id;
    }
    const manifestNo = await nextManifestNo(sql, branchId);
    const pid = publicId();
    await sql.query(
      `INSERT INTO manifests (public_id, branch_id, manifest_no, vendor_id, manifest_date, notes, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7)`,
      [pid, branchId, manifestNo, vendorId, input.manifestDate ?? null, input.notes ?? null, userId],
    );
    return fetchManifestBySql(sql, pid);
  });
}

// ── Update header (open manifests only — enforced here) ────────────────────
export async function updateManifest(
  run: Run,
  publicIdArg: string,
  input: UpdateManifestInput,
): Promise<ManifestRow & { shipments: ManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows: existing } = await sql.query<{ id: string; status: string }>(
      "SELECT id, status FROM manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!existing[0]) throw new ManifestError(404, "Manifest not found");
    if (existing[0].status !== "open") throw new ManifestError(400, "Only open manifests can be edited");

    let vendorId: string | null | undefined;
    if (input.vendorPublicId !== undefined) {
      if (input.vendorPublicId === null) {
       vendorId = null;
     } else {
       const { rows } = await sql.query<{ id: string }>("SELECT id FROM vendors WHERE public_id = $1", [input.vendorPublicId]);
       if (!rows[0]) throw new ManifestError(404, "Vendor not found");
       vendorId = rows[0]!.id;
     }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (vendorId !== undefined) push("vendor_id", vendorId);
    if (input.manifestDate !== undefined) push("manifest_date", input.manifestDate);
    if (input.notes !== undefined) push("notes", input.notes);
    if (!sets.length) throw new ManifestError(400, "No fields to update");
    params.push(publicIdArg);
    await sql.query(`UPDATE manifests SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);

    return fetchManifestBySql(sql, publicIdArg);
  });
}

// ── Add shipments (bulk, cross-manifest duplicate-checked) ─────────────────
export async function addShipments(
  run: Run,
  publicIdArg: string,
  orderPublicIds: string[],
): Promise<ManifestRow & { shipments: ManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows: mRows } = await sql.query<{ id: string; branch_id: string; status: string }>(
      "SELECT id, branch_id, status FROM manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!mRows[0]) throw new ManifestError(404, "Manifest not found");
    if (mRows[0].status !== "open") throw new ManifestError(400, "Can only add shipments to an open manifest");
    const manifestId = mRows[0].id;
    const branchId = mRows[0].branch_id;

    for (const orderPublicId of orderPublicIds) {
      const { rows: orderRows } = await sql.query<{ id: string }>(
        "SELECT id FROM orders WHERE public_id = $1",
        [orderPublicId],
      );
      if (!orderRows[0]) throw new ManifestError(404, `Order not found: ${orderPublicId}`);
      const orderId = orderRows[0]!.id;

      // Cross-manifest duplicate check: an order can't sit on two live
      // (non-dispatched) manifests at once. Row-locked to avoid a race
      // between two concurrent adds.
      const { rows: dupe } = await sql.query(
        `SELECT m.manifest_no FROM manifest_shipments ms
           JOIN manifests m ON m.id = ms.manifest_id
          WHERE ms.order_id = $1 AND m.status <> 'dispatched'
          FOR UPDATE OF ms`,
        [orderId],
      );
      if (dupe.length > 0) {
        throw new ManifestError(409, `Order ${orderPublicId} is already on manifest ${dupe[0]!.manifest_no}`);
      }

      await sql.query(
        `INSERT INTO manifest_shipments (manifest_id, branch_id, order_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (manifest_id, order_id) DO NOTHING`,
        [manifestId, branchId, orderId],
      );
    }

    await recomputeTotals(sql, manifestId);
    return fetchManifestBySql(sql, publicIdArg);
  });
}

// ── Remove one shipment (open manifests only) ───────────────────────────────
export async function removeShipment(
  run: Run,
  publicIdArg: string,
  orderPublicId: string,
): Promise<ManifestRow & { shipments: ManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows: mRows } = await sql.query<{ id: string; status: string }>(
      "SELECT id, status FROM manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!mRows[0]) throw new ManifestError(404, "Manifest not found");
    if (mRows[0].status !== "open") throw new ManifestError(400, "Can only remove shipments from an open manifest");
    const manifestId = mRows[0].id;

    await sql.query(
      `DELETE FROM manifest_shipments
        WHERE manifest_id = $1
          AND order_id = (SELECT id FROM orders WHERE public_id = $2)`,
      [manifestId, orderPublicId],
    );

    await recomputeTotals(sql, manifestId);
    return fetchManifestBySql(sql, publicIdArg);
  });
}

// ── Close (locks editing; open → closed) ────────────────────────────────────
export async function closeManifest(
  run: Run,
  publicIdArg: string,
  userId: string,
): Promise<ManifestRow & { shipments: ManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ status: string }>(
      "SELECT status FROM manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!rows[0]) throw new ManifestError(404, "Manifest not found");
    if (rows[0].status !== "open") throw new ManifestError(400, "Only open manifests can be closed");

    await sql.query(
      "UPDATE manifests SET status = 'closed', closed_by = $2 WHERE public_id = $1",
      [publicIdArg, userId],
    );
    return fetchManifestBySql(sql, publicIdArg);
  });
}
// ── Delete (hard delete, any status — cascades to manifest_shipments) ──────
export async function deleteManifest(run: Run, publicIdArg: string): Promise<void> {
  await run(async (sql) => {
    const { rowCount } = await sql.query("DELETE FROM manifests WHERE public_id = $1", [publicIdArg]);
    if (!rowCount) throw new ManifestError(404, "Manifest not found");
  });
}

// ── Dispatch (final handover to carrier; closed → dispatched) ──────────────
export async function dispatchManifest(
  run: Run,
  publicIdArg: string,
): Promise<ManifestRow & { shipments: ManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ status: string }>(
      "SELECT status FROM manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!rows[0]) throw new ManifestError(404, "Manifest not found");
    if (rows[0].status !== "closed") throw new ManifestError(400, "Only closed manifests can be dispatched");

    await sql.query(
      "UPDATE manifests SET status = 'dispatched', dispatched_at = now() WHERE public_id = $1",
      [publicIdArg],
    );
    return fetchManifestBySql(sql, publicIdArg);
  });
}

// ── Search orders eligible to add (tracking-number search box) ─────────────
// q is optional: an empty/omitted q lists all eligible orders in the given
// branch (used by the frontend combobox's default "browse" view). A
// non-empty q narrows that list by tracking_code — same code path handles
// typed search, barcode-scanned lookups, and the initial branch listing.
export interface EligibleOrderRow {
  publicId: string;
  trackingCode: string;
  receiverName: string | null;
  destination: string | null;
  weightKg: number;
}

export async function searchEligibleOrders(
  run: Run,
  opts: { q?: string; branchPublicId?: string },
): Promise<EligibleOrderRow[]> {
  return run(async (sql) => {
    // Always excludes orders already on a live (non-dispatched) manifest —
    // this is the base condition regardless of whether q/branch filters apply.
   const conds: string[] = [
      `NOT EXISTS (
         SELECT 1 FROM manifest_shipments ms
           JOIN manifests m ON m.id = ms.manifest_id
          WHERE ms.order_id = o.id AND m.status <> 'dispatched'
       )`,
      `o.order_status IN ('awaiting_carrier', 'active')`,
    ];
    const params: unknown[] = [];

    const q = opts.q?.trim();
    if (q) {
      params.push(`%${q}%`);
      conds.push(`o.tracking_code ILIKE $${params.length}`);
    }
    if (opts.branchPublicId) {
      params.push(opts.branchPublicId);
      conds.push(`o.branch_id = (SELECT id FROM branches WHERE public_id = $${params.length})`);
    }

    const { rows } = await sql.query(
      `SELECT o.public_id, o.tracking_code, o.receiver_name, o.receiver_city, o.receiver_country,
              COALESCE((SELECT SUM(b.chargeable_kg) FROM boxes b WHERE b.order_id = o.id), 0) AS weight_kg
         FROM orders o
        WHERE ${conds.join(" AND ")}
        ORDER BY o.created_at DESC
        LIMIT 30`,
      params,
    );
    return rows.map((r) => ({
      publicId: r.public_id as string,
      trackingCode: r.tracking_code as string,
      receiverName: (r.receiver_name as string | null) ?? null,
      destination: [r.receiver_city, r.receiver_country].filter(Boolean).join(", ") || null,
      weightKg: n(r.weight_kg),
    }));
  });
}