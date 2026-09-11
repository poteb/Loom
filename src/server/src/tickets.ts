import { randomBytes } from "node:crypto";

/** Single-use, short-lived tickets that carry a bearer credential into the WebSocket handshake. */
export class TicketStore {
  private tickets = new Map<string, { credential: string; expires: number }>();
  private timer: NodeJS.Timeout;

  constructor(private ttlMs = 60_000) {
    this.timer = setInterval(() => this.sweep(), Math.max(1000, ttlMs));
    this.timer.unref();
  }

  issue(credential: string): string {
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { credential, expires: Date.now() + this.ttlMs });
    return ticket;
  }

  redeem(ticket: string): string | undefined {
    const entry = this.tickets.get(ticket);
    if (!entry) return undefined;
    this.tickets.delete(ticket);
    return entry.expires >= Date.now() ? entry.credential : undefined;
  }

  size(): number { this.sweep(); return this.tickets.size; }
  stop(): void { clearInterval(this.timer); }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
  }
}
