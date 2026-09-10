import { serve, type ServerType } from "@hono/node-server";
import { createCore, type Core } from "@loom/core";
import { freshDb, closeTestDb } from "../../core/test/helpers.js";
import { buildApp } from "../src/app.js";
import { TicketStore } from "../src/tickets.js";
import { attachWebSocket } from "../src/ws.js";

export type TestServerOpts = {
  beforeReplay?: () => Promise<void>;
  pingIntervalMs?: number;
  replayPageSize?: number;
};

export async function startTestServer(opts: TestServerOpts = {}) {
  const core = createCore(await freshDb());
  const tickets = new TicketStore();
  const app = buildApp({ core, tickets });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  attachWebSocket(server, {
    core, tickets,
    beforeReplay: opts.beforeReplay,
    pingIntervalMs: opts.pingIntervalMs,
    replayPageSize: opts.replayPageSize,
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    core, tickets,
    close: async () => {
      tickets.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await closeTestDb();
    },
  };
}

export async function api(baseUrl: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json: json as any, text };
}
