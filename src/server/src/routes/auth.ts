import { Hono } from "hono";
import type { Core } from "@loom/core";
import { requireActor, type Env } from "../auth.js";
import type { TicketStore } from "../tickets.js";

export const TICKET_TTL_MS = 60_000;

export function authRoutes(core: Core, tickets: TicketStore) {
  const r = new Hono<Env>();
  r.post("/ws-ticket", async (c) => {
    await requireActor(c, core);               // validates the credential
    const ticket = tickets.issue(c.get("credential")!);
    return c.json({ ticket, expiresInMs: TICKET_TTL_MS });
  });
  return r;
}
