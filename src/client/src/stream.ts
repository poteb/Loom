import type { LoomClient } from "./client.js";
import { LoomClientError } from "./errors.js";
import { toWsUrl } from "./url.js";
import type { LoomEvent } from "./types.js";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";
export type StreamOptions = {
  since?: number;
  onEvent: (e: LoomEvent) => void;
  onStatus?: (status: StreamStatus, detail?: { error?: LoomClientError; attempt?: number }) => void;
  reconnect?: boolean;
  backoffMs?: { initial: number; max: number };
  WebSocketImpl?: typeof WebSocket;
};
export type StreamHandle = { close(): void; readonly lastSeq: number };

const FATAL = new Set(["invalid_token", "forbidden", "weave_not_found", "insecure_url"]);

export function openStream(client: LoomClient, weaveId: string, opts: StreamOptions): StreamHandle {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  if (!WS) throw new LoomClientError("bad_response", "No WebSocket implementation available");
  const backoff = opts.backoffMs ?? { initial: 500, max: 10_000 };
  const reconnect = opts.reconnect ?? true;
  let lastSeq = opts.since ?? 0;
  let closedByUser = false;
  let socket: WebSocket | undefined;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = (st: StreamStatus, detail?: { error?: LoomClientError; attempt?: number }) => opts.onStatus?.(st, detail);
  // "closed" is terminal: a stream reports it at most once, whatever races to end it (a second
  // close(), a socket close event, or a ticket request that only fails after close()).
  let closedReported = false;
  const reportClosed = (detail?: { error?: LoomClientError }) => {
    if (closedReported) return;
    closedReported = true;
    status("closed", detail);
  };

  const scheduleReconnect = () => {
    if (closedByUser) return;
    if (!reconnect) { reportClosed(); return; }
    attempt += 1;
    const delay = Math.min(backoff.max, backoff.initial * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
    status("reconnecting", { attempt });
    timer = setTimeout(() => { void connect(); }, delay);
  };

  const connect = async () => {
    if (closedByUser) return;
    status("connecting", { attempt });
    let ticket: string;
    try {
      ticket = await client.wsTicket();
    } catch (e) {
      // A request that only fails after close() describes a stream nobody is listening to any
      // more: close() already reported the terminal "closed", so say nothing at all here.
      if (closedByUser) return;
      const err = e instanceof LoomClientError ? e : new LoomClientError("network", String(e));
      if (FATAL.has(err.code)) { reportClosed({ error: err }); return; }
      scheduleReconnect();
      return;
    }
    if (closedByUser) return;
    const url = `${toWsUrl(client.baseUrl)}/api/weaves/${weaveId}/stream?since=${lastSeq}&ticket=${encodeURIComponent(ticket)}`;
    // Some WebSocket implementations throw synchronously (a bad URL, an exhausted resource); treat
    // that exactly like a socket that closed before opening rather than letting it escape connect().
    let ws: WebSocket;
    try {
      ws = new WS(url);
    } catch (e) {
      if (closedByUser) return;
      if (!reconnect) {
        reportClosed({ error: new LoomClientError("network", `Could not open a WebSocket: ${e instanceof Error ? e.message : String(e)}`) });
        return;
      }
      scheduleReconnect();
      return;
    }
    socket = ws;
    let opened = false;
    ws.onopen = () => { opened = true; attempt = 0; status("open"); };
    ws.onmessage = (m) => {
      let e: LoomEvent;
      try { e = JSON.parse(typeof m.data === "string" ? m.data : String(m.data)) as LoomEvent; } catch { return; }
      if (typeof e.seq !== "number" || e.seq <= lastSeq) return;
      lastSeq = e.seq;
      opts.onEvent(e);
    };
    ws.onerror = () => { /* the close event follows; handled there */ };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = undefined;
      if (closedByUser) { reportClosed(); return; }
      if (opened) { scheduleReconnect(); return; }
      // A handshake rejection (never opened). A dead credential surfaces as a fatal wsTicket()
      // error on reconnect, but a *live* credential aimed at the wrong (or a nonexistent) Weave
      // keeps getting tickets and would retry forever; ask REST about the target to tell the two
      // apart and stop on a permanent answer.
      void (async () => {
        try {
          await client.getWeave(weaveId);
        } catch (e) {
          if (closedByUser) return;
          if (e instanceof LoomClientError && FATAL.has(e.code)) { reportClosed({ error: e }); return; }
        }
        if (closedByUser) return;
        scheduleReconnect();
      })();
    };
  };

  void connect();

  return {
    close() {
      closedByUser = true;
      if (timer) clearTimeout(timer);
      if (socket) { const ws = socket; socket = undefined; ws.close(); }
      reportClosed();
    },
    get lastSeq() { return lastSeq; },
  };
}
