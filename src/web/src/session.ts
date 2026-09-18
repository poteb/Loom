import { LoomClient, LoomClientError, type Lobby, type LoomEvent, type LoomRequest, type OpenRequestInput,
  type Participant, type StreamHandle, type Thread, type Weave } from "@loom/client";
import type { KeyValueStorage, WriteResult } from "./storage.js";
import { storedWeaves } from "./weaves-store.js";
import { applyEvent, applySnapshot, isRequestEvent, type Requests } from "./requests-state.js";

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
  /** The instance layer of the guidelines; the Weave's own layer is `weave.guidelines`. */
  instanceGuidelines: string;
  /** Thread ids with an invite to me newer than the last seq I had read there. */
  invitesForMe: Set<string>;
  /** Everyone invited to each thread, so the invite list can show who is already in. */
  invited: Record<string, Set<string>>;
  /** Where the instance's Lobby is; the requests panel belongs to that Weave's page alone. */
  lobby?: Lobby;
  /** The Lobby's requests, each at the version this session holds for it. Empty off the Lobby. */
  requests: Requests;
  /** Whether a request read has actually come back. False means "not known yet", never "empty". */
  requestsLoaded: boolean;
  /** Why the last request read failed, while a retry is pending. Cleared by the first success. */
  requestsError?: string;
  /** How many closed requests per terminal status this session loads; the panel says so when the
   *  closed section may be a page rather than the whole history. */
  closedRequestsPage: number;
};

/** A Weave this browser holds a token for: what an Open-request form's target pickers offer. */
export type TargetWeave = { weaveId: string; title: string; token: string; threads: { id: string; name: string }[] };

export type Session = {
  getState(): SessionState; subscribe(fn: () => void): () => void;
  load(): Promise<void>; join(name: string): Promise<void>; selectThread(id: string): void;
  post(text: string): Promise<void>; createThread(name: string, url?: string | null): Promise<void>;
  setThreadUrl(id: string, url: string | null): Promise<void>; invite(threadId: string, participantId: string): Promise<void>;
  closeThread(id: string): Promise<void>; archive(): Promise<void>; setGuidelines(text: string): Promise<void>;
  canModerate(): boolean; canEditThread(t: Thread): boolean; markSeen(id: string): void;
  dismissNamePrompt(): void; dispose(): void;
  // --- Lobby requests. Thin wrappers: each applies the snapshot it gets back through the watermark.
  openRequest(input: OpenRequestInput): Promise<LoomRequest>;
  offer(requestId: string, input: { model?: string; effort?: string; note?: string }): Promise<void>;
  accept(requestId: string, participantIds: string[]): Promise<void>;
  cancel(requestId: string): Promise<void>;
  targets(): Promise<TargetWeave[]>;
};

/** The server's own page maximum (`MAX_PAGE_LIMIT`): what "everything" is asked for as. */
const PAGE = 1000;

/**
 * How many closed requests the panel loads **per terminal status**. Open requests are never capped
 * in intent, so they are read on their own at `PAGE`; the closed ones are history, and a browser
 * wants the recent end of it, not all of it.
 */
export const CLOSED_REQUESTS_PAGE = 25;
const CLOSED_STATUSES = ["filled", "expired", "cancelled"] as const;

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

export function createSession(opts: { client: LoomClient; secret: string; storage: KeyValueStorage; retry?: RetryOptions;
  /** Told the verdict of every entry write this session makes, so the page can raise the one-time
   *  "storage is not persisting" notice of §6 for a credential that only reached memory. */
  onWrite?: (r: WriteResult) => void;
  /** Override for `CLOSED_REQUESTS_PAGE`; a knob, and the seam a test uses to fill the page cheaply. */
  closedRequestsPage?: number }): Session {
  const { client, secret, storage, onWrite } = opts;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const closedPage = opts.closedRequestsPage ?? CLOSED_REQUESTS_PAGE;
  const key = `loom:${secret}`;
  let state: SessionState = { status: "loading", threads: [], participants: [], events: [], connection: "closed", needsName: false,
    invitesForMe: new Set(), invited: {}, instanceGuidelines: "", requests: {}, requestsLoaded: false, closedRequestsPage: closedPage };
  const listeners = new Set<() => void>();
  let weaveId: string | undefined;
  // How far the guidelines text in `state.weave` has been advanced, as a Weave seq. Guidelines are
  // not one-way (they change repeatedly and can be cleared), so the archive trick of "keep whichever
  // saw it" cannot be used: only the seq decides. A snapshot is applied when its `lastSeq` is at
  // least the watermark, an event when its seq is past it, and either one that wins moves it up.
  let guidelinesSeq = 0;
  let stream: StreamHandle | undefined;
  let generation = 0;
  const reader = client.withToken(secret);

  const set = (patch: Partial<SessionState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };

  /** Derived from the log: who has been invited where, and which of those invites target me and are unopened. */
  const deriveInvites = (events: LoomEvent[], meId: string | undefined, seen: Map<string, number>) => {
    const invited: Record<string, Set<string>> = {};
    const forMe = new Set<string>();
    for (const e of events) {
      if (e.type !== "thread.invited") continue;
      const pid = String(e.payload.participantId ?? "");
      (invited[e.threadId] ??= new Set()).add(pid);
      if (meId && pid === meId && e.seq > (seen.get(e.threadId) ?? 0)) forMe.add(e.threadId);
    }
    return { invited, invitesForMe: forMe };
  };
  // How far this session has read each thread: the highest seq in the log at the moment the thread
  // was opened (or explicitly marked seen). An invite counts as unread when it is newer than that —
  // visiting a thread must not acknowledge invites that have not happened yet.
  const seenUpTo = new Map<string, number>();
  const maxSeq = (events: LoomEvent[]) => events.at(-1)?.seq ?? 0;
  const markThreadSeen = (id: string) => { seenUpTo.set(id, maxSeq(state.events)); };

  const writer = (): LoomClient => {
    if (!state.me) { set({ needsName: true }); throw new LoomClientError("no_identity", "Choose a name to take part"); }
    return client.withToken(state.me.token);
  };
  /** True on the Lobby's own page: requests are read with this browser's Lobby credential. */
  const onLobby = () => !!weaveId && state.lobby?.weaveId === weaveId;
  /**
   * Every open request, plus the newest `closedPage` of each terminal status.
   *
   * Not one `listRequests()`: that is a page of the whole board, newest first, and an open request
   * older than the newest hundred rows would simply be missing from the panel's live section. Open
   * and closed are therefore asked for separately, and the closed history is capped on purpose. The
   * pages are merged through `applySnapshot` like any other snapshot, so two sources are no
   * different from one.
   */
  const readRequests = async (): Promise<LoomRequest[]> => {
    const pages = await Promise.all([
      reader.listRequests("open", { limit: PAGE }),
      ...CLOSED_STATUSES.map((s) => reader.listRequests(s, { limit: closedPage })),
    ]);
    return pages.flat();
  };

  /** Every snapshot goes through the watermark, so a stale answer can never move a request back. */
  const applyRequests = (snaps: LoomRequest[]) => {
    let next = state.requests;
    for (const snap of snaps) next = applySnapshot(next, snap);
    if (next !== state.requests) set({ requests: next });
  };

  const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /**
   * Where the Lobby is, and whether that is now known.
   *
   * `weave_not_found` is the instance's own answer — it has no Lobby — and settles the question.
   * Every other failure is a failed read: taken for "no Lobby" it would hide the requests panel and
   * the profile cards for the life of the page, because both gate on `state.lobby` and nothing else
   * ever asks again.
   */
  const discoverLobby = async (): Promise<{ lobby?: Lobby; settled: boolean; error?: string }> => {
    try { return { lobby: await client.getLobby(), settled: true }; }
    catch (e) {
      if (e instanceof LoomClientError && e.code === "weave_not_found") return { settled: true };
      return { settled: false, error: messageOf(e) };
    }
  };
  /** False until a `getLobby()` has answered for this load; `state.lobby` means nothing before that. */
  let lobbyKnown = false;

  const refreshInfo = async () => {
    if (!weaveId) return;
    // Neither the instance text nor the requests are part of the Weave, so a failure to read either
    // must not fail the refresh the rest of the UI depends on. The instance text falls back to what
    // is on screen; the requests keep what is held, record the failure and get their own retry —
    // there is no later event that would bring a missed request in.
    const myGeneration = generation;
    const [info, instance, requests] = await Promise.all([
      reader.getWeave(weaveId),
      client.getInstanceGuidelines().catch(() => state.instanceGuidelines),
      onLobby() ? readRequests().then((rs) => ({ rs }), (e: unknown) => ({ error: messageOf(e) })) : null,
    ]);
    // A snapshot that predates the last applied guidelines change keeps the text that change
    // delivered; one that is at least as new is authoritative and moves the watermark up.
    const accept = info.weave.lastSeq >= guidelinesSeq;
    if (accept) guidelinesSeq = info.weave.lastSeq;
    // A refresh can be in flight when the archive commits, and then answer from before it: archive
    // state is one-way, so keep whichever of the two saw it. Without this the composer and the
    // keeper controls come back on a Weave that is already read-only.
    set({ weave: { ...info.weave, archivedAt: info.weave.archivedAt ?? state.weave?.archivedAt ?? null,
        guidelines: accept ? info.weave.guidelines : (state.weave?.guidelines ?? info.weave.guidelines) },
      instanceGuidelines: instance,
      threads: info.threads, participants: info.participants,
      me: state.me && info.participants.some((p) => p.id === state.me!.participant.id)
        ? { token: state.me.token, participant: info.participants.find((p) => p.id === state.me!.participant.id)! }
        : state.me });
    if (requests && "rs" in requests) {
      applyRequests(requests.rs);
      if (state.requestsError !== undefined || !state.requestsLoaded) set({ requestsLoaded: true, requestsError: undefined });
    } else if (requests) {
      set({ requestsError: requests.error });
      retryLobbyData(myGeneration);
    }
    // `onLobby()` is false while the pointer is unknown, so a refresh in that state reads no
    // requests and — deliberately — cannot report the board as loaded. Nudging the loop here costs
    // nothing (it returns at once when one is already running for this generation) and means a
    // page whose discovery failed converges even if its loop were somehow never started.
    if (!lobbyKnown) retryLobbyData(myGeneration);
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
  /**
   * What the panel needs and the Weave does not: where the Lobby is, and — on the Lobby's own page
   * — the request snapshot. Neither may break the rest of the page, and neither may be given up on:
   * a missed request has no later event that would bring it in, and a missed pointer would hide the
   * panel and the profile cards for good. So the failure is held in state and the read is retried,
   * in one loop, on the same backoff a refresh uses, until it succeeds or the session goes away.
   *
   * Discovery comes first because the second half depends on it; off the Lobby the pointer was the
   * whole job. One loop per generation, and it retires with the generation that started it, so a
   * pending sleep never outlives its load (dispose aborts the sleep as well).
   *
   * The guard is keyed on that generation rather than being a bare "a loop is running" flag: a
   * second `load()` retires the first one's loop, and a bare flag would make the new load skip its
   * own retry on the strength of a loop that is about to exit — leaving the board unread for good.
   */
  let retryingFor: number | undefined;
  const retryLobbyData = (myGeneration: number) => {
    if (retryingFor === myGeneration || disposed || myGeneration !== generation) return;
    retryingFor = myGeneration;
    void (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          await sleep(attempt < retry.delaysMs.length ? retry.delaysMs[attempt]! : retry.slowMs, lifetime.signal);
          if (disposed || myGeneration !== generation) return;
          if (!lobbyKnown) {
            const found = await discoverLobby();
            if (disposed || myGeneration !== generation) return;
            if (!found.settled) { set({ requestsError: found.error }); continue; }
            lobbyKnown = true;
            // Published before the read below, so the panels appear as soon as the pointer is known.
            set({ lobby: found.lobby });
          }
          // Not the Lobby's page (or no Lobby at all): there is no board here, and saying so is
          // honest — unlike the same claim made while the pointer was still unknown.
          if (!onLobby()) { set({ requestsLoaded: true, requestsError: undefined }); return; }
          try {
            const snaps = await readRequests();
            if (disposed || myGeneration !== generation) return;
            applyRequests(snaps);
            set({ requestsLoaded: true, requestsError: undefined });
            return;
          } catch (e) {
            if (disposed || myGeneration !== generation) return;
            set({ requestsError: messageOf(e) });
          }
        }
      // Only if it is still this generation's: a newer load may already own the slot by now.
      } finally { if (retryingFor === myGeneration) retryingFor = undefined; }
    })();
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
    set({ events, ...deriveInvites(events, state.me?.participant.id, seenUpTo) });
    // thread.url_changed carries the new url in the event, but the url the UI renders lives on the
    // Thread record, so it needs the same refresh as any other thread change.
    // participant.capabilities_changed is here for the same reason: a Lobby profile lives on the
    // Participant record, so the panel and the Offer form only see it once the metadata is re-read.
    if (e.type === "thread.created" || e.type === "thread.closed" || e.type === "thread.url_changed"
      || e.type === "participant.joined" || e.type === "participant.role_changed"
      || e.type === "participant.capabilities_changed") {
      scheduleRefresh();
    } else if (e.type === "weave.guidelines_changed") {
      // An older change can still be replayed after a newer snapshot was accepted (history, then
      // metadata, then the stream from the history cursor): it belongs in the log and in the thread
      // view, but it must not drag the panel backwards.
      if (e.seq > guidelinesSeq && state.weave) {
        guidelinesSeq = e.seq;
        set({ weave: { ...state.weave, guidelines: String(e.payload.guidelines ?? "") } });
      }
      scheduleRefresh();
    } else if (isRequestEvent(e)) {
      const requests = applyEvent(state.requests, e);
      if (requests !== state.requests) set({ requests });
      // A request this session has never seen (opened while it was away, or a refresh that has not
      // landed yet): the event alone is not a whole row, so the refresh is what brings it in.
      else if (!state.requests[String(e.payload.requestId ?? "")]) scheduleRefresh();
    } else if (e.type === "weave.archived") {
      if (state.weave) set({ weave: { ...state.weave, archivedAt: e.at } });
      // Also refresh: a refresh that started before the archive is still going to land with stale
      // metadata, and this one runs after it, so the rest of the Weave converges too.
      scheduleRefresh();
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
        // The instance guidelines and the Lobby pointer are public and independent of this Weave, so
        // they are fetched alongside the metadata and a failure only costs the panel its section.
        const [info, instance, discovery] = await Promise.all([
          reader.getWeave(id),
          client.getInstanceGuidelines().catch(() => ""),
          discoverLobby(),
        ]);
        if (stale()) return;
        // Only the Lobby's own page has requests, and they are read with this browser's Lobby
        // credential — the same secret the rest of the page is read with. A failure here (or of the
        // discovery above) costs the panel its section and nothing else, but it is remembered
        // rather than shown as an empty board, and retried below once this load has published.
        let requests: LoomRequest[] = [];
        let requestsError = discovery.error;
        if (discovery.settled && discovery.lobby?.weaveId === id) {
          try { requests = await readRequests(); } catch (e) { requestsError = messageOf(e); }
        }
        if (stale()) return;
        weaveId = id;
        lobbyKnown = discovery.settled;
        guidelinesSeq = info.weave.lastSeq;
        let me: SessionState["me"];
        const stored = storage.get(key);
        if (stored) {
          try {
            const { token, participantId } = JSON.parse(stored) as { token: string; participantId: string };
            const p = info.participants.find((x) => x.id === participantId);
            if (p && token) me = { token, participant: p };
          } catch { storage.remove(key); }
        }
        // The thread this load lands on is on screen, so an invite to it is not an unopened one.
        const first = info.threads.find((t) => t.isGeneral)?.id ?? info.threads[0]?.id;
        if (first) seenUpTo.set(first, maxSeq(events));
        let held: Requests = {};
        for (const snap of requests) held = applySnapshot(held, snap);
        set({ status: "ready", weave: info.weave, threads: info.threads, participants: info.participants, events, me,
          instanceGuidelines: instance, currentThreadId: first, lobby: discovery.lobby, requests: held,
          // An unsettled pointer is not an empty board: until it is known whether this page even has
          // one, the panel has nothing to render and nothing may claim the requests are loaded.
          requestsLoaded: lobbyKnown && requestsError === undefined, requestsError,
          ...deriveInvites(events, me?.participant.id, seenUpTo) });
        // After readiness, never before it: the page is usable while the pointer and the board catch
        // up. The opening event of a request read here is already in history, so nothing would ever
        // replay it — only this retry can bring the row in, and only it can settle the pointer.
        if (!lobbyKnown || requestsError !== undefined) retryLobbyData(myGeneration);
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
      // The write happens whether or not anyone is listening: `onWrite?.(storage.set(…))` would
      // skip the argument entirely when no `onWrite` was passed, and the credential with it.
      const wrote = storage.set(key, JSON.stringify({ token: j.token, participantId: j.participant.id }));
      onWrite?.(wrote);
      // The join is already committed server-side: reflect it locally right away and let a failing
      // refresh retry in the background rather than surface as a rejection of an action that in fact
      // succeeded (which would make the caller retry join() and hit name_taken).
      const participants = state.participants.some((p) => p.id === j.participant.id)
        ? state.participants
        : [...state.participants, j.participant];
      // Invites are "for me" only once there is a me: recompute now that this session has an identity.
      set({ me: { token: j.token, participant: j.participant }, needsName: false, participants,
        ...deriveInvites(state.events, j.participant.id, seenUpTo) });
      scheduleRefresh();
    },

    selectThread: (id) => {
      markThreadSeen(id);
      set({ currentThreadId: id, ...deriveInvites(state.events, state.me?.participant.id, seenUpTo) });
    },
    markSeen: (id) => {
      markThreadSeen(id);
      set(deriveInvites(state.events, state.me?.participant.id, seenUpTo));
    },

    async post(text) {
      const w = writer();
      const threadId = state.currentThreadId;
      if (!threadId) throw new LoomClientError("validation", "No thread selected");
      onEvent(await w.postMessage(threadId, text));
    },
    async createThread(name, url = null) {
      const w = writer();
      if (!weaveId) throw new LoomClientError("validation", "Weave not loaded");
      const t = await w.createThread(weaveId, name, url);
      markThreadSeen(t.id);
      set({ threads: state.threads.some((x) => x.id === t.id) ? state.threads : [...state.threads, t], currentThreadId: t.id });
    },
    async setThreadUrl(id, url) {
      const w = writer();
      const t = await w.setThreadUrl(id, url);
      set({ threads: state.threads.map((x) => (x.id === id ? t : x)) });
    },
    async invite(threadId, participantId) {
      const w = writer();
      await w.inviteParticipant(threadId, participantId);
      // The thread.invited event arrives over the stream and updates `invited`; refresh in case the
      // stream is down, exactly as the other already-committed mutations do.
      scheduleRefresh();
    },
    async closeThread(id) {
      const w = writer();
      await w.closeThread(id);
      // Committed server-side already: update the thread locally and refresh in the background (see
      // join() above) instead of letting a transient refresh failure read back as a mutation failure.
      set({ threads: state.threads.map((t) => (t.id === id && !t.closedAt ? { ...t, closedAt: new Date().toISOString() } : t)) });
      scheduleRefresh();
    },
    async archive() {
      const w = writer();
      if (!weaveId) throw new LoomClientError("validation", "Weave not loaded");
      await w.archiveWeave(weaveId);
      // Same reasoning as join()/closeThread(): the archive is already committed.
      set({ weave: state.weave && !state.weave.archivedAt ? { ...state.weave, archivedAt: new Date().toISOString() } : state.weave });
      scheduleRefresh();
    },
    async setGuidelines(text) {
      const w = writer();
      if (!weaveId) throw new LoomClientError("validation", "Weave not loaded");
      const r = await w.setWeaveGuidelines(weaveId, text);
      // `seq` is null when the text already matched (nothing was appended, so nothing to watermark).
      // Otherwise this change is the newest one this session knows of — apply it now rather than
      // waiting for the event, exactly as the other already-committed mutations do.
      if (r.seq !== null && r.seq > guidelinesSeq && state.weave) {
        guidelinesSeq = r.seq;
        set({ weave: { ...state.weave, guidelines: r.weave.guidelines } });
      }
      scheduleRefresh();
    },
    // --- Lobby requests. Each mutation is already committed server-side when it answers, so the
    // snapshot it returns is applied straight away — through the same watermark the refresh uses,
    // which is what keeps a slower refresh from undoing it.
    async openRequest(input) {
      const r = await writer().openRequest(input);
      applyRequests([r]);
      return r;
    },
    async offer(requestId, input) {
      const w = writer();
      await w.offer(requestId, input);
      // `offer` answers with the Offer, not the request: the row is read back so the panel moves on
      // the same watermark as everything else rather than on a hand-built row.
      applyRequests([await w.getRequest(requestId)]);
    },
    async accept(requestId, participantIds) {
      applyRequests([(await writer().acceptRequest(requestId, participantIds)).request]);
    },
    async cancel(requestId) {
      applyRequests([await writer().cancelRequest(requestId)]);
    },
    async targets() {
      const out: TargetWeave[] = [];
      for (const w of storedWeaves(storage)) {
        // Only the legacy shape today; Task 4 gives id-keyed entries a target of their own.
        if (w.kind !== "legacy") continue;
        const { secret, token } = w;
        // One Weave this browser can no longer reach (revoked token, deleted Weave) must not cost
        // the picker the others, so each is resolved on its own and a failure simply omits it.
        try {
          const c = client.withToken(token);
          const id = await c.lookupWeave(secret);
          // A request cannot target the Lobby (core refuses it), so it is not offered.
          if (id === state.lobby?.weaveId) continue;
          const info = await c.getWeave(id);
          if (info.weave.archivedAt) continue;
          out.push({ weaveId: id, title: info.weave.title, token,
            threads: info.threads.filter((t) => !t.closedAt).map((t) => ({ id: t.id, name: t.name })) });
        } catch { /* not a target this browser can offer */ }
      }
      return out;
    },
    canModerate: () => state.me?.participant.role === "keeper" && !state.weave?.archivedAt,
    canEditThread: (t) => !!state.me && !state.weave?.archivedAt && !t.closedAt
      && (state.me.participant.role === "keeper" || t.createdBy === state.me.participant.id),
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
