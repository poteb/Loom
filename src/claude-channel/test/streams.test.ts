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

  it("noteThread registers ownership immediately, ahead of the stream's own thread.created round-trip; stop() clears it", async () => {
    const w = makeWeave();
    const state = makeState(w);
    const notify = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, log);
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);

    expect(sm.threadOwner("t-new")).toBeUndefined();
    sm.noteThread(WEAVE_ID, "t-new");
    expect(sm.threadOwner("t-new")).toBe(WEAVE_ID);

    sm.stop(WEAVE_ID);
    expect(sm.threadOwner("t-new")).toBeUndefined();
  });

  it("grows the restart backoff exponentially across consecutive restarts, caps at max, and resets to initial after a successful delivery", async () => {
    // Fake timers make this deterministic: the delay actually passed to setTimeout is asserted
    // directly (by advancing exactly up to, then past, each threshold) instead of measuring
    // wall-clock gaps, which is flaky under real scheduling jitter.
    vi.useFakeTimers();
    try {
      const w = makeWeave();
      const state = makeState(w);
      const log = vi.fn();
      const notify = vi.fn(async (): Promise<void> => { throw new Error("notify failed"); });
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
      const client = fake as unknown as LoomClient;
      const sm = new StreamManager(client, state, notify, log, { initial: 10, max: 40 });

      sm.start(WEAVE_ID, w);
      await vi.advanceTimersByTimeAsync(0); // let the initial refresh()/getWeave() microtasks resolve and open stream #1
      expect(streams.length).toBe(1);

      streams[0]!.opts.onEvent(event(4)); // notify rejects -> restart scheduled at `initial` (10ms)
      await vi.advanceTimersByTimeAsync(9);
      expect(streams.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams.length).toBe(2);

      streams[1]!.opts.onEvent(event(4)); // rejects again -> doubled to 20ms
      await vi.advanceTimersByTimeAsync(19);
      expect(streams.length).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams.length).toBe(3);

      streams[2]!.opts.onEvent(event(4)); // rejects again -> doubled to 40ms
      await vi.advanceTimersByTimeAsync(39);
      expect(streams.length).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams.length).toBe(4);

      streams[3]!.opts.onEvent(event(4)); // rejects again -> would double to 80ms but caps at max (40ms)
      await vi.advanceTimersByTimeAsync(39);
      expect(streams.length).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams.length).toBe(5);

      // A successful delivery resets the backoff back to `initial` for the next failure.
      notify.mockImplementation(async () => {});
      streams[4]!.opts.onEvent(event(4));
      await vi.advanceTimersByTimeAsync(0);
      expect(state.get().weaves[WEAVE_ID]?.lastSeq).toBe(4);

      notify.mockImplementation(async () => { throw new Error("notify failed again"); });
      streams[4]!.opts.onEvent(event(5));
      await vi.advanceTimersByTimeAsync(9); // still at `initial` (10ms), not the capped 40ms
      expect(streams.length).toBe(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams.length).toBe(6);
    } finally {
      vi.useRealTimers();
    }
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

  it("after stop(), a non-General thread no longer resolves but the General thread still does via the persisted state fallback, until the Weave is removed from state entirely", async () => {
    const w = makeWeave();
    const state = makeState(w);
    const notify = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, log);
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    // refresh() has populated both threads from weaveInfo(): "g1" (General) and "t1" (not General).
    expect(sm.threadOwner("t1")).toBe(WEAVE_ID);
    expect(sm.threadOwner(w.generalThreadId)).toBe(WEAVE_ID);

    sm.stop(WEAVE_ID);
    // threadToWeave was cleared for every tracked thread, so a non-General thread is no longer
    // resolvable purely from stop() — but state.get().weaves still has the joined Weave (stop()
    // doesn't remove it; only an explicit leave_weave/removeWeave does), and threadOwner()'s
    // fallback matches on generalThreadId, so General keeps resolving. This is intended: a
    // post_message credential:"stored" in General must keep working while still joined.
    expect(sm.threadOwner("t1")).toBeUndefined();
    expect(sm.threadOwner(w.generalThreadId)).toBe(WEAVE_ID);

    state.removeWeave(WEAVE_ID); // simulates leave_weave, which removes the Weave from state too
    expect(sm.threadOwner(w.generalThreadId)).toBeUndefined();
  });
});
