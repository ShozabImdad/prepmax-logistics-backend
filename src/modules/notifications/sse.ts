// Server-Sent Events hub for live in-app notifications (plan §9).
//
// Admins/managers open an SSE connection (GET /api/notifications/stream). When
// a notification is created for their branch, we push it to their open
// connection(s) instantly — no polling. Connections are grouped by branch so a
// push only reaches the right branch's staff.

import type { Response } from "express";

interface Client {
  branchId: string;
  userId: string;
  res: Response;
}

const clients = new Set<Client>();

export function addSseClient(branchId: string, userId: string, res: Response): () => void {
  const client: Client = { branchId, userId, res };
  clients.add(client);
  // initial comment to open the stream
  res.write(": connected\n\n");
  return () => clients.delete(client);
}

/** Push an event to every connected client in a branch. */
export function pushToBranch(branchId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.branchId === branchId) {
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
