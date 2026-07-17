// Gathers all data a document (AWB / receipt) needs for one order. Runs through
// the request's branch-context runner (RLS applies), so a caller can only
// generate documents for orders in their own branch.

import type { Sql } from "../../db/pool.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export interface DocContact {
  name: string | null; company: string | null; phone: string | null; email: string | null;
  cnic: string | null; ntn: string | null;
  address: string | null; address2: string | null; city: string | null; state: string | null;
  country: string | null; postcode: string | null;
}
export interface DocItem {
  description: string; quantity: number; unitValue: number | null;
  hsCode: string | null; countryOfOrigin: string | null;
}
export interface DocBox {
  label: string | null; weightKg: number; lengthCm: number; widthCm: number; heightCm: number;
  volumetricKg: number; chargeableKg: number; items: DocItem[];
}
export interface DocData {
  trackingCode: string;
  awbNumber: string | null;
  branchName: string;
  branchCity: string;
  createdAt: string;
  sender: DocContact;
  receiver: DocContact;
  serviceType: string | null;
  serviceLevel: string | null;
  originCountry: string | null;
  destinationCountry: string | null;
  carrier: string | null;
  contentsNature: string | null;
  declaredValue: number | null;
  currency: string | null;
  duties: string | null;
  handlingFlags: string[];
  price?: number | string | null;
priceCurrency?: string | null;
  notes: string | null;
  boxes: DocBox[];
  totalGrossKg: number;
  totalChargeableKg: number;
  pieceCount: number;
}

function contact(o: Record<string, unknown>, p: "sender" | "receiver"): DocContact {
  return {
    name: (o[`${p}_name`] as string) ?? null,
    company: (o[`${p}_company`] as string) ?? null,
    phone: (o[`${p}_phone`] as string) ?? null,
    email: (o[`${p}_email`] as string) ?? null,
    cnic: (o[`${p}_cnic`] as string) ?? null,
    ntn: (o[`${p}_ntn`] as string) ?? null,
    address: (o[`${p}_address`] as string) ?? null,
    address2: (o[`${p}_address2`] as string) ?? null,
    city: (o[`${p}_city`] as string) ?? null,
    state: (o[`${p}_state`] as string) ?? null,
    country: (o[`${p}_country`] as string) ?? null,
    postcode: (o[`${p}_postcode`] as string) ?? null,
  };
}

const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** Load a full order's document data by public id, or null if not visible. */
export async function loadDocData(run: Run, orderPublicId: string): Promise<DocData | null> {
  return run(async (sql) => {
    const { rows } = await sql.query(
      `SELECT o.*, b.name AS branch_name, b.city AS branch_city
         FROM orders o JOIN branches b ON b.id = o.branch_id
        WHERE o.public_id = $1`,
      [orderPublicId],
    );
    const o = rows[0];
    if (!o) return null;

    const boxRows = await sql.query(
      `SELECT id, label, weight_kg, length_cm, width_cm, height_cm, volumetric_kg, chargeable_kg
         FROM boxes WHERE order_id = $1 ORDER BY sequence`,
      [o.id],
    );
    const boxIds = boxRows.rows.map((b) => b.id);
    const itemRows = boxIds.length
      ? await sql.query(
          `SELECT box_id, description, quantity, unit_value, hs_code, country_of_origin
             FROM box_items WHERE box_id = ANY($1)`,
          [boxIds],
        )
      : { rows: [] as Record<string, unknown>[] };

    const boxes: DocBox[] = boxRows.rows.map((b) => ({
      label: b.label,
      weightKg: Number(b.weight_kg),
      lengthCm: Number(b.length_cm),
      widthCm: Number(b.width_cm),
      heightCm: Number(b.height_cm),
      volumetricKg: Number(b.volumetric_kg),
      chargeableKg: Number(b.chargeable_kg),
      items: itemRows.rows
        .filter((it) => it.box_id === b.id)
        .map((it) => ({
          description: it.description as string,
          quantity: it.quantity as number,
          unitValue: it.unit_value != null ? Number(it.unit_value) : null,
          hsCode: (it.hs_code as string) ?? null,
          countryOfOrigin: (it.country_of_origin as string) ?? null,
        })),
    }));

   const legRows = await sql.query(
      `SELECT carrier FROM shipment_legs
        WHERE order_id = $1 AND is_active = true
        ORDER BY sequence LIMIT 1`,
      [o.id],
    );
    const carrier = legRows.rows[0]?.carrier ?? null;

    const totalGrossKg = round3(boxes.reduce((s, b) => s + b.weightKg, 0));
    const totalChargeableKg = round3(boxes.reduce((s, b) => s + b.chargeableKg, 0));

  return {
  trackingCode: o.tracking_code,
  awbNumber: o.awb_number,
  branchName: o.branch_name,
  branchCity: o.branch_city,
  createdAt: o.created_at,
  sender: contact(o, "sender"),
  receiver: contact(o, "receiver"),
  serviceType: o.service_type,
  serviceLevel: o.service_level,
  originCountry: o.origin_country,
  destinationCountry: o.destination_country,
  carrier,
  contentsNature: o.contents_nature,
  declaredValue: o.declared_total != null ? Number(o.declared_total) : null,
  currency: o.declared_currency,
  duties: o.duties,
  handlingFlags: (o.handling_flags as string[]) ?? [],
  price: o.price != null ? Number(o.price) : null,
  priceCurrency: o.price_currency,
  notes: o.notes,
  boxes,
  totalGrossKg,
  totalChargeableKg,
  pieceCount: boxes.length,
};
  });
}
