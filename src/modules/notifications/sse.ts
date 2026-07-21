// Server-Sent Events hub for live in-app notifications (plan §9).
//
// Admins/managers open an SSE connection (GET /api/notifications/stream). When
// a notification is created for their branch, we push it to their open
// connection(s) instantly — no polling. Connections are grouped by branch so a
// push only reaches the right branch's staff.
//
// branchId === null means "subscribe to every branch" — used by super_admin,
// who doesn't belong to a single branch but still needs live updates.

import type { Response } from "express";

interface Client {
  branchId: string | null; // null = super_admin, sees every branch's events
  userId: string;
  res: Response;
}

const clients = new Set<Client>();

export function addSseClient(branchId: string | null, userId: string, res: Response): () => void {
  const client: Client = { branchId, userId, res };
  clients.add(client);
  // initial comment to open the stream
  res.write(": connected\n\n");
  return () => clients.delete(client);
}

/** Push an event to every connected client in a branch, plus any all-branches (super_admin) clients. */
export function pushToBranch(branchId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.branchId === branchId || c.branchId === null) {
      try {
        c.res.write(payload);
      } catch {
        clients.delete(c);
      }
    }
  }
}

export function sseClientCount(): number {
  return clients.size;
}