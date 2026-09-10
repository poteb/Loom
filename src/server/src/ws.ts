import type { ServerType } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { assertCanRead, LoomError, type Actor, type Core, type LoomEvent } from "@loom/core";
import { statusFor } from "./errors.js";
import type { TicketStore } from "./tickets.js";

export type WsDeps = { core: Core; tickets: TicketStore; beforeReplay?: () => Promise<void> };

const PATH_RE = /^\/api\/weaves\/([^/]+)\/stream$/;
const PAGE = 500;
const PING_MS = 30_000;

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachWebSocket(server: ServerType, deps: WsDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = PATH_RE.exec(url.pathname);
      if (!m) return reject(socket, 404, "Not Found");
      const weaveId = m[1]!;
      const since = Number(url.searchParams.get("since") ?? "0");
      if (!Number.isInteger(since) || since < 0) return reject(socket, 400, "Bad Request");
      const credential = deps.tickets.redeem(url.searchParams.get("ticket") ?? "");
      if (!credential) return reject(socket, 401, "Unauthorized");
      const actor = await deps.core.resolveCredential(credential);
      assertCanRead(actor, weaveId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        void stream(ws, weaveId, since, actor, deps);
      });
    } catch (e) {
      if (e instanceof LoomError) return reject(socket, statusFor(e.code), e.code);
      console.error("ws upgrade failed", e);
      return reject(socket, 500, "Internal Server Error");
    }
  });
}

async function stream(ws: WebSocket, weaveId: string, since: number, actor: Actor, deps: WsDeps) {
  const send = (e: LoomEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };
  let lastSent = since;
  let live = false;
  const buffer: LoomEvent[] = [];

  // 1. Subscribe first so nothing committed from now on can be missed.
  const unsubscribe = deps.core.bus.subscribe(weaveId, (e) => {
    if (live) { if (e.seq > lastSent) { lastSent = e.seq; send(e); } }
    else buffer.push(e);
  });
  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, PING_MS);
  ws.on("close", () => { unsubscribe(); clearInterval(ping); });

  try {
    if (deps.beforeReplay) await deps.beforeReplay();
    // 2. Replay from the database.
    for (;;) {
      const page = await deps.core.readEvents(actor, weaveId, { since: lastSent, limit: PAGE });
      for (const e of page) { lastSent = e.seq; send(e); }
      if (page.length < PAGE) break;
    }
    // 3. Flush what arrived during replay, dropping anything already sent.
    buffer.sort((a, b) => a.seq - b.seq);
    for (const e of buffer) if (e.seq > lastSent) { lastSent = e.seq; send(e); }
    buffer.length = 0;
    // 4. Live.
    live = true;
  } catch (e) {
    console.error("ws stream failed", e);
    ws.close(1011, "stream failed");
  }
}
