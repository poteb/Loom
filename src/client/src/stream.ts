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

  const scheduleReconnect = () => {
    if (closedByUser) return;
    if (!reconnect) { status("closed"); return; }
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
      const err = e instanceof LoomClientError ? e : new LoomClientError("network", String(e));
      if (FATAL.has(err.code) || closedByUser) { status("closed", { error: err }); return; }
      scheduleReconnect();
      return;
    }
    if (closedByUser) return;
    const url = `${toWsUrl(client.baseUrl)}/api/weaves/${weaveId}/stream?since=${lastSeq}&ticket=${encodeURIComponent(ticket)}`;
    const ws = new WS(url);
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
      if (closedByUser) { status("closed"); return; }
      // A handshake rejection (never opened) is most likely a credential problem; re-fetching the
      // ticket on reconnect surfaces it as a fatal error from wsTicket() if the credential is dead.
      void opened;
      scheduleReconnect();
    };
  };

  void connect();

  return {
    close() {
      closedByUser = true;
      if (timer) clearTimeout(timer);
      if (socket) { const ws = socket; socket = undefined; ws.close(); status("closed"); }
      else status("closed");
    },
    get lastSeq() { return lastSeq; },
  };
}
