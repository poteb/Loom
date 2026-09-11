import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoomClient, LoomEvent, StreamHandle, StreamOptions, Thread, WeaveInfo } from "@loom/client";
import { LoomClientError } from "@loom/client";
import { ChannelState, type JoinedWeave } from "../src/state.js";
import { StreamManager } from "../src/streams.js";

const WEAVE_ID = "w1";
// ChannelState.upsertWeave stores this object by reference and setLastSeq mutates it in place,
// so every test must get its own fresh JoinedWeave rather than share one across the file.
function makeWeave(): JoinedWeave {
  return { title: "T", token: "tok", participantId: "p1", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 3 };
}

function makeState(w: JoinedWeave): ChannelState {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
  const st = new ChannelState(dir);
  st.upsertWeave(WEAVE_ID, w);
  return st;
}

function weaveInfo(extraThreads: Thread[] = []): WeaveInfo {
  return {
    weave: { id: WEAVE_ID, title: "T", createdAt: "", archivedAt: null, lastSeq: 0 },
    threads: [
      { id: "g1", weaveId: WEAVE_ID, name: "General", isGeneral: true, createdBy: "p1", createdAt: "", closedAt: null },
      { id: "t1", weaveId: WEAVE_ID, name: "Existing", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null },
      ...extraThreads,
    ],
    participants: [{ id: "p1", weaveId: WEAVE_ID, name: "Claude", kind: "agent" as const, role: "member" as const, joinedAt: "" }],
  };
}

function event(seq: number, over: Partial<LoomEvent> = {}): LoomEvent {
  return { weaveId: WEAVE_ID, seq, threadId: "g1", type: "message", actor: "other", at: "2026-09-11T00:00:00.000Z", payload: { text: `m${seq}` }, ...over };
}

type Captured = { weaveId: string; opts: StreamOptions; close: ReturnType<typeof vi.fn> };

function makeFakeClient(): { client: LoomClient; streams: Captured[] } {
  const streams: Captured[] = [];
  const fake = {
    withToken: () => fake,
    getWeave: async () => weaveInfo(),
    stream: (weaveId: string, opts: StreamOptions): StreamHandle => {
      const close = vi.fn();
      streams.push({ weaveId, opts, close });
      return { close, get lastSeq() { return opts.since ?? 0; } };
    },
  };
  return { client: fake as unknown as LoomClient, streams };
}

function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 5); };
    tick();
  });
}

describe("StreamManager", () => {
  it("delivers events in order and persists lastSeq", async () => {
    const w = makeWeave();
    const state = makeState(w);
    const notify = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, log);
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    const s0 = streams[0]!;
    s0.opts.onEvent(event(4));
    s0.opts.onEvent(event(5));
    s0.opts.onEvent(event(6));
    await waitFor(() => state.get().weaves[WEAVE_ID]?.lastSeq === 6);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("stops delivery and closes the handle when notify rejects, then restarts from the persisted cursor with backoff", async () => {
    const w = makeWeave();
    const state = makeState(w);
    const log = vi.fn();
    let rejectSeq5Once = true;
    const notify = vi.fn(async (params: { content: string; meta: Record<string, string> }) => {
      if (params.meta.seq === "5" && rejectSeq5Once) { rejectSeq5Once = false; throw new Error("notify failed"); }
    });
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, log, { initial: 20, max: 80 });
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    const s0 = streams[0]!;
    expect(s0.opts.since).toBe(3);

    s0.opts.onEvent(event(4));
    await waitFor(() => state.get().weaves[WEAVE_ID]?.lastSeq === 4);

    s0.opts.onEvent(event(5)); // notify rejects for seq 5
    await waitFor(() => s0.close.mock.calls.length === 1);
    expect(state.get().weaves[WEAVE_ID]?.lastSeq).toBe(4); // cursor did not advance past the failed event

    s0.opts.onEvent(event(6)); // must not be attempted on the dead stream instance
    await new Promise((r) => setTimeout(r, 30));
    expect(notify).toHaveBeenCalledTimes(2); // seq 4 (ok) + seq 5 (rejected); seq 6 never attempted here

    await waitFor(() => streams.length === 2);
    const s1 = streams[1]!;
    expect(s1.opts.since).toBe(4); // replays from the persisted cursor, so the failed event (5) is redelivered

    s1.opts.onEvent(event(5));
    s1.opts.onEvent(event(6));
    await waitFor(() => state.get().weaves[WEAVE_ID]?.lastSeq === 6);
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it("restarts with backoff after a fatal stream close", async () => {
    const w = makeWeave();
    const state = makeState(w);
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, log, { initial: 20, max: 80 });
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    const s0 = streams[0]!;
    s0.opts.onStatus?.("closed", { error: new LoomClientError("network", "boom") });
    await waitFor(() => streams.length === 2);
    expect(streams[1]!.opts.since).toBe(3);
  });

  it("stop() before the backoff timer fires cancels the pending restart", async () => {
    const w = makeWeave();
    const state = makeState(w);
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, log, { initial: 20, max: 80 });
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    streams[0]!.opts.onStatus?.("closed", { error: new LoomClientError("network", "boom") });
    sm.stop(WEAVE_ID);
    await new Promise((r) => setTimeout(r, 60)); // well past the 20ms backoff
    expect(streams.length).toBe(1); // no second stream() call
  });

  it("stop() clears thread ownership, and a name refresh that resolves after stop() does not re-add it", async () => {
    const w = makeWeave();
    const state = makeState(w);
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const streams: Captured[] = [];
    let getWeaveCalls = 0;
    let resolveSecond: (() => void) | undefined;
    const fake = {
      withToken: () => fake,
      getWeave: async (): Promise<WeaveInfo> => {
        getWeaveCalls += 1;
        if (getWeaveCalls === 1) return weaveInfo();
        await new Promise<void>((res) => { resolveSecond = res; });
        return weaveInfo([{ id: "t2", weaveId: WEAVE_ID, name: "New", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null }]);
      },
      stream: (weaveId: string, opts: StreamOptions): StreamHandle => {
        const close = vi.fn();
        streams.push({ weaveId, opts, close });
        return { close, get lastSeq() { return opts.since ?? 0; } };
      },
    };
    const client = fake as unknown as LoomClient;
    const sm = new StreamManager(client, state, notify, log);
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    expect(sm.threadOwner("t1")).toBe(WEAVE_ID);

    streams[0]!.opts.onEvent(event(4, { type: "thread.created", payload: { threadId: "t2", name: "New" } }));
    await waitFor(() => getWeaveCalls === 2);
    sm.stop(WEAVE_ID);
    expect(sm.threadOwner("t1")).toBeUndefined();

    resolveSecond?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(sm.threadOwner("t2")).toBeUndefined();
  });
});
