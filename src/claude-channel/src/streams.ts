import { LoomClientError, type LoomClient, type LoomEvent, type StreamHandle } from "@loom/client";
import type { ChannelState, JoinedWeave, Prefs } from "./state.js";
import { formatEvent, safe, shouldWake, withPreamble, type Names } from "./format.js";

type Active = {
  handle?: StreamHandle; names: Names; title: string; prefs: Prefs; participantId: string; token: string; chain: Promise<void>; stopped: boolean;
  threadIds: Set<string>; restartTimer?: ReturnType<typeof setTimeout>; backoffMs: number;
  /** The Weave's combined guidelines as of the last successful refresh(); "" when there are none. */
  guidelines: string;
};

const DEFAULT_RESTART_BACKOFF = { initial: 2000, max: 30_000 };

export class StreamManager {
  private active = new Map<string, Active>();
  private threadToWeave = new Map<string, string>();
  /** Next backoff delay per weaveId, surviving across the ephemeral `Active` entries that
   * scheduleRestart()/start() replace on each restart — otherwise exponential backoff would reset
   * to `initial` on every restart instead of growing across repeated failures. Reset to `initial`
   * after a successful delivery, and dropped in teardown() — which start() also calls, so start()
   * captures the value *before* tearing down and re-seeds the fresh entry from it. What teardown()
   * alone leaves behind is therefore nothing: a leave/rejoin (stop()) or a restore starts clean and
   * does not inherit a dead stream's backoff history. */
  private nextBackoffMs = new Map<string, number>();
  /** Weaves whose guidelines preamble this session has already handed over. Deliberately outside
   * `Active`, which start() replaces on every automatic restart and on a same-identity re-arm —
   * neither of which is a new session for the agent. Only a leave (stop()) clears it, so a rejoin
   * introduces the rules again. Process memory only: nothing about it belongs in channel state. */
  private preambleDone = new Set<string>();
  private readonly restartBackoffMs: { initial: number; max: number };

  constructor(
    private readonly client: LoomClient, private readonly state: ChannelState,
    private readonly notify: (params: { content: string; meta: Record<string, string> }) => Promise<void>,
    private readonly log: (m: string) => void,
    restartBackoffMs?: { initial: number; max: number },
  ) {
    this.restartBackoffMs = restartBackoffMs ?? DEFAULT_RESTART_BACKOFF;
  }

  threadOwner(threadId: string): string | undefined {
    return this.threadToWeave.get(threadId) ?? Object.entries(this.state.get().weaves).find(([, w]) => w.generalThreadId === threadId)?.[0];
  }

  /** Registers a thread's owning Weave immediately, for threads this session itself just created —
   * the stream's own thread.created event (which would otherwise populate threadOwner) is delivered
   * asynchronously and can race a post_message that follows create_thread right away. Only records
   * ownership while the weave has an active entry: recording into threadToWeave without a matching
   * `Active.threadIds` entry would leave stop() with nothing to clean up, leaking the mapping for a
   * weave that is no longer active. */
  noteThread(weaveId: string, threadId: string): void {
    const active = this.active.get(weaveId);
    if (!active) return;
    this.threadToWeave.set(threadId, weaveId);
    active.threadIds.add(threadId);
  }

  restoreAll(): void { for (const [id, w] of Object.entries(this.state.load().weaves)) this.start(id, w); }
  /** Process exit, not a leave: the streams go away but the session does not, so `preambleDone` stands. */
  closeAll(): void { for (const id of [...this.active.keys()]) this.teardown(id); }
  setPrefs(weaveId: string, prefs: Prefs): void { const a = this.active.get(weaveId); if (a) a.prefs = prefs; }

  /** Leaving the Weave (what leave_weave does): tear the stream down and forget that this session
   * was ever told the rules, so a later rejoin opens with them again. */
  stop(weaveId: string): void {
    this.teardown(weaveId);
    this.preambleDone.delete(weaveId);
  }

  /** Closes and forgets the active entry without touching anything that outlives it. */
  private teardown(weaveId: string): void {
    const a = this.active.get(weaveId);
    if (!a) return;
    a.stopped = true;
    if (a.restartTimer) { clearTimeout(a.restartTimer); a.restartTimer = undefined; }
    // start() assigns `handle` only after the async name-refresh resolves; stop() can race ahead of
    // that (e.g. leave_weave called right after create_weave). The `stopped` flag already makes the
    // pending refresh's continuation skip opening the stream, so there is nothing to close here.
    a.handle?.close();
    for (const t of a.threadIds) this.threadToWeave.delete(t);
    this.active.delete(weaveId);
    this.nextBackoffMs.delete(weaveId);
  }

  /**
   * Loom refused this stored identity in its own Weave with `forbidden` (spec 2026-10-09 §8.3). After
   * the kick slice a participant token reading its own Weave is refused that way for one reason only,
   * a kick, so the Weave is stopped and forgotten, the agent is told once, and no restart is
   * scheduled: a dead token retried every 30 s for the life of the process helps nobody.
   * `invalid_token` and `weave_not_found` keep the backoff (KNOWN-ISSUES), because a misconfigured
   * LOOM_URL or a restored database answers one of them for every stored identity at once.
   *
   * The refused token is the one this entry's stream read with, captured before anything awaits.
   * Every session on the machine shares ChannelState, and another one may have been readmitted and
   * stored a replacement token after this stream opened; so the Weave is forgotten only while its
   * stored token is still the refused one. When a replacement is stored, it and every session's
   * cursor and preferences stand, nothing is notified, and this Weave is restarted with the
   * replacement from this session's own cursor: nothing else tells this process the token changed.
   */
  private async drop(weaveId: string, entry: Active): Promise<void> {
    if (this.active.get(weaveId) !== entry) return;
    const refused = entry.token;
    const title = entry.title;
    // teardown(), not stop(): whether this session leaves the Weave is known only once the state answers.
    this.teardown(weaveId);
    try {
      const replacement = await this.state.removeWeaveIfToken(weaveId, refused);
      if (replacement) {
        // A join in this process may have started the Weave while the state answered; that stream already reads with it.
        const running = this.active.has(weaveId);
        this.log(`identity for weave ${weaveId} refused (forbidden): a replacement is stored, ${running ? "already running" : "restarted with it"}`);
        if (!running) this.start(weaveId, replacement);
        return;
      }
      this.preambleDone.delete(weaveId);   // what stop() adds to teardown(): a later rejoin opens with the rules again
      this.log(`identity for weave ${weaveId} refused (forbidden): dropped`);
      // The channel never receives the participant.kicked itself (its stream closes first), and
      // without this the session's next call on the Weave would be sent to join_weave, which refuses it.
      await this.notify({
        content: `You were removed from "${title}": Loom refuses this participant's token. The channel forgot this Weave; a keeper must invite you back (invite_to_weave).`,
        meta: { weave: safe(weaveId), weave_title: safe(title), type: "participant.kicked" },
      });
    } catch (err) {
      this.log(`dropping weave ${weaveId} failed: ${(err as Error).message}`);
    }
  }

  /** Schedules a restart of `weaveId` from the persisted cursor after a backoff, doubling on repeat
   * failures up to `restartBackoffMs.max` and resetting to `initial` after a successful delivery.
   * The doubled delay is recorded in `nextBackoffMs` so the *next* restart's fresh `Active` entry
   * (created by start(), which cannot see this one) picks up the grown backoff instead of resetting
   * to `initial`. The timer is stored on `entry` so `stop()` can cancel it, and is a no-op if the
   * weave was removed or replaced (by an explicit stop()/start()) before it fires. */
  private scheduleRestart(weaveId: string, entry: Active): void {
    const delay = entry.backoffMs;
    entry.backoffMs = Math.min(this.restartBackoffMs.max, entry.backoffMs * 2);
    this.nextBackoffMs.set(weaveId, entry.backoffMs);
    const timer = setTimeout(() => {
      entry.restartTimer = undefined;
      if (this.active.get(weaveId) !== entry) return;
      const w = this.state.get().weaves[weaveId];
      if (!w) { this.active.delete(weaveId); return; }
      this.start(weaveId, w);
    }, delay);
    timer.unref();
    entry.restartTimer = timer;
  }

  start(weaveId: string, w: JoinedWeave): void {
    // Captured before teardown(weaveId) below, which clears nextBackoffMs for this weaveId —
    // teardown must run first (to close any existing entry the normal way) but must not erase the
    // backoff value this fresh entry is about to seed itself with.
    const backoffMs = this.nextBackoffMs.get(weaveId) ?? this.restartBackoffMs.initial;
    // teardown(), not stop(): an automatic restart and a same-identity re-arm both land here, and
    // neither means the agent has forgotten the guidelines it was already handed this session.
    this.teardown(weaveId);
    const reader = this.client.withToken(w.token);
    const entry: Active = {
      names: { threads: new Map(), participants: new Map() }, title: w.title, prefs: this.state.prefs(weaveId), participantId: w.participantId, token: w.token,
      chain: Promise.resolve(), stopped: false, threadIds: new Set(), backoffMs, guidelines: "",
    };
    this.active.set(weaveId, entry);
    const refresh = async () => {
      const info = await reader.getWeave(weaveId);
      if (entry.stopped) return; // stop() raced ahead of this refresh; don't resurrect thread ownership for a dead entry
      entry.title = info.weave.title;
      entry.guidelines = info.guidelines;
      entry.names.threads = new Map(info.threads.map((t) => [t.id, { name: t.name, url: t.url }]));
      entry.names.participants = new Map(info.participants.map((p) => [p.id, { name: p.name, kind: p.kind }]));
      for (const t of info.threads) { this.threadToWeave.set(t.id, weaveId); entry.threadIds.add(t.id); }
    };
    /** Folds what the event itself says into the names cache. The refresh below is the
     * authoritative follow-up, but its failure is logged and swallowed while the cursor still
     * advances — so without this the cache (and every later event's `thread_url`) would keep the
     * old value forever. */
    const applyToNames = (e: LoomEvent) => {
      const str = (v: unknown, fallback: string) => (typeof v === "string" && v.length > 0 ? v : fallback);
      const url = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
      if (e.type === "thread.created") {
        entry.names.threads.set(e.threadId, { name: str(e.payload.name, e.threadId), url: url(e.payload.url) });
      } else if (e.type === "thread.url_changed") {
        const t = entry.names.threads.get(e.threadId);
        if (t) t.url = url(e.payload.url);
        else entry.names.threads.set(e.threadId, { name: e.threadId, url: url(e.payload.url) });
      } else if (e.type === "participant.joined") {
        const id = str(e.payload.participantId, "");
        if (id) entry.names.participants.set(id, { name: str(e.payload.name, id), kind: str(e.payload.kind, "agent") });
      }
    };
    const onEvent = (e: LoomEvent) => {
      entry.chain = entry.chain.then(async () => {
        if (entry.stopped) return;
        if (e.type === "thread.created" || e.type === "thread.url_changed" || e.type === "participant.joined" || e.type === "participant.role_changed" || e.type === "weave.guidelines_changed") {
          applyToNames(e);
          await refresh().catch((err) => this.log(`metadata refresh failed for weave ${weaveId}: ${(err as Error).message}`));
        }
        if (shouldWake(e, { participantId: entry.participantId, ...entry.prefs })) {
          let n = formatEvent(e, { id: weaveId, title: entry.title }, entry.names, entry.participantId);
          // The first turn this session receives for the Weave carries the rules with it; empty
          // guidelines still count as delivered — there was nothing to say, and a later change
          // reaches the agent as a weave.guidelines_changed event. When that first woken event *is*
          // a weave.guidelines_changed, the preamble and the event body both carry the new text:
          // accepted, because the alternative (suppressing one of them) costs an agent either the
          // rules or the notice that they changed, for a repeat of at most 4000 characters.
          const first = !this.preambleDone.has(weaveId);
          if (first) n = withPreamble(n, entry.guidelines);
          await this.notify(n);
          if (first) this.preambleDone.add(weaveId);   // only once the turn carrying it was handed over
        }
        await this.state.setLastSeq(weaveId, e.seq);
        entry.backoffMs = this.restartBackoffMs.initial;
        this.nextBackoffMs.set(weaveId, this.restartBackoffMs.initial);
      }).catch((err) => {
        // A notify rejection or setLastSeq throw is fatal: lastSeq is only persisted after a
        // successful delivery, so leaving the chain to swallow this would let later events run and
        // advance the cursor past an event that was never delivered — losing it forever on restart.
        // Stop this stream instance and restart the whole weave from the persisted cursor so the
        // failed event replays first.
        if (entry.stopped) return;
        entry.stopped = true;
        entry.handle?.close();
        this.log(`delivery failed for weave ${weaveId} seq ${e.seq}: ${(err as Error).message}`);
        this.scheduleRestart(weaveId, entry);
      });
    };
    // This session's own cursor (resume replays exactly what *it* missed), or the machine-wide
    // watermark for a session that has never listened to this Weave — persisted either way, so a
    // session that receives nothing still resumes from where it started listening.
    //
    // Pinned *before* the first getWeave, not after it: the watermark is shared by every session on
    // the machine, so if this attempt fails and a sibling session delivers events while we back off,
    // a retry that only then consulted the watermark would adopt the sibling's progress and skip
    // everything waiting behind it. ensureCursor writes the starting point once and returns that
    // same number to every later call, so the retry resumes from where this session meant to start.
    // It moves no watermark and delivers nothing, so the precondition below still holds.
    void this.state.ensureCursor(weaveId).then(async (pinned) => {
      await refresh();
      return pinned;
    }).catch((err) => {
      // The metadata carries the guidelines this session's first turn must open with, so it is a
      // precondition rather than a nicety: open no stream and leave the cursor where it is, so the
      // events waiting behind it are still there when a getWeave finally succeeds.
      if (entry.stopped) return undefined;
      if (err instanceof LoomClientError && err.code === "forbidden") { void this.drop(weaveId, entry); return undefined; }
      entry.stopped = true;
      this.log(`initial metadata fetch failed for weave ${weaveId}: ${(err as Error).message}`);
      this.scheduleRestart(weaveId, entry);
      return undefined;
    }).then((since) => {
      if (entry.stopped || since === undefined) return;
      const handle = reader.stream(weaveId, {
        since,
        onEvent,
        onStatus: (st, d) => {
          if (st === "closed" && d?.error && !entry.stopped) {
            if (d.error.code === "forbidden") { void this.drop(weaveId, entry); return; }
            entry.stopped = true;
            entry.handle?.close();
            this.log(`stream for weave ${weaveId} closed: ${d.error.code}`);
            this.scheduleRestart(weaveId, entry);
          }
        },
      });
      // stream() can report a terminal close from inside the call itself, before `handle` is
      // assigned — onStatus's `entry.handle?.close()` then closes nothing and this handle would
      // leak until the next restart's stop() happened to pick it up. Close it here instead.
      if (entry.stopped) { handle.close(); return; }
      entry.handle = handle;
    }).catch((err) => {
      // Opening the stream failed (a synchronous throw from stream(), or a rejection from the
      // refresh chain). Without this the rejection would only surface in the process-wide
      // unhandledRejection logger and the Weave would sit silently disconnected forever; instead,
      // report it and retry from the persisted cursor with the usual backoff.
      if (entry.stopped) return;
      entry.stopped = true;
      this.log(`stream start failed for weave ${weaveId}: ${(err as Error).message}`);
      this.scheduleRestart(weaveId, entry);
    });
  }
}
