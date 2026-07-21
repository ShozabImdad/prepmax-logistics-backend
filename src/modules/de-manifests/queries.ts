// De-Manifest queries — inbound receiving & reconciliation. Runs through
// req.db (RLS branch-scoped), same pattern as modules/manifest/queries.ts.
//
// "Expected" list (Q6): when a de-manifest is created with a sourceManifestPublicId,
// its shipments are copied in as reconciliation='pending' rows (order_id set,
// not yet received). When there's no source manifest, there's no expected
// list — rows only appear as they're scanned. Either way, completing the
// de-manifest flips any still-'pending' rows to 'missing'.
//
// Matching (Q5): scanning a tracking code looks it up against orders.
// Matched -> order_id set, reconciliation 'received' (or updates the
// pre-seeded 'pending' row if this order was expected). Unmatched -> a new
// row with order_id NULL, reconciliation 'extra' — covers "our own order,
// just not on this de-manifest's list" and "unrecognised/external code" the
// same way, per the design doc's own definition of "extra".

import type { Sql } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import type {
  CreateDeManifestInput, UpdateDeManifestInput, ScanShipmentInput,
  UpdateShipmentInput, ListDeManifestsQuery,
} from "./schema.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export class DeManifestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function n(v: unknown): number {
  return v == null ? 0 : Number(v);
}

// ═══════════════════════════════════════════════════════════════════════════
// DE-MANIFESTS
// ═══════════════════════════════════════════════════════════════════════════
export interface DeManifestRow {
  publicId: string;
  deManifestNo: string;
  branchPublicId: string;
  sourceManifestPublicId: string | null;
  sourceManifestNo: string | null;
  vendorPublicId: string | null;
  vendorName: string | null;
  courierName: string | null;
  deManifestDate: string;
  status: string;
  totalExpected: number;
  totalReceived: number;
  totalMissing: number;
  totalExtra: number;
  totalDamaged: number;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const DM_FIELDS = `
  dm.public_id, dm.de_manifest_no, br.public_id AS branch_public_id,
  sm.public_id AS source_manifest_public_id, sm.manifest_no AS source_manifest_no,
  v.public_id AS vendor_public_id, v.name AS vendor_name, dm.courier_name,
  dm.de_manifest_date, dm.status,
  dm.total_expected, dm.total_received, dm.total_missing, dm.total_extra, dm.total_damaged,
  dm.remarks, dm.created_at, dm.updated_at, dm.completed_at
`;

// Every query selecting DM_FIELDS must join branches AS br, LEFT JOIN
// manifests AS sm, and LEFT JOIN vendors AS v — all three aliases are
// referenced above.
const DM_JOINS = `
  JOIN branches br ON br.id = dm.branch_id
  LEFT JOIN manifests sm ON sm.id = dm.source_manifest_id
  LEFT JOIN vendors v ON v.id = dm.vendor_id
`;

function mapDeManifest(r: Record<string, unknown>): DeManifestRow {
  return {
    publicId: r.public_id as string,
    deManifestNo: r.de_manifest_no as string,
    branchPublicId: r.branch_public_id as string,
    sourceManifestPublicId: (r.source_manifest_public_id as string | null) ?? null,
    sourceManifestNo: (r.source_manifest_no as string | null) ?? null,
    vendorPublicId: (r.vendor_public_id as string | null) ?? null,
    vendorName: (r.vendor_name as string | null) ?? null,
    courierName: (r.courier_name as string | null) ?? null,
    deManifestDate: r.de_manifest_date as string,
    status: r.status as string,
    totalExpected: n(r.total_expected),
    totalReceived: n(r.total_received),
    totalMissing: n(r.total_missing),
    totalExtra: n(r.total_extra),
    totalDamaged: n(r.total_damaged),
    remarks: (r.remarks as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    completedAt: (r.completed_at as string | null) ?? null,
  };
}

export interface DeManifestShipmentRow {
  id: string;
  orderPublicId: string | null;
  scannedTracking: string;
  senderName: string | null;
  receiverName: string | null;
  destination: string | null;
  receivedAt: string | null;
  condition: string | null;
  reconciliation: string;
  remarks: string | null;
}

const DMS_FIELDS = `
  ms.id, o.public_id AS order_public_id, ms.scanned_tracking,
  o.sender_name, o.receiver_name, o.receiver_city, o.receiver_country,
  ms.manual_sender_name, ms.manual_receiver_name, ms.manual_destination,
  ms.received_at, ms.condition, ms.reconciliation, ms.remarks
`;

function mapShipment(r: Record<string, unknown>): DeManifestShipmentRow {
  const city = (r.receiver_city as string | null) ?? "";
  const country = (r.receiver_country as string | null) ?? "";
  const orderDestination = [city, country].filter(Boolean).join(", ") || null;
  return {
    id: r.id as string,
    orderPublicId: (r.order_public_id as string | null) ?? null,
    scannedTracking: r.scanned_tracking as string,
    // Manual fields are the fallback only — a matched order always wins.
    senderName: (r.sender_name as string | null) ?? (r.manual_sender_name as string | null) ?? null,
    receiverName: (r.receiver_name as string | null) ?? (r.manual_receiver_name as string | null) ?? null,
    destination: orderDestination ?? (r.manual_destination as string | null) ?? null,
    receivedAt: (r.received_at as string | null) ?? null,
    condition: (r.condition as string | null) ?? null,
    reconciliation: r.reconciliation as string,
    remarks: (r.remarks as string | null) ?? null,
  };
}

// ── de_manifest_no generator (mirrors nextManifestNo in manifest/queries.ts) ─
async function nextDeManifestNo(sql: Sql, branchId: string): Promise<string> {
  const year = new Date().getFullYear();
  const { rows } = await sql.query<{ seq: number }>(
    `SELECT COALESCE(MAX(
       CASE WHEN de_manifest_no ~ ('^PML-DMF-' || $2::text || '-\\d+$')
         THEN substring(de_manifest_no FROM '\\d+$')::int
         ELSE 0
       END
     ), 0) + 1 AS seq
    FROM (
      SELECT de_manifest_no
        FROM de_manifests
       WHERE branch_id = $1
         AND de_manifest_no LIKE ('PML-DMF-' || $2::text || '-%')
       FOR UPDATE
    ) locked`,
    [branchId, year],
  );
  const seq = rows[0]!.seq;
  return `PML-DMF-${year}-${String(seq).padStart(6, "0")}`;
}

// Recompute + persist cached counts from the current shipment set. Call
// after every scan/update/remove/complete, inside the same transaction.
// total_expected = everything that isn't an unrecognised 'extra' scan —
// i.e. rows we know belong to this batch, whether resolved yet or not.
async function recomputeCounts(sql: Sql, deManifestId: string): Promise<void> {
  await sql.query(
    `UPDATE de_manifests SET
       total_expected = (SELECT COUNT(*) FROM de_manifest_shipments WHERE de_manifest_id = $1 AND reconciliation <> 'extra'),
       total_received = (SELECT COUNT(*) FROM de_manifest_shipments WHERE de_manifest_id = $1 AND reconciliation = 'received'),
       total_missing  = (SELECT COUNT(*) FROM de_manifest_shipments WHERE de_manifest_id = $1 AND reconciliation = 'missing'),
       total_extra    = (SELECT COUNT(*) FROM de_manifest_shipments WHERE de_manifest_id = $1 AND reconciliation = 'extra'),
       total_damaged  = (SELECT COUNT(*) FROM de_manifest_shipments WHERE de_manifest_id = $1 AND condition = 'damaged')
     WHERE id = $1`,
    [deManifestId],
  );
}

// ── List ─────────────────────────────────────────────────────────────────
export async function listDeManifests(run: Run, opts: ListDeManifestsQuery = {}): Promise<DeManifestRow[]> {
  return run(async (sql) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { params.push(opts.status); conds.push(`dm.status = $${params.length}`); }
    if (opts.q) {
      params.push(`%${opts.q}%`);
      conds.push(`(dm.de_manifest_no ILIKE $${params.length} OR dm.courier_name ILIKE $${params.length} OR v.name ILIKE $${params.length})`);
    }
    if (opts.branchPublicId) {
      params.push(opts.branchPublicId);
      conds.push(`dm.branch_id = (SELECT id FROM branches WHERE public_id = $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await sql.query(
      `SELECT ${DM_FIELDS} FROM de_manifests dm
         ${DM_JOINS}
         ${where}
        ORDER BY dm.de_manifest_date DESC, dm.created_at DESC
        LIMIT 300`,
      params,
    );
    return rows.map(mapDeManifest);
  });
}

// ── Get one (header + shipments) ────────────────────────────────────────────
async function fetchDeManifestBySql(
  sql: Sql,
  publicIdArg: string,
): Promise<DeManifestRow & { shipments: DeManifestShipmentRow[] }> {
  const { rows } = await sql.query(
    `SELECT ${DM_FIELDS} FROM de_manifests dm
       ${DM_JOINS}
      WHERE dm.public_id = $1`,
    [publicIdArg],
  );
  if (!rows[0]) throw new DeManifestError(404, "De-manifest not found");
  const deManifest = mapDeManifest(rows[0]!);

  const { rows: shipRows } = await sql.query(
    `SELECT ${DMS_FIELDS} FROM de_manifest_shipments ms
       LEFT JOIN orders o ON o.id = ms.order_id
      WHERE ms.de_manifest_id = (SELECT id FROM de_manifests WHERE public_id = $1)
      ORDER BY ms.created_at ASC`,
    [publicIdArg],
  );
  return { ...deManifest, shipments: shipRows.map(mapShipment) };
}

export async function getDeManifest(
  run: Run,
  publicIdArg: string,
): Promise<DeManifestRow & { shipments: DeManifestShipmentRow[] }> {
  return run((sql) => fetchDeManifestBySql(sql, publicIdArg));
}

// ── Create (optionally seeding the expected list from a source manifest) ───
export async function createDeManifest(
  run: Run,
  branchId: string,
  userId: string,
  input: CreateDeManifestInput,
): Promise<DeManifestRow & { shipments: DeManifestShipmentRow[] }> {
  return run(async (sql) => {
    let vendorId: string | null = null;
    if (input.vendorPublicId) {
      const { rows } = await sql.query<{ id: string }>("SELECT id FROM vendors WHERE public_id = $1", [input.vendorPublicId]);
      if (!rows[0]) throw new DeManifestError(404, "Vendor not found");
      vendorId = rows[0]!.id;
    }

    let sourceManifestId: string | null = null;
    if (input.sourceManifestPublicId) {
      const { rows } = await sql.query<{ id: string; vendor_id: string | null }>(
        "SELECT id, vendor_id FROM manifests WHERE public_id = $1",
        [input.sourceManifestPublicId],
      );
      if (!rows[0]) throw new DeManifestError(404, "Source manifest not found");
      sourceManifestId = rows[0]!.id;
      // Default the de-manifest's vendor to whatever the linked outbound
      // manifest was booked with — usually the same courier is handing the
      // batch back over on arrival. Still overridable: only fills the gap
      // when the caller didn't explicitly pick a vendor themselves.
      if (!vendorId && rows[0]!.vendor_id) {
        vendorId = rows[0]!.vendor_id;
      }
    }

    const deManifestNo = await nextDeManifestNo(sql, branchId);
    const pid = publicId();
    const { rows: inserted } = await sql.query<{ id: string }>(
      `INSERT INTO de_manifests
         (public_id, branch_id, de_manifest_no, source_manifest_id, vendor_id, courier_name, de_manifest_date, remarks, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),$8,$9)
       RETURNING id`,
      [pid, branchId, deManifestNo, sourceManifestId, vendorId, input.courierName ?? null,
       input.deManifestDate ?? null, input.remarks ?? null, userId],
    );
    const deManifestId = inserted[0]!.id;

    // Seed the expected list: every order on the linked source manifest
    // becomes a 'pending' row (not yet physically scanned in).
    if (sourceManifestId) {
      await sql.query(
        `INSERT INTO de_manifest_shipments (de_manifest_id, branch_id, order_id, scanned_tracking, reconciliation)
         SELECT $1, $2, ms.order_id, o.tracking_code, 'pending'
           FROM manifest_shipments ms
           JOIN orders o ON o.id = ms.order_id
          WHERE ms.manifest_id = $3`,
        [deManifestId, branchId, sourceManifestId],
      );
      await recomputeCounts(sql, deManifestId);
    }

    return fetchDeManifestBySql(sql, pid);
  });
}

// ── Update header (open only) ───────────────────────────────────────────────
export async function updateDeManifest(
  run: Run,
  publicIdArg: string,
  input: UpdateDeManifestInput,
): Promise<DeManifestRow & { shipments: DeManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows: existing } = await sql.query<{ id: string; status: string }>(
      "SELECT id, status FROM de_manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!existing[0]) throw new DeManifestError(404, "De-manifest not found");
    if (existing[0].status !== "open") throw new DeManifestError(400, "Only open de-manifests can be edited");

    let vendorId: string | null | undefined;
    if (input.vendorPublicId === null) {
      vendorId = null; // explicit clear — "— Not set —"
    } else if (input.vendorPublicId !== undefined) {
      const { rows } = await sql.query<{ id: string }>("SELECT id FROM vendors WHERE public_id = $1", [input.vendorPublicId]);
      if (!rows[0]) throw new DeManifestError(404, "Vendor not found");
      vendorId = rows[0]!.id;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (vendorId !== undefined) push("vendor_id", vendorId);
    if (input.courierName !== undefined) push("courier_name", input.courierName);
    if (input.deManifestDate !== undefined) push("de_manifest_date", input.deManifestDate);
    if (input.remarks !== undefined) push("remarks", input.remarks);
    if (!sets.length) throw new DeManifestError(400, "No fields to update");
    params.push(publicIdArg);
    await sql.query(`UPDATE de_manifests SET ${sets.join(", ")} WHERE public_id = $${params.length}`, params);

    return fetchDeManifestBySql(sql, publicIdArg);
  });
}

// ── Scan/add a shipment (open only) ─────────────────────────────────────────
// Looks the tracking code up against orders in the same branch. Matched +
// already on the expected list -> that row is updated to 'received'.
// Matched but not expected -> a new 'received' row (a recognised order that
// wasn't on this batch's list). Unmatched -> a new 'extra' row, order_id NULL.
export async function scanShipment(
  run: Run,
  publicIdArg: string,
  input: ScanShipmentInput,
): Promise<DeManifestRow & { shipments: DeManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows: dmRows } = await sql.query<{ id: string; branch_id: string; status: string }>(
      "SELECT id, branch_id, status FROM de_manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!dmRows[0]) throw new DeManifestError(404, "De-manifest not found");
    if (dmRows[0].status !== "open") throw new DeManifestError(400, "Can only scan shipments into an open de-manifest");
    const deManifestId = dmRows[0].id;
    const branchId = dmRows[0].branch_id;

    const { rows: orderRows } = await sql.query<{ id: string }>(
      "SELECT id FROM orders WHERE tracking_code = $1",
      [input.trackingCode],
    );
    const orderId = orderRows[0]?.id ?? null;
    const condition = input.condition ?? (orderId ? "good" : null);

    if (orderId) {
      const { rows: pendingRow } = await sql.query<{ id: string }>(
        `SELECT id FROM de_manifest_shipments
          WHERE de_manifest_id = $1 AND order_id = $2 AND reconciliation = 'pending'
          FOR UPDATE`,
        [deManifestId, orderId],
      );
      if (pendingRow[0]) {
        await sql.query(
          `UPDATE de_manifest_shipments
              SET received_at = now(), condition = $2, reconciliation = 'received',
                  remarks = COALESCE($3, remarks), scanned_tracking = $4
            WHERE id = $1`,
          [pendingRow[0]!.id, condition, input.remarks ?? null, input.trackingCode],
        );
      } else {
        // Already-received row for this order on this de-manifest -> block
        // instead of silently re-updating it (previous behavior looked like
        // scanning twice "did nothing").
        const { rows: existingRow } = await sql.query<{ id: string }>(
          `SELECT id FROM de_manifest_shipments WHERE de_manifest_id = $1 AND order_id = $2 FOR UPDATE`,
          [deManifestId, orderId],
        );
        if (existingRow[0]) {
          throw new DeManifestError(409, `${input.trackingCode} was already scanned into this de-manifest`);
        }
        // Recognised order not on the expected list -> first scan, insert fresh.
        await sql.query(
          `INSERT INTO de_manifest_shipments
             (de_manifest_id, branch_id, order_id, scanned_tracking, received_at, condition, reconciliation, remarks)
           VALUES ($1,$2,$3,$4,now(),$5,'received',$6)`,
          [deManifestId, branchId, orderId, input.trackingCode, condition, input.remarks ?? null],
        );
      }
    } else {
      // Unmatched code -> block a repeat scan of the exact same tracking
      // string within this de-manifest, rather than inserting a duplicate
      // 'extra' row every time.
      const { rows: existingExtra } = await sql.query<{ id: string }>(
        `SELECT id FROM de_manifest_shipments
          WHERE de_manifest_id = $1 AND order_id IS NULL AND scanned_tracking = $2
          FOR UPDATE`,
        [deManifestId, input.trackingCode],
      );
      if (existingExtra[0]) {
        throw new DeManifestError(409, `${input.trackingCode} was already scanned into this de-manifest`);
      }
      await sql.query(
        `INSERT INTO de_manifest_shipments
           (de_manifest_id, branch_id, order_id, scanned_tracking, received_at, condition, reconciliation, remarks,
            manual_sender_name, manual_receiver_name, manual_destination)
         VALUES ($1,$2,NULL,$3,now(),$4,'extra',$5,$6,$7,$8)`,
        [deManifestId, branchId, input.trackingCode, condition, input.remarks ?? null,
         input.manualSenderName ?? null, input.manualReceiverName ?? null, input.manualDestination ?? null],
      );
    }

    await recomputeCounts(sql, deManifestId);
    return fetchDeManifestBySql(sql, publicIdArg);
  });
}

// ── Manually update a shipment row (condition/reconciliation/remarks) ──────
export async function updateShipment(
  run: Run,
  publicIdArg: string,
  shipmentId: string,
  input: UpdateShipmentInput,
): Promise<DeManifestRow & { shipments: DeManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows: dmRows } = await sql.query<{ id: string; status: string }>(
      "SELECT id, status FROM de_manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!dmRows[0]) throw new DeManifestError(404, "De-manifest not found");
    if (dmRows[0].status !== "open") throw new DeManifestError(400, "Only open de-manifests can be edited");

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (input.condition !== undefined) push("condition", input.condition);
    if (input.reconciliation !== undefined) push("reconciliation", input.reconciliation);
    if (input.remarks !== undefined) push("remarks", input.remarks);
    if (input.manualSenderName !== undefined) push("manual_sender_name", input.manualSenderName);
    if (input.manualReceiverName !== undefined) push("manual_receiver_name", input.manualReceiverName);
    if (input.manualDestination !== undefined) push("manual_destination", input.manualDestination);
    if (!sets.length) throw new DeManifestError(400, "No fields to update");
    params.push(shipmentId, dmRows[0].id);
    const { rowCount } = await sql.query(
      `UPDATE de_manifest_shipments SET ${sets.join(", ")}
        WHERE id = $${params.length - 1} AND de_manifest_id = $${params.length}`,
      params,
    );
    if (!rowCount) throw new DeManifestError(404, "Shipment row not found on this de-manifest");

    await recomputeCounts(sql, dmRows[0].id);
    return fetchDeManifestBySql(sql, publicIdArg);
  });
}

// ── Remove one scanned row (open only) ──────────────────────────────────────
export async function removeShipment(
  run: Run,
  publicIdArg: string,
  shipmentId: string,
): Promise<DeManifestRow & { shipments: DeManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows: dmRows } = await sql.query<{ id: string; status: string }>(
      "SELECT id, status FROM de_manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!dmRows[0]) throw new DeManifestError(404, "De-manifest not found");
    if (dmRows[0].status !== "open") throw new DeManifestError(400, "Can only remove rows from an open de-manifest");

    await sql.query(
      "DELETE FROM de_manifest_shipments WHERE id = $1 AND de_manifest_id = $2",
      [shipmentId, dmRows[0].id],
    );

    await recomputeCounts(sql, dmRows[0].id);
    return fetchDeManifestBySql(sql, publicIdArg);
  });
}

// ── Delete (hard delete, any status — cascades to de_manifest_shipments) ───
export async function deleteDeManifest(run: Run, publicIdArg: string): Promise<void> {
  await run(async (sql) => {
    const { rowCount } = await sql.query("DELETE FROM de_manifests WHERE public_id = $1", [publicIdArg]);
    if (!rowCount) throw new DeManifestError(404, "De-manifest not found");
  });
}
// ── Complete (locks editing; any still-'pending' rows become 'missing') ────
export async function completeDeManifest(
  run: Run,
  publicIdArg: string,
  userId: string,
): Promise<DeManifestRow & { shipments: DeManifestShipmentRow[] }> {
  return run(async (sql) => {
    const { rows } = await sql.query<{ id: string; status: string }>(
      "SELECT id, status FROM de_manifests WHERE public_id = $1",
      [publicIdArg],
    );
    if (!rows[0]) throw new DeManifestError(404, "De-manifest not found");
    if (rows[0].status !== "open") throw new DeManifestError(400, "Only open de-manifests can be completed");
    const deManifestId = rows[0]!.id;

    await sql.query(
      "UPDATE de_manifest_shipments SET reconciliation = 'missing' WHERE de_manifest_id = $1 AND reconciliation = 'pending'",
      [deManifestId],
    );
    await recomputeCounts(sql, deManifestId);
    await sql.query(
      "UPDATE de_manifests SET status = 'completed', completed_by = $2, completed_at = now() WHERE public_id = $1",
      [publicIdArg, userId],
    );
    return fetchDeManifestBySql(sql, publicIdArg);
  });
}