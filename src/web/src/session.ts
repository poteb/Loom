import { LoomClient, LoomClientError, type LoomEvent, type Participant, type StreamHandle, type Thread, type Weave } from "@loom/client";
import type { KeyValueStorage } from "./storage.js";

export type Connection = "connecting" | "open" | "reconnecting" | "closed";
export type SessionState = {
  status: "loading" | "ready" | "error"; error?: string;
  weave?: Weave; threads: Thread[]; participants: Participant[];
  events: LoomEvent[];
  me?: { participant: Participant; token: string };
  currentThreadId?: string;
  connection: Connection;
  needsName: boolean;
  refreshError?: string;
};
export type Session = {
  getState(): SessionState; subscribe(fn: () => void): () => void;
  load(): Promise<void>; join(name: string): Promise<void>; selectThread(id: string): void;
  post(text: string): Promise<void>; createThread(name: string): Promise<void>; closeThread(id: string): Promise<void>; archive(): Promise<void>;
  canModerate(): boolean; dismissNamePrompt(): void; dispose(): void;
};

const PAGE = 1000;

/** setTimeout that settles early — and clears its timer — when `signal` aborts, so no timer outlives a session. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type RetryOptions = { delaysMs: number[]; slowMs: number };
const DEFAULT_RETRY: RetryOptions = { delaysMs: [250, 500, 1000, 2000, 4000], slowMs: 10_000 };

export function createSession(opts: { client: LoomClient; secret: string; storage: KeyValueStorage; retry?: RetryOptions }): Session {
  const { client, secret, storage } = opts;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const key = `loom:${secret}`;
  let state: SessionState = { status: "loading", threads: [], participants: [], events: [], connection: "closed", needsName: false };
  const listeners = new Set<() => void>();
  let weaveId: string | undefined;
  let stream: StreamHandle | undefined;
  let generation = 0;
  const reader = client.withToken(secret);

  const set = (patch: Partial<SessionState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
  const writer = (): LoomClient => {
    if (!state.me) { set({ needsName: true }); throw new LoomClientError("no_identity", "Choose a name to take part"); }
    return client.withToken(state.me.token);
  };
  const refreshInfo = async () => {
    if (!weaveId) return;
    const info = await reader.getWeave(weaveId);
    set({ weave: info.weave, threads: info.threads, participants: info.participants,
      me: state.me && info.participants.some((p) => p.id === state.me!.participant.id)
        ? { token: state.me.token, participant: info.participants.find((p) => p.id === state.me!.participant.id)! }
        : state.me });
  };

  // Coalesced, retried refresh for events that arrive off the wire: a failed refresh is retried
  // with backoff, then — rather than being abandoned — falls back to a slow indefinite cadence
  // until it succeeds or the session is disposed. Events that arrive while a refresh is already
  // in flight just mark it dirty so exactly one more refresh runs after the current one settles.
  let disposed = false;
  let refreshInFlight: Promise<void> | undefined;
  let refreshDirty = false;
  // Aborted by dispose(): cancels the retry sleep so a long backoff never keeps the process (or a
  // test run) alive past the session it belongs to.
  const lifetime = new AbortController();

  const runRefreshWithRetry = async () => {
    for (let attempt = 0; ; attempt++) {
      if (disposed) return;
      try {
        await refreshInfo();
        if (state.refreshError !== undefined) set({ refreshError: undefined });
        return;
      } catch (e) {
        if (disposed) return;
        set({ refreshError: e instanceof Error ? e.message : String(e) });
        const delay = attempt < retry.delaysMs.length ? retry.delaysMs[attempt]! : retry.slowMs;
        await sleep(delay, lifetime.signal);
      }
    }
  };
  const scheduleRefresh = () => {
    if (disposed) return;
    if (refreshInFlight) { refreshDirty = true; return; }
    refreshInFlight = runRefreshWithRetry().finally(() => {
      refreshInFlight = undefined;
      if (refreshDirty && !disposed) { refreshDirty = false; scheduleRefresh(); }
    });
  };

  const onEvent = (e: LoomEvent) => {
    if (state.events.some((x) => x.seq === e.seq)) return;
    const events = [...state.events, e].sort((a, b) => a.seq - b.seq);
    set({ events });
    if (e.type === "thread.created" || e.type === "thread.closed" || e.type === "participant.joined" || e.type === "participant.role_changed") {
      scheduleRefresh();
    } else if (e.type === "weave.archived" && state.weave) {
      set({ weave: { ...state.weave, archivedAt: e.at } });
    }
  };

  return {
    getState: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },

    async load() {
      stream?.close();
      stream = undefined;
      generation++;
      const myGeneration = generation;
      // A load() that has been superseded (a newer load(), or dispose()) owns nothing any more: it
      // must not publish state and must clean up anything it managed to open. Checked after every
      // await, since each one is a chance for a newer load to have taken over.
      const stale = () => disposed || myGeneration !== generation;
      set({ status: "loading", error: undefined, refreshError: undefined });
      try {
        // Backfill events BEFORE fetching threads/participants metadata: anything committed after
        // the backfill starts arrives live over the stream (started from the last backfilled seq)
        // and triggers the normal refresh. Fetching metadata first would let a thread/participant
        // change land in `events` (via the stream) without ever showing up in `threads`/
        // `participants`, since the stream only starts listening after that seq.
        const id = await reader.lookupWeave(secret);
        if (stale()) return;
        const events: LoomEvent[] = [];
        let since = 0;
        for (;;) {
          const page = await reader.readEvents(id, { since, limit: PAGE });
          if (stale()) return;
          events.push(...page);
          if (page.length < PAGE) break;
          since = page.at(-1)!.seq;
        }
        const info = await reader.getWeave(id);
        if (stale()) return;
        weaveId = id;
        let me: SessionState["me"];
        const stored = storage.get(key);
        if (stored) {
          try {
            const { token, participantId } = JSON.parse(stored) as { token: string; participantId: string };
            const p = info.participants.find((x) => x.id === participantId);
            if (p && token) me = { token, participant: p };
          } catch { storage.remove(key); }
        }
        set({ status: "ready", weave: info.weave, threads: info.threads, participants: info.participants, events, me,
          currentThreadId: info.threads.find((t) => t.isGeneral)?.id ?? info.threads[0]?.id });
        let sawOpen = false;
        const opened = reader.stream(id, {
          since: events.at(-1)?.seq ?? 0,
          onEvent: (e) => { if (stale()) return; onEvent(e); },
          onStatus: (st) => {
            if (stale()) return;
            set({ connection: st });
            // A reconnect's "open" (as opposed to the first "open" after this load()) means the
            // stream was down for a while; refresh derived state in case a qualifying event was
            // missed while disconnected.
            if (st === "open") {
              if (sawOpen) scheduleRefresh(); else sawOpen = true;
            }
          },
        });
        // stream() is synchronous, but the state it was built from is not: if this load lost the
        // race while it was being constructed, close the socket instead of leaking it.
        if (stale()) { opened.close(); return; }
        stream = opened;
      } catch (e) {
        if (stale()) return;
        const msg = e instanceof LoomClientError && e.code === "weave_not_found" ? "Weave not found: the link may be wrong" : (e as Error).message;
        set({ status: "error", error: msg });
      }
    },

    async join(name) {
      const j = await client.joinWeave(secret, { name, kind: "human" });
      storage.set(key, JSON.stringify({ token: j.token, participantId: j.participant.id }));
      set({ me: { token: j.token, participant: j.participant }, needsName: false });
      await refreshInfo();
    },

    selectThread: (id) => set({ currentThreadId: id }),

    async post(text) {
      const w = writer();
      const threadId = state.currentThreadId;
      if (!threadId) throw new LoomClientError("validation", "No thread selected");
      onEvent(await w.postMessage(threadId, text));
    },
    async createThread(name) {
      const w = writer();
      if (!weaveId) throw new LoomClientError("validation", "Weave not loaded");
      const t = await w.createThread(weaveId, name);
      set({ threads: state.threads.some((x) => x.id === t.id) ? state.threads : [...state.threads, t], currentThreadId: t.id });
    },
    async closeThread(id) {
      await writer().closeThread(id);
      await refreshInfo();
    },
    async archive() {
      const w = writer();
      if (!weaveId) throw new LoomClientError("validation", "Weave not loaded");
      await w.archiveWeave(weaveId);
      await refreshInfo();
    },
    canModerate: () => state.me?.participant.role === "keeper" && !state.weave?.archivedAt,
    dismissNamePrompt: () => { if (state.needsName) set({ needsName: false }); },
    dispose: () => {
      disposed = true;
      // Bumping the generation retires any in-flight load() as well, so one that is still mid-fetch
      // cleans up whatever it opens instead of publishing state into a disposed session.
      generation++;
      lifetime.abort();
      stream?.close();
      stream = undefined;
      listeners.clear();
    },
  };
}
