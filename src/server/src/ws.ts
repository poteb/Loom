import type { ServerType } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { LoomError, type Actor, type Core, type LoomEvent } from "@loom/core";
import { statusFor } from "./errors.js";
import { logError } from "./log.js";
import type { TicketStore } from "./tickets.js";

export type WsDeps = {
  core: Core;
  tickets: TicketStore;
  beforeReplay?: () => Promise<void>;
  /** Test seam: runs once replay has finished, while the stream is still buffering (live === false). */
  afterReplay?: () => Promise<void>;
  /** WebSocket control-ping interval. */
  pingIntervalMs?: number;
  /** Events per replay page (and per gap-recovery read). */
  replayPageSize?: number;
};

const PATH_RE = /^\/api\/weaves\/([^/]+)\/stream$/;
const PAGE = 500;
const PING_MS = 30_000;

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error",
};
const STATUS_CODE: Record<number, string> = {
  400: "validation", 401: "invalid_token", 403: "forbidden", 404: "not_found", 500: "internal",
};

/** Rejects the handshake with the same JSON error shape the REST routes use. */
function reject(socket: Duplex, status: number, message: string, code = STATUS_CODE[status] ?? "internal") {
  const body = Buffer.from(JSON.stringify({ code, message }), "utf8");
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${body.length}\r\n` +
    "\r\n" + body.toString("utf8"),
  );
}

export function attachWebSocket(server: ServerType, deps: WsDeps): { dropAll: () => void } {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = PATH_RE.exec(url.pathname);
      if (!m) return reject(socket, 404, "No such route");
      const weaveId = m[1]!;
      const since = Number(url.searchParams.get("since") ?? "0");
      if (!Number.isInteger(since) || since < 0) return reject(socket, 400, "since must be a non-negative integer");
      const credential = deps.tickets.redeem(url.searchParams.get("ticket") ?? "");
      if (!credential) return reject(socket, 401, "Unknown or expired ticket");
      const actor = await deps.core.resolveCredential(credential);
      // Core decides: 403 when the credential is for another Weave, 404 when it does not exist.
      await deps.core.readEvents(actor, weaveId, { limit: 1 });
      wss.handleUpgrade(req, socket, head, (ws) => {
        void stream(ws, weaveId, since, actor, deps);
      });
    } catch (e) {
      if (e instanceof LoomError) return reject(socket, statusFor(e.code), e.message, e.code);
      logError("ws upgrade failed", e);
      return reject(socket, 500, "Internal error");
    }
  });

  return { dropAll: () => { for (const c of wss.clients) c.terminate(); } };
}

async function stream(ws: WebSocket, weaveId: string, since: number, actor: Actor, deps: WsDeps) {
  const page = deps.replayPageSize ?? PAGE;
  const send = (e: LoomEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };
  let lastSent = since;
  let live = false;
  const buffer: LoomEvent[] = [];
  // Live events are processed one at a time: filling a gap needs a database read, and a second
  // event must not overtake it.
  let chain: Promise<void> = Promise.resolve();

  const fail = (e: unknown) => { logError("ws stream failed", e); ws.close(1011, "stream failed"); };

  /** Sends `e`, first replaying anything between it and the last event we sent. */
  const deliver = async (e: LoomEvent): Promise<void> => {
    if (e.seq <= lastSent) return;
    while (e.seq > lastSent + 1) {
      const missing = await deps.core.readEvents(actor, weaveId, { since: lastSent, limit: Math.min(e.seq - lastSent - 1, page) });
      if (missing.length === 0) break;   // not committed yet; send what we have rather than spin
      for (const m of missing) if (m.seq > lastSent) { lastSent = m.seq; send(m); }
    }
    if (e.seq > lastSent) { lastSent = e.seq; send(e); }
  };

  // 1. Subscribe first so nothing committed from now on can be missed.
  const unsubscribe = deps.core.bus.subscribe(weaveId, (e) => {
    if (!live) { buffer.push(e); return; }
    chain = chain.then(() => deliver(e)).catch(fail);
  });
  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, deps.pingIntervalMs ?? PING_MS);
  ws.on("close", () => { unsubscribe(); clearInterval(ping); });

  try {
    if (deps.beforeReplay) await deps.beforeReplay();
    // 2. Replay from the database.
    for (;;) {
      const events = await deps.core.readEvents(actor, weaveId, { since: lastSent, limit: page });
      for (const e of events) { lastSent = e.seq; send(e); }
      if (events.length < page) break;
    }
    if (deps.afterReplay) await deps.afterReplay();
    // 3. Hand off: feed what arrived during replay through the same serialized, gap-recovering
    //    path the live phase uses. `bus.publish` is synchronous and nothing below awaits, so an
    //    event published from here on queues behind the buffered ones instead of racing them.
    buffer.sort((a, b) => a.seq - b.seq);
    for (const e of buffer) chain = chain.then(() => deliver(e)).catch(fail);
    buffer.length = 0;
    // 4. Live.
    live = true;
  } catch (e) {
    fail(e);
  }
}
