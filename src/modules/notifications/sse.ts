// Server-Sent Events hub for live in-app updates.
//
// Two kinds of clients, kept strictly separate:
//   - staff    (GET /api/notifications/stream): grouped by branch. branchId
//              null = super_admin, who receives every branch's events.
//   - customer (GET /api/portal/stream, plus the older per-feature streams):
//              grouped by customer id. A customer only ever receives events
//              addressed to them, never other customers' events in the same
//              branch.
//
// pushToBranch() reaches STAFF only. Customer-facing events must go through
// pushToCustomer().

import type { Request, Response } from "express";

type Client =
  | { kind: "staff"; branchId: string | null; userId: string; res: Response }
  | { kind: "customer"; branchId: string; customerId: string; res: Response };

const clients = new Set<Client>();

function register(client: Client): () => void {
  clients.add(client);
  // initial comment to open the stream
  client.res.write(": connected\n\n");
  return () => clients.delete(client);
}

export function addStaffSseClient(branchId: string | null, userId: string, res: Response): () => void {
  return register({ kind: "staff", branchId, userId, res });
}

export function addCustomerSseClient(branchId: string, customerId: string, res: Response): () => void {
  return register({ kind: "customer", branchId, customerId, res });
}

function send(c: Client, payload: string): void {
  try {
    c.res.write(payload);
  } catch {
    clients.delete(c);
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Push to every connected STAFF client of a branch, plus all-branches (super_admin) clients. */
export function pushToBranch(branchId: string, event: string, data: unknown): void {
  const payload = frame(event, data);
  for (const c of clients) {
    if (c.kind === "staff" && (c.branchId === branchId || c.branchId === null)) send(c, payload);
  }
}

/** Push to every connected stream of ONE customer (all their tabs/streams). */
export function pushToCustomer(customerId: string | null | undefined, event: string, data: unknown): void {
  if (!customerId) return;
  const payload = frame(event, data);
  for (const c of clients) {
    if (c.kind === "customer" && c.customerId === customerId) send(c, payload);
  }
}

/**
 * Set SSE headers, register the client and start the keep-alive heartbeat.
 * Cleans up when the connection closes.
 */
export function openSseStream(req: Request, res: Response, add: () => () => void): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // stop nginx-style proxies buffering the stream
  res.flushHeaders?.();

  const remove = add();
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    remove();
  });
}

export function sseClientCount(): number {
  return clients.size;
}
