// In-process job store for bulk order tracking sync.
// Snapshot order IDs under the requestor's RLS, then sync in the background via
// syncOrder (which opens its own DB transactions). Avoids HTTP timeouts on large fleets.

import { randomUUID } from "node:crypto";
import { syncOrder } from "../../tracking/sync.js";

const SYNC_ALL_CONCURRENCY = 2;
const JOB_TTL_MS = 60 * 60 * 1000; // keep finished jobs 1 hour for polling

export type SyncAllJobStatus = "queued" | "running" | "completed" | "failed";

export interface SyncAllJobOrderResult {
  publicId: string;
  trackingCode: string;
  status: "no_legs" | "synced" | "error";
  newEvents: number;
  userMessages: string[];
}

export interface SyncAllJobSnapshot {
  id: string;
  status: SyncAllJobStatus;
  total: number;
  completed: number;
  synced: number;
  failed: number;
  newEvents: number;
  orders: SyncAllJobOrderResult[];
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

interface SyncableOrder {
  id: string;
  publicId: string;
  trackingCode: string;
}

interface SyncAllJobInternal {
  id: string;
  createdByUserId: string;
  status: SyncAllJobStatus;
  total: number;
  completed: number;
  synced: number;
  failed: number;
  newEvents: number;
  orders: SyncAllJobOrderResult[];
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, SyncAllJobInternal>();

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
    // Also drop abandoned queued jobs older than TTL
    else if (!job.finishedAt && job.createdAt < cutoff) jobs.delete(id);
  }
}

/** Run async work over items with a fixed concurrency cap (matches the poller). */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function toSnapshot(job: SyncAllJobInternal): SyncAllJobSnapshot {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    synced: job.synced,
    failed: job.failed,
    newEvents: job.newEvents,
    orders: job.orders,
    error: job.error,
    createdAt: new Date(job.createdAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
  };
}

export function getSyncAllJob(
  jobId: string,
  requesterUserId: string,
  isSuperAdmin: boolean,
): SyncAllJobSnapshot | null {
  pruneOldJobs();
  const job = jobs.get(jobId);
  if (!job) return null;
  if (!isSuperAdmin && job.createdByUserId !== requesterUserId) return null;
  return toSnapshot(job);
}

export function findActiveSyncAllJobForUser(userId: string): SyncAllJobSnapshot | null {
  pruneOldJobs();
  for (const job of jobs.values()) {
    if (
      job.createdByUserId === userId &&
      (job.status === "queued" || job.status === "running")
    ) {
      return toSnapshot(job);
    }
  }
  return null;
}

/**
 * Create a job from a pre-fetched (RLS-scoped) order list and kick off the worker.
 * Returns immediately; caller should respond 202.
 */
export function startSyncAllJob(
  createdByUserId: string,
  orders: SyncableOrder[],
): SyncAllJobSnapshot {
  pruneOldJobs();

  const job: SyncAllJobInternal = {
    id: randomUUID(),
    createdByUserId,
    status: orders.length === 0 ? "completed" : "queued",
    total: orders.length,
    completed: 0,
    synced: 0,
    failed: 0,
    newEvents: 0,
    orders: [],
    createdAt: Date.now(),
    finishedAt: orders.length === 0 ? Date.now() : undefined,
  };
  jobs.set(job.id, job);

  if (orders.length > 0) {
    // Fire-and-forget — errors are recorded on the job, never thrown to the request.
    void runSyncAllJob(job, orders);
  }

  return toSnapshot(job);
}

async function runSyncAllJob(job: SyncAllJobInternal, orders: SyncableOrder[]): Promise<void> {
  job.status = "running";
  try {
    await mapPool(orders, SYNC_ALL_CONCURRENCY, async (order) => {
      let row: SyncAllJobOrderResult & { failed: boolean };
      try {
        const sync = await syncOrder(order.id);
        const newEvents = sync.newEvents ?? 0;
        const legs = sync.legs ?? [];
        // not_found = no scans yet — successful poll, not a failure.
        const failed =
          sync.status === "error" ||
          sync.status === "no_legs" ||
          (legs.length > 0 && legs.every((l) => l.status === "error"));
        const legLines = legs.map((l) => l.userMessage).filter((m): m is string => !!m);
        row = {
          publicId: order.publicId,
          trackingCode: order.trackingCode,
          status: sync.status,
          newEvents,
          failed,
          userMessages: legLines,
        };
      } catch {
        row = {
          publicId: order.publicId,
          trackingCode: order.trackingCode,
          status: "error",
          newEvents: 0,
          failed: true,
          userMessages: ["Tracking is temporarily unavailable"],
        };
      }

      job.completed += 1;
      job.newEvents += row.newEvents;
      if (row.failed) job.failed += 1;
      else job.synced += 1;
      const { failed: _f, ...publicRow } = row;
      job.orders.push(publicRow);
      return row;
    });

    job.status = "completed";
    job.finishedAt = Date.now();
  } catch (e) {
    job.status = "failed";
    job.error = e instanceof Error ? e.message : String(e);
    job.finishedAt = Date.now();
  }
}
