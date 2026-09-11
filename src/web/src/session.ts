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
};
export type Session = {
  getState(): SessionState; subscribe(fn: () => void): () => void;
  load(): Promise<void>; join(name: string): Promise<void>; selectThread(id: string): void;
  post(text: string): Promise<void>; createThread(name: string): Promise<void>; closeThread(id: string): Promise<void>; archive(): Promise<void>;
  canModerate(): boolean; dispose(): void;
};

const PAGE = 1000;

export function createSession(opts: { client: LoomClient; secret: string; storage: KeyValueStorage }): Session {
  const { client, secret, storage } = opts;
  const key = `loom:${secret}`;
  let state: SessionState = { status: "loading", threads: [], participants: [], events: [], connection: "closed", needsName: false };
  const listeners = new Set<() => void>();
  let weaveId: string | undefined;
  let stream: StreamHandle | undefined;
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
  // with backoff instead of being dropped, and events that arrive while a refresh is already in
  // flight just mark it dirty so exactly one more refresh runs after the current one settles.
  let disposed = false;
  let refreshInFlight: Promise<void> | undefined;
  let refreshDirty = false;
  const RETRY_DELAYS_MS = [250, 500, 1000, 1000]; // 1 initial attempt + up to 4 retries = 5 attempts

  const runRefreshWithRetry = async () => {
    for (let attempt = 0; ; attempt++) {
      if (disposed) return;
      try {
        await refreshInfo();
        return;
      } catch {
        if (disposed || attempt >= RETRY_DELAYS_MS.length) return;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
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
      try {
        weaveId = await reader.lookupWeave(secret);
        const info = await reader.getWeave(weaveId);
        const events: LoomEvent[] = [];
        let since = 0;
        for (;;) {
          const page = await reader.readEvents(weaveId, { since, limit: PAGE });
          events.push(...page);
          if (page.length < PAGE) break;
          since = page.at(-1)!.seq;
        }
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
        stream = reader.stream(weaveId, {
          since: events.at(-1)?.seq ?? 0,
          onEvent,
          onStatus: (st) => set({ connection: st }),
        });
      } catch (e) {
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
    dispose: () => { disposed = true; stream?.close(); stream = undefined; listeners.clear(); },
  };
}
