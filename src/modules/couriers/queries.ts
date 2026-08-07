// Courier catalog (Direct / Via / By Sea service options) queries.
//
// `couriers` is a GLOBAL table (see migration 0042_couriers) — no branch_id,
// no RLS. It's queried through the request's branch-context runner (req.db)
// same as everything else, but since no RLS policy exists on this table that
// runner doesn't restrict which rows are visible; every branch always sees
// the same catalog.

import type { Sql } from "../../db/pool.js";
import { publicId } from "../../lib/ids.js";
import type { CreateCourierInput, UpdateCourierInput } from "./schema.js";

type Run = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

export class CourierError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type CourierCategory = "Direct" | "Via" | "By Sea";
export type CourierLevel = "Standard" | "Express" | "Freight";

export interface Courier {
  publicId: string;
  category: CourierCategory;
  name: string;
  level: CourierLevel;
  minDays: number;
  maxDays: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function mapRow(r: Record<string, unknown>): Courier {
  return {
    publicId: r.public_id as string,
    category: r.category as CourierCategory,
    name: r.name as string,
    level: r.level as CourierLevel,
    minDays: r.min_days as number,
    maxDays: r.max_days as number,
    isActive: r.is_active as boolean,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const SELECT_COLS = `public_id, category, name, level, min_days, max_days, is_active, sort_order, created_at, updated_at`;

export async function listCouriers(run: Run, opts: { activeOnly?: boolean } = {}): Promise<Courier[]> {
  return run(async (sql) => {
    const { rows } = opts.activeOnly
      ? await sql.query(
          `SELECT ${SELECT_COLS} FROM couriers WHERE is_active = true ORDER BY category, sort_order, name`,
        )
      : await sql.query(`SELECT ${SELECT_COLS} FROM couriers ORDER BY category, sort_order, name`);
    return rows.map(mapRow);
  });
}

export async function getCourier(run: Run, courierPublicId: string): Promise<Courier> {
  return run(async (sql) => {
    const { rows } = await sql.query(`SELECT ${SELECT_COLS} FROM couriers WHERE public_id = $1`, [
      courierPublicId,
    ]);
    if (!rows[0]) throw new CourierError(404, "Courier not found");
    return mapRow(rows[0]);
  });
}

export async function createCourier(run: Run, input: CreateCourierInput): Promise<Courier> {
  return run(async (sql) => {
    try {
      const { rows } = await sql.query(
        `INSERT INTO couriers (public_id, category, name, level, min_days, max_days, is_active, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${SELECT_COLS}`,
        [
          publicId(),
          input.category,
          input.name,
          input.level,
          input.minDays,
          input.maxDays,
          input.isActive ?? true,
          input.sortOrder ?? 0,
        ],
      );
      return mapRow(rows[0]!);
    } catch (err) {
      if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
        throw new CourierError(409, "A courier with that name already exists in this category");
      }
      throw err;
    }
  });
}

export async function updateCourier(
  run: Run,
  courierPublicId: string,
  input: UpdateCourierInput,
): Promise<Courier> {
  return run(async (sql) => {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    const fieldMap: Record<string, unknown> = {
      category: input.category,
      name: input.name,
      level: input.level,
      min_days: input.minDays,
      max_days: input.maxDays,
      is_active: input.isActive,
      sort_order: input.sortOrder,
    };
    for (const [col, val] of Object.entries(fieldMap)) {
      if (val !== undefined) {
        sets.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (sets.length === 0) return getCourier(run, courierPublicId);

    values.push(courierPublicId);
    try {
      const { rows } = await sql.query(
        `UPDATE couriers SET ${sets.join(", ")} WHERE public_id = $${i} RETURNING ${SELECT_COLS}`,
        values,
      );
      if (!rows[0]) throw new CourierError(404, "Courier not found");
      return mapRow(rows[0]);
    } catch (err) {
      if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
        throw new CourierError(409, "A courier with that name already exists in this category");
      }
      throw err;
    }
  });
}

export async function deleteCourier(run: Run, courierPublicId: string): Promise<void> {
  await run(async (sql) => {
    const { rowCount } = await sql.query("DELETE FROM couriers WHERE public_id = $1", [courierPublicId]);
    if (!rowCount) throw new CourierError(404, "Courier not found");
  });
}
