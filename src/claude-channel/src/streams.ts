import type { LoomClient, LoomEvent, StreamHandle } from "@loom/client";
import type { ChannelState, JoinedWeave, Wake } from "./state.js";
import { formatEvent, shouldWake, type Names } from "./format.js";

type Active = { handle: StreamHandle; names: Names; title: string; wake: Wake; participantId: string; chain: Promise<void>; stopped: boolean };

export class StreamManager {
  private active = new Map<string, Active>();
  private threadToWeave = new Map<string, string>();

  constructor(
    private readonly client: LoomClient, private readonly state: ChannelState,
    private readonly notify: (params: { content: string; meta: Record<string, string> }) => Promise<void>,
    private readonly log: (m: string) => void,
  ) {}

  threadOwner(threadId: string): string | undefined {
    return this.threadToWeave.get(threadId) ?? Object.entries(this.state.get().weaves).find(([, w]) => w.generalThreadId === threadId)?.[0];
  }

  restoreAll(): void { for (const [id, w] of Object.entries(this.state.get().weaves)) this.start(id, w); }
  closeAll(): void { for (const id of [...this.active.keys()]) this.stop(id); }
  setWake(weaveId: string, wake: Wake): void { const a = this.active.get(weaveId); if (a) a.wake = wake; }

  stop(weaveId: string): void {
    const a = this.active.get(weaveId);
    if (!a) return;
    a.stopped = true;
    // start() assigns `handle` only after the async name-refresh resolves; stop() can race ahead of
    // that (e.g. leave_weave called right after create_weave). The `stopped` flag already makes the
    // pending refresh's continuation skip opening the stream, so there is nothing to close here.
    a.handle?.close();
    this.active.delete(weaveId);
  }

  start(weaveId: string, w: JoinedWeave): void {
    this.stop(weaveId);
    const reader = this.client.withToken(w.token);
    const entry: Active = { handle: undefined as unknown as StreamHandle, names: { threads: new Map(), participants: new Map() }, title: w.title, wake: w.wake, participantId: w.participantId, chain: Promise.resolve(), stopped: false };
    this.active.set(weaveId, entry);
    const refresh = async () => {
      const info = await reader.getWeave(weaveId);
      entry.title = info.weave.title;
      entry.names.threads = new Map(info.threads.map((t) => [t.id, t.name]));
      entry.names.participants = new Map(info.participants.map((p) => [p.id, { name: p.name, kind: p.kind }]));
      for (const t of info.threads) this.threadToWeave.set(t.id, weaveId);
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
      }).catch((err) => this.log(`delivery failed for weave ${weaveId} seq ${e.seq}: ${(err as Error).message}`));
    };
    void refresh().catch((err) => this.log(`initial name fetch failed for weave ${weaveId}: ${(err as Error).message}`)).then(() => {
      if (entry.stopped) return;
      entry.handle = reader.stream(weaveId, {
        since: this.state.get().weaves[weaveId]?.lastSeq ?? w.lastSeq,
        onEvent,
        onStatus: (st, d) => {
          if (st === "closed" && d?.error && !entry.stopped) {
            this.log(`stream for weave ${weaveId} closed: ${d.error.code}; retrying in 5s`);
            setTimeout(() => { if (!entry.stopped && this.state.get().weaves[weaveId]) this.start(weaveId, this.state.get().weaves[weaveId]!); }, 5000).unref();
          }
        },
      });
    });
  }
}
