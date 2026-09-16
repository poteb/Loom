import { serve, type ServerType } from "@hono/node-server";
import { createCore, type Core } from "@loom/core";
import { freshDb, closeTestDb } from "../../core/test/helpers.js";

export { keeperToken } from "../../core/test/helpers.js";
import { buildApp } from "../src/app.js";
import { TicketStore } from "../src/tickets.js";
import { attachWebSocket } from "../src/ws.js";

export type TestServerOpts = {
  beforeReplay?: () => Promise<void>;
  afterReplay?: () => Promise<void>;
  pingIntervalMs?: number;
  replayPageSize?: number;
  authTtlMs?: number;
  /** How often the server sweeps crossed requests; the app's default (a minute) when omitted. */
  requestSweepMs?: number;
};

/** Spelled out because the inferred type would reach into @loom/core's internal dist paths. */
export type TestServer = {
  baseUrl: string;
  wsUrl: string;
  core: Core;
  tickets: TicketStore;
  /** Sweeps crossed requests now, rather than waiting for the interval. */
  sweepNow: (now?: Date) => Promise<number>;
  close: () => Promise<void>;
  dropSockets: () => void;
};

export async function startTestServer(opts: TestServerOpts = {}): Promise<TestServer> {
  const core = createCore(await freshDb());
  const tickets = new TicketStore();
  const { app, sweepNow, stop: stopSweep } = buildApp({ core, tickets, requestSweepMs: opts.requestSweepMs });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const sockets = attachWebSocket(server, {
    core, tickets,
    beforeReplay: opts.beforeReplay,
    afterReplay: opts.afterReplay,
    pingIntervalMs: opts.pingIntervalMs,
    replayPageSize: opts.replayPageSize,
    authTtlMs: opts.authTtlMs,
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    core, tickets, sweepNow,
    close: async () => {
      tickets.stop();
      stopSweep();
      await new Promise<void>((r) => server.close(() => r()));
      await closeTestDb();
    },
    dropSockets: () => sockets.dropAll(),
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
