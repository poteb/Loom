import type { LoomClient, LoomEvent, StreamHandle } from "@loom/client";
import type { ChannelState, JoinedWeave, Wake } from "./state.js";
import { formatEvent, shouldWake, type Names } from "./format.js";

type Active = {
  handle?: StreamHandle; names: Names; title: string; wake: Wake; participantId: string; chain: Promise<void>; stopped: boolean;
  threadIds: Set<string>; restartTimer?: ReturnType<typeof setTimeout>; backoffMs: number;
};

const DEFAULT_RESTART_BACKOFF = { initial: 2000, max: 30_000 };

export class StreamManager {
  private active = new Map<string, Active>();
  private threadToWeave = new Map<string, string>();
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
   * asynchronously and can race a post_message that follows create_thread right away. */
  noteThread(weaveId: string, threadId: string): void {
    this.threadToWeave.set(threadId, weaveId);
    this.active.get(weaveId)?.threadIds.add(threadId);
  }

  restoreAll(): void { for (const [id, w] of Object.entries(this.state.get().weaves)) this.start(id, w); }
  closeAll(): void { for (const id of [...this.active.keys()]) this.stop(id); }
  setWake(weaveId: string, wake: Wake): void { const a = this.active.get(weaveId); if (a) a.wake = wake; }

  stop(weaveId: string): void {
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
  }

  /** Schedules a restart of `weaveId` from the persisted cursor after a backoff, doubling on repeat
   * failures up to `restartBackoffMs.max` and resetting to `initial` after a successful delivery.
   * The timer is stored on `entry` so `stop()` can cancel it, and is a no-op if the weave was
   * removed or replaced (by an explicit stop()/start()) before it fires. */
  private scheduleRestart(weaveId: string, entry: Active): void {
    const delay = entry.backoffMs;
    entry.backoffMs = Math.min(this.restartBackoffMs.max, entry.backoffMs * 2);
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
    this.stop(weaveId);
    const reader = this.client.withToken(w.token);
    const entry: Active = {
      names: { threads: new Map(), participants: new Map() }, title: w.title, wake: w.wake, participantId: w.participantId,
      chain: Promise.resolve(), stopped: false, threadIds: new Set(), backoffMs: this.restartBackoffMs.initial,
    };
    this.active.set(weaveId, entry);
    const refresh = async () => {
      const info = await reader.getWeave(weaveId);
      if (entry.stopped) return; // stop() raced ahead of this refresh; don't resurrect thread ownership for a dead entry
      entry.title = info.weave.title;
      entry.names.threads = new Map(info.threads.map((t) => [t.id, t.name]));
      entry.names.participants = new Map(info.participants.map((p) => [p.id, { name: p.name, kind: p.kind }]));
      for (const t of info.threads) { this.threadToWeave.set(t.id, weaveId); entry.threadIds.add(t.id); }
    };
    const onEvent = (e: LoomEvent) => {
      entry.chain = entry.chain.then(async () => {
        if (entry.stopped) return;
        if (e.type === "thread.created" || e.type === "participant.joined" || e.type === "participant.role_changed") {
          await refresh().catch((err) => this.log(`name refresh failed for weave ${weaveId}: ${(err as Error).message}`));
        }
        if (shouldWake(e, { participantId: entry.participantId, wake: entry.wake })) {
          await this.notify(formatEvent(e, { id: weaveId, title: entry.title }, entry.names));
        }
        this.state.setLastSeq(weaveId, e.seq);
        entry.backoffMs = this.restartBackoffMs.initial;
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
    void refresh().catch((err) => this.log(`initial name fetch failed for weave ${weaveId}: ${(err as Error).message}`)).then(() => {
      if (entry.stopped) return;
      entry.handle = reader.stream(weaveId, {
        since: this.state.get().weaves[weaveId]?.lastSeq ?? w.lastSeq,
        onEvent,
        onStatus: (st, d) => {
          if (st === "closed" && d?.error && !entry.stopped) {
            entry.stopped = true;
            entry.handle?.close();
            this.log(`stream for weave ${weaveId} closed: ${d.error.code}`);
            this.scheduleRestart(weaveId, entry);
          }
        },
      });
    });
  }
}
