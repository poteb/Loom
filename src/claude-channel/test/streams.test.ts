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

async function makeState(w: JoinedWeave, sessionId = "s1"): Promise<ChannelState> {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
  const st = new ChannelState(dir, sessionId);
  await st.upsertWeave(WEAVE_ID, w);
  return st;
}

/** `guidelines` is the combined text the client reports for the Weave (instance layer + Weave layer). */
function weaveInfo(extraThreads: Thread[] = [], guidelines = ""): WeaveInfo {
  return {
    weave: { id: WEAVE_ID, title: "T", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
    threads: [
      { id: "g1", weaveId: WEAVE_ID, name: "General", isGeneral: true, createdBy: "p1", createdAt: "", closedAt: null, url: null },
      { id: "t1", weaveId: WEAVE_ID, name: "Existing", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null, url: null },
      ...extraThreads,
    ],
    participants: [{ id: "p1", weaveId: WEAVE_ID, name: "Claude", kind: "agent" as const, role: "member" as const, joinedAt: "", agentId: null, capabilities: null, lastSeenAt: null }],
    guidelines,
  };
}

function event(seq: number, over: Partial<LoomEvent> = {}): LoomEvent {
  return { weaveId: WEAVE_ID, seq, threadId: "g1", type: "message", actor: "other", at: "2026-09-11T00:00:00.000Z", payload: { text: `m${seq}` }, ...over };
}

type Captured = { weaveId: string; opts: StreamOptions; close: ReturnType<typeof vi.fn> };

/** `guidelines` is read on every getWeave, so a test can change what the metadata says mid-run;
 * `failTimes` rejects that many leading getWeave calls, standing in for a Loom that is down.
 * `onGetWeave` is awaited at the top of each call (numbered from 1), so a test that needs a
 * particular ordering around a retry can hold the call open instead of racing the backoff timer. */
function makeFakeClient(opts: { guidelines?: () => string; failTimes?: number; onGetWeave?: (call: number) => Promise<void> | void } = {}): { client: LoomClient; streams: Captured[]; getWeaveCalls: () => number } {
  const streams: Captured[] = [];
  let calls = 0;
  let failsLeft = opts.failTimes ?? 0;
  const fake = {
    withToken: () => fake,
    getWeave: async () => {
      calls += 1;
      await opts.onGetWeave?.(calls);
      if (failsLeft > 0) { failsLeft -= 1; throw new Error("metadata down"); }
      return weaveInfo([], opts.guidelines?.() ?? "");
    },
    stream: (weaveId: string, opts2: StreamOptions): StreamHandle => {
      const close = vi.fn();
      streams.push({ weaveId, opts: opts2, close });
      return { close, get lastSeq() { return opts2.since ?? 0; } };
    },
  };
  return { client: fake as unknown as LoomClient, streams, getWeaveCalls: () => calls };
}

function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 5); };
    tick();
  });
}

describe("StreamManager", () => {
  it("start() records this session's starting cursor before opening the stream, even if no event ever arrives", async () => {
    const seed = await makeState(makeWeave(), "s0"); // joined by some earlier session
    const other = new ChannelState(seed.dir, "s2");
    await other.setLastSeq(WEAVE_ID, 7);              // watermark moves to 7
    const state = new ChannelState(seed.dir, "s1");   // s1 has never listened to this Weave
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, async () => {}, () => {});
    sm.start(WEAVE_ID, state.get().weaves[WEAVE_ID]!);
    await waitFor(() => streams.length === 1);
    expect(streams[0]!.opts.since).toBe(7);
    expect(new ChannelState(seed.dir, "s1").cursor(WEAVE_ID)).toBe(7); // persisted, not just in memory
    sm.closeAll();
  });

  it("pins a new session's cursor before the first metadata fetch, so a retry does not adopt a sibling's watermark", async () => {
    // One machine, one state directory, two sessions. s2 has never listened to this Weave, so its
    // starting point can only come from the watermark -- and the watermark is machine-wide.
    const seed = await makeState(makeWeave(), "s0");   // joined by an earlier session; watermark 3
    const s1 = new ChannelState(seed.dir, "s1");
    const s2 = new ChannelState(seed.dir, "s2");

    let release = () => {};
    const retryGate = new Promise<void>((r) => { release = r; });
    // s2's first getWeave fails; its retry is held open until s1 has moved the watermark, which is
    // the window the bug lived in -- no timer race, the ordering is forced.
    const two = makeFakeClient({ failTimes: 1, onGetWeave: (call) => (call === 2 ? retryGate : undefined) });
    const got2: { content: string; meta: Record<string, string> }[] = [];
    const sm2 = new StreamManager(two.client, s2, async (p) => { got2.push(p); }, () => {}, { initial: 30, max: 60 });
    sm2.start(WEAVE_ID, s2.get().weaves[WEAVE_ID]!);
    await waitFor(() => two.getWeaveCalls() === 2);     // first attempt failed, retry is in flight
    expect(two.streams).toHaveLength(0);                // no stream and no delivery before metadata succeeds
    expect(got2).toHaveLength(0);
    expect(s2.load().weaves[WEAVE_ID]?.lastSeq).toBe(3);

    // Meanwhile a sibling session on the same machine delivers 4 and 5, advancing the watermark.
    const one = makeFakeClient();
    const sm1 = new StreamManager(one.client, s1, async () => {}, () => {});
    sm1.start(WEAVE_ID, s1.get().weaves[WEAVE_ID]!);
    await waitFor(() => one.streams.length === 1);
    one.streams[0]!.opts.onEvent(event(4));
    one.streams[0]!.opts.onEvent(event(5));
    await waitFor(() => s1.load().weaves[WEAVE_ID]?.lastSeq === 5);
    sm1.closeAll();

    release();
    await waitFor(() => two.streams.length === 1);
    expect(two.streams[0]!.opts.since).toBe(3);         // 4 and 5 are still s2's to receive
    expect(new ChannelState(seed.dir, "s2").cursor(WEAVE_ID)).toBe(3);   // and stay unread until it delivers them
    two.streams[0]!.opts.onEvent(event(4));
    await waitFor(() => got2.length === 1);
    expect(new ChannelState(seed.dir, "s2").cursor(WEAVE_ID)).toBe(4);
    sm2.closeAll();
  });

  it("opens the stream from this session's own cursor, not the machine-wide watermark", async () => {
    const state = await makeState(makeWeave(), "s1");
    await state.setLastSeq(WEAVE_ID, 5);
    const other = new ChannelState(state.dir, "s2");
    await other.setLastSeq(WEAVE_ID, 10); // another session got further while s1 was away
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, async () => {}, () => {});
    sm.start(WEAVE_ID, state.get().weaves[WEAVE_ID]!);
    await waitFor(() => streams.length === 1);
    expect(streams[0]!.opts.since).toBe(5);
    sm.closeAll();
  });

  it("folds thread.url_changed into the names cache even when the metadata refresh fails", async () => {
    const state = await makeState(makeWeave(), "s1");
    const streams: Captured[] = [];
    let failRefresh = false;
    const fake = {
      withToken: () => fake,
      getWeave: async () => { if (failRefresh) throw new Error("refresh down"); return weaveInfo(); },
      stream: (weaveId: string, opts: StreamOptions): StreamHandle => {
        const close = vi.fn();
        streams.push({ weaveId, opts, close });
        return { close, get lastSeq() { return opts.since ?? 0; } };
      },
    };
    const got: { content: string; meta: Record<string, string> }[] = [];
    const sm = new StreamManager(fake as unknown as LoomClient, state, async (p) => { got.push(p); }, () => {});
    sm.start(WEAVE_ID, state.get().weaves[WEAVE_ID]!);
    await waitFor(() => streams.length === 1);
    failRefresh = true;   // every later refresh fails; the cursor still advances, so the cache must not go stale
    streams[0]!.opts.onEvent(event(4, { threadId: "t1", type: "thread.url_changed", payload: { threadId: "t1", url: "https://e.com/pr/9" } }));
    streams[0]!.opts.onEvent(event(5, { threadId: "t1", payload: { text: "look @Claude", mentions: ["p1"] } }));
    await waitFor(() => got.length === 2);
    expect(got[0]!.content).toContain("https://e.com/pr/9");
    expect(got[1]!.meta.thread_url).toBe("https://e.com/pr/9");
    sm.closeAll();
  });

  it("delivers events in order and persists lastSeq", async () => {
    const w = makeWeave();
    const state = await makeState(w);
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
    const state = await makeState(w);
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
    const state = await makeState(w);
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
    const state = await makeState(w);
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
    const state = await makeState(w);
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

  it("noteThread ignores a weave with no active entry, so there is nothing stop() forgot to clean up", async () => {
    const w = makeWeave();
    const state = await makeState(w);
    const notify = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const { client } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, log);
    // Never started (or already stopped): no Active entry exists for WEAVE_ID.
    sm.noteThread(WEAVE_ID, "t-new");
    expect(sm.threadOwner("t-new")).toBeUndefined();
  });

  it("grows the restart backoff exponentially across consecutive restarts, caps at max, and resets to initial after a successful delivery", async () => {
    // Fake timers make this deterministic: the delay actually passed to setTimeout is asserted
    // directly (by advancing exactly up to, then past, each threshold) instead of measuring
    // wall-clock gaps, which is flaky under real scheduling jitter.
    vi.useFakeTimers();
    try {
      const w = makeWeave();
      const state = await makeState(w);
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
    const state = await makeState(w);
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
        return weaveInfo([{ id: "t2", weaveId: WEAVE_ID, name: "New", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null, url: null }]);
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

  it("schedules a restart when opening the stream itself throws, instead of leaving the weave silently disconnected", async () => {
    const w = makeWeave();
    const state = await makeState(w);
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const streams: Captured[] = [];
    let throwOnce = true;
    const fake = {
      withToken: () => fake,
      getWeave: async () => weaveInfo(),
      stream: (weaveId: string, opts: StreamOptions): StreamHandle => {
        if (throwOnce) { throwOnce = false; throw new Error("connect refused"); }
        const close = vi.fn();
        streams.push({ weaveId, opts, close });
        return { close, get lastSeq() { return opts.since ?? 0; } };
      },
    };
    const sm = new StreamManager(fake as unknown as LoomClient, state, notify, log, { initial: 20, max: 80 });
    sm.start(WEAVE_ID, w);

    // The throw is reported (redacted, via the manager's log) rather than escaping to the global
    // unhandledRejection handler, and the weave is retried from the persisted cursor.
    await waitFor(() => log.mock.calls.some(([m]) => /weave w1/.test(String(m))));
    await waitFor(() => streams.length === 1);
    expect(streams[0]!.opts.since).toBe(3);

    streams[0]!.opts.onEvent(event(4));
    await waitFor(() => state.get().weaves[WEAVE_ID]?.lastSeq === 4);
    sm.stop(WEAVE_ID);
  });

  it("stop() while the initial name refresh is still pending opens no stream and delivers nothing", async () => {
    const w = makeWeave();
    const state = await makeState(w);
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const streams: Captured[] = [];
    let releaseRefresh: (() => void) | undefined;
    const fake = {
      withToken: () => fake,
      getWeave: async (): Promise<WeaveInfo> => { await new Promise<void>((res) => { releaseRefresh = res; }); return weaveInfo(); },
      stream: (weaveId: string, opts: StreamOptions): StreamHandle => {
        const close = vi.fn();
        streams.push({ weaveId, opts, close });
        return { close, get lastSeq() { return opts.since ?? 0; } };
      },
    };
    const sm = new StreamManager(fake as unknown as LoomClient, state, notify, log);
    sm.start(WEAVE_ID, w);
    await waitFor(() => releaseRefresh !== undefined);

    sm.stop(WEAVE_ID);
    releaseRefresh!();
    await new Promise((r) => setTimeout(r, 30));

    expect(streams).toHaveLength(0); // the stopped entry is never resurrected into a live stream
    expect(notify).not.toHaveBeenCalled();
  });

  it("closes the handle when a terminal close fires synchronously from stream(), before `handle` could be assigned", async () => {
    const w = makeWeave();
    const state = await makeState(w);
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const streams: Captured[] = [];
    let failOnce = true;
    const fake = {
      withToken: () => fake,
      getWeave: async () => weaveInfo(),
      stream: (weaveId: string, opts: StreamOptions): StreamHandle => {
        const close = vi.fn();
        streams.push({ weaveId, opts, close });
        // The real client can report a terminal failure from inside stream() itself; at that moment
        // `entry.handle` is still unassigned, so the handle this call returns would leak.
        if (failOnce) { failOnce = false; opts.onStatus?.("closed", { error: new LoomClientError("network", "boom") }); }
        return { close, get lastSeq() { return opts.since ?? 0; } };
      },
    };
    // A long backoff keeps the scheduled restart from firing during the test: the handle must be
    // closed by start() itself, not incidentally by the next restart's stop().
    const sm = new StreamManager(fake as unknown as LoomClient, state, notify, log, { initial: 5_000, max: 5_000 });
    sm.start(WEAVE_ID, w);

    await waitFor(() => streams.length === 1);
    await waitFor(() => streams[0]!.close.mock.calls.length === 1);
    expect(streams).toHaveLength(1); // the restart is still pending behind the backoff
    sm.stop(WEAVE_ID);
  });

  it("after stop(), a non-General thread no longer resolves but the General thread still does via the persisted state fallback, until the Weave is removed from state entirely", async () => {
    const w = makeWeave();
    const state = await makeState(w);
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

    await state.removeWeave(WEAVE_ID); // simulates leave_weave, which removes the Weave from state too
    expect(sm.threadOwner(w.generalThreadId)).toBeUndefined();
  });
});

const GUIDE = "## Loom guidelines\nbe brief";
type Notification = { content: string; meta: Record<string, string> };

/** Starts a manager whose notifications are collected, and waits until its first stream is open. */
async function started(
  opts: { guidelines?: () => string; failTimes?: number; backoff?: { initial: number; max: number } } = {},
): Promise<{ sm: StreamManager; state: ChannelState; streams: Captured[]; got: Notification[]; getWeaveCalls: () => number }> {
  const w = makeWeave();
  const state = await makeState(w);
  const got: Notification[] = [];
  const { client, streams, getWeaveCalls } = makeFakeClient(opts);
  const sm = new StreamManager(client, state, async (p) => { got.push(p); }, () => {}, opts.backoff);
  sm.start(WEAVE_ID, w);
  if (!opts.failTimes) await waitFor(() => streams.length === 1);
  return { sm, state, streams, got, getWeaveCalls };
}

describe("guidelines preamble", () => {
  it("(a) folds the current guidelines into the first woken event of a session, and only that one", async () => {
    const { sm, state, streams, got } = await started({ guidelines: () => GUIDE });
    streams[0]!.opts.onEvent(event(4));
    streams[0]!.opts.onEvent(event(5));
    await waitFor(() => got.length === 2);
    expect(got[0]!.meta).toMatchObject({ preamble: "guidelines", type: "message", seq: "4" });
    expect(got[0]!.content).toBe(`${GUIDE}\n\n---\n\nm4`);
    expect(got[1]!.meta.preamble).toBeUndefined();
    expect(got[1]!.content).toBe("m5");
    await waitFor(() => state.get().weaves[WEAVE_ID]?.lastSeq === 5);
    sm.closeAll();
  });

  it("(b) opens no stream and delivers nothing while the metadata fetch fails, then carries the preamble once it succeeds", async () => {
    const { sm, state, streams, got, getWeaveCalls } = await started({ guidelines: () => GUIDE, failTimes: 1, backoff: { initial: 20, max: 40 } });
    await waitFor(() => getWeaveCalls() === 1);
    expect(streams).toHaveLength(0);          // the preamble is a precondition, not a nicety
    expect(got).toHaveLength(0);
    expect(state.load().sessions.s1?.cursors[WEAVE_ID]).toBe(3);  // cursor untouched by the failed attempt

    await waitFor(() => streams.length === 1);
    expect(streams[0]!.opts.since).toBe(3);   // resumes from the persisted cursor
    streams[0]!.opts.onEvent(event(4));
    streams[0]!.opts.onEvent(event(5));
    await waitFor(() => got.length === 2);
    expect(got[0]!.content).toBe(`${GUIDE}\n\n---\n\nm4`);
    expect(got[1]!.meta.preamble).toBeUndefined();
    sm.closeAll();
  });

  it("(c) an automatic restart is not a new session: the preamble is not sent again", async () => {
    const { sm, streams, got } = await started({ guidelines: () => GUIDE, backoff: { initial: 20, max: 40 } });
    streams[0]!.opts.onEvent(event(4));
    await waitFor(() => got.length === 1);
    streams[0]!.opts.onStatus?.("closed", { error: new LoomClientError("network", "boom") });
    await waitFor(() => streams.length === 2);
    streams[1]!.opts.onEvent(event(6));
    await waitFor(() => got.length === 2);
    expect(got[1]!.meta.preamble).toBeUndefined();
    expect(got[1]!.content).toBe("m6");
    sm.closeAll();
  });

  it("(d) leaving and rejoining the Weave sends the preamble again", async () => {
    const { sm, state, streams, got } = await started({ guidelines: () => GUIDE });
    streams[0]!.opts.onEvent(event(4));
    await waitFor(() => got.length === 1);
    sm.stop(WEAVE_ID);                                  // what leave_weave does
    sm.start(WEAVE_ID, state.get().weaves[WEAVE_ID]!);  // …and a fresh join right after
    await waitFor(() => streams.length === 2);
    streams[1]!.opts.onEvent(event(6));
    await waitFor(() => got.length === 2);
    expect(got[1]!.meta.preamble).toBe("guidelines");
    expect(got[1]!.content).toBe(`${GUIDE}\n\n---\n\nm6`);
    sm.closeAll();
  });

  it("(e) re-arming the same identity is not a leave: no second preamble", async () => {
    const { sm, state, streams, got } = await started({ guidelines: () => GUIDE });
    streams[0]!.opts.onEvent(event(4));
    await waitFor(() => got.length === 1);
    sm.start(WEAVE_ID, state.get().weaves[WEAVE_ID]!);  // what onJoined does for a reused identity
    await waitFor(() => streams.length === 2);
    streams[1]!.opts.onEvent(event(6));
    await waitFor(() => got.length === 2);
    expect(got[1]!.meta.preamble).toBeUndefined();
    sm.closeAll();
  });

  it("(f) empty guidelines deliver a plain first event, and still count as delivered", async () => {
    let guidelines = "";
    const { sm, streams, got } = await started({ guidelines: () => guidelines });
    streams[0]!.opts.onEvent(event(4));
    await waitFor(() => got.length === 1);
    expect(got[0]!.content).toBe("m4");
    expect(got[0]!.meta.preamble).toBeUndefined();

    guidelines = GUIDE;   // rules appear later in the session; the change event carries them
    streams[0]!.opts.onEvent(event(5, { type: "weave.guidelines_changed", payload: { guidelines: "be brief", previous: "" } }));
    streams[0]!.opts.onEvent(event(6));
    await waitFor(() => got.length === 3);
    expect(got[2]!.content).toBe("m6");                 // the flag was set by the empty first turn
    expect(got[2]!.meta.preamble).toBeUndefined();
    sm.closeAll();
  });

  it("(g) in mentions mode the preamble rides on the first event that actually wakes the session", async () => {
    const { sm, state, streams, got } = await started({ guidelines: () => GUIDE });
    await state.setPrefs(WEAVE_ID, { wake: "mentions" });
    sm.setPrefs(WEAVE_ID, state.prefs(WEAVE_ID));
    streams[0]!.opts.onEvent(event(4));                                                  // no mention: not delivered
    streams[0]!.opts.onEvent(event(5, { payload: { text: "hi @Claude", mentions: ["p1"] } }));
    await waitFor(() => got.length === 1);
    expect(got[0]!.meta).toMatchObject({ preamble: "guidelines", seq: "5" });
    expect(got[0]!.content).toBe(`${GUIDE}\n\n---\n\nhi @Claude`);
    sm.closeAll();
  });

  it("(h) a weave.guidelines_changed event refreshes the cached text a later preamble carries", async () => {
    let guidelines = GUIDE;
    const { sm, state, streams, got } = await started({ guidelines: () => guidelines });
    streams[0]!.opts.onEvent(event(4));
    await waitFor(() => got.length === 1);
    expect(got[0]!.content).toBe(`${GUIDE}\n\n---\n\nm4`);

    const UPDATED = `${GUIDE}\n\n## Guidelines for this Weave\nno emoji`;
    guidelines = UPDATED;
    streams[0]!.opts.onEvent(event(5, { type: "weave.guidelines_changed", payload: { guidelines: "no emoji", previous: "" } }));
    await waitFor(() => got.length === 2);
    expect(got[1]!.content).toBe("no emoji");

    sm.stop(WEAVE_ID);
    sm.start(WEAVE_ID, state.get().weaves[WEAVE_ID]!);
    await waitFor(() => streams.length === 2);
    streams[1]!.opts.onEvent(event(6));
    await waitFor(() => got.length === 3);
    expect(got[2]!.content).toBe(`${UPDATED}\n\n---\n\nm6`);
    sm.closeAll();
  });
});
