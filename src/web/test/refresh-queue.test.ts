import { describe, it, expect } from "vitest";
import { createRefreshQueue } from "../src/components/main/refresh-queue.js";

/** A macrotask turn. The queue's own `await`/`finally` chain is microtasks, so one turn drains it. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * A `run` that settles only when the test says so, and the three facts these tests are about: what
 * it was called with, in what order, and the high-water mark of calls in flight at once. `maxActive`
 * is sampled on every call rather than read at the end, so no test has to guess when to look.
 */
function harness<T>() {
  const order: T[] = [];
  const pending = new Map<T, { resolve: () => void; reject: (e: unknown) => void }>();
  let active = 0;
  let maxActive = 0;
  const run = (item: T): Promise<void> =>
    new Promise<void>((res, rej) => {
      order.push(item);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const done = () => { active -= 1; pending.delete(item); };
      pending.set(item, { resolve: () => { done(); res(); }, reject: (e) => { done(); rej(e); } });
    });
  /** Settles the call that has been in flight longest, and lets the queue react to the freed slot. */
  const settleOldest = async (): Promise<boolean> => {
    const [first] = [...pending.keys()];
    if (first === undefined) return false;
    pending.get(first)!.resolve();
    await flush();
    return true;
  };
  return { run, order, pending, settleOldest, maxActive: () => maxActive };
}

/**
 * Runs `fn` with vitest's own unhandled-rejection reporter detached and answers with whatever was
 * rejected while it ran. The queue swallows what `run` rejects with, and "swallowed" has to mean
 * *handled* — a rejection that merely went unreported would still be an unhandled rejection in the
 * page. Node crashes the worker with no `unhandledRejection` listener at all, hence a replacement.
 */
async function whileWatchingRejections(fn: () => Promise<void>): Promise<string[]> {
  const prior = process.rawListeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const seen: string[] = [];
  process.on("unhandledRejection", (e) => seen.push(e instanceof Error ? e.message : String(e)));
  try { await fn(); } finally {
    process.removeAllListeners("unhandledRejection");
    for (const l of prior) process.on("unhandledRejection", l as (e: unknown) => void);
  }
  return seen;
}

describe("createRefreshQueue: the bound (spec §4.2)", () => {
  it("starts no more than the limit, however much one enqueue asks for", async () => {
    const h = harness<number>();
    createRefreshQueue(2, h.run).enqueue([1, 2, 3]);
    await flush();
    expect(h.order).toEqual([1, 2]);
  });

  it("starts nothing for a later enqueue while the limit is still taken", async () => {
    // The whole reason this is a long-lived object rather than an await-the-batch helper: My Weaves
    // enqueues again on every keystroke, every "Show more" and every change signal, and each of
    // those must wait behind what is already running rather than start a fresh six beside it.
    const h = harness<number>();
    const q = createRefreshQueue(2, h.run);
    q.enqueue([1, 2, 3]);
    await flush();
    q.enqueue([4, 5, 6]);
    await flush();
    expect([h.order, h.maxActive()]).toEqual([[1, 2], 2]);
  });

  it("gives a freed slot to the item that has waited longest", async () => {
    const h = harness<number>();
    const q = createRefreshQueue(2, h.run);
    q.enqueue([1, 2, 3]);
    await flush();
    q.enqueue([4, 5, 6]);
    await h.settleOldest();
    expect(h.order).toEqual([1, 2, 3]);
  });

  it("drains what both enqueues gave it without ever exceeding the limit", async () => {
    const h = harness<number>();
    const q = createRefreshQueue(2, h.run);
    q.enqueue([1, 2, 3]);
    await flush();
    q.enqueue([4, 5, 6]);
    while (await h.settleOldest()) { /* one at a time, so the order below is the queue's own */ }
    expect([h.order, h.maxActive()]).toEqual([[1, 2, 3, 4, 5, 6], 2]);
  });

  it("runs items in the order they were enqueued, across enqueues", async () => {
    const h = harness<string>();
    const q = createRefreshQueue(1, h.run);
    q.enqueue(["a", "b"]);
    q.enqueue(["c"]);
    while (await h.settleOldest()) { /* … */ }
    expect(h.order).toEqual(["a", "b", "c"]);
  });
});

describe("createRefreshQueue: a run that rejects (spec §4.2)", () => {
  it("frees the slot that run held", async () => {
    const h = harness<number>();
    createRefreshQueue(1, h.run).enqueue([1, 2]);
    await whileWatchingRejections(async () => {
      h.pending.get(1)!.reject(new Error("boom"));
      await flush();
    });
    expect(h.order).toEqual([1, 2]);
  });

  it("leaves no unhandled rejection behind in the page", async () => {
    const h = harness<number>();
    createRefreshQueue(1, h.run).enqueue([1, 2]);
    const seen = await whileWatchingRejections(async () => {
      h.pending.get(1)!.reject(new Error("boom"));
      await flush();
    });
    expect(seen).toEqual([]);
  });

  it("answers enqueue synchronously, with nothing, whatever run goes on to do", () => {
    const h = harness<number>();
    expect(createRefreshQueue(1, h.run).enqueue([1, 2])).toBeUndefined();
  });
});

describe("createRefreshQueue: dispose (spec §4.2)", () => {
  it("drops what has not started", async () => {
    const h = harness<number>();
    const q = createRefreshQueue(1, h.run);
    q.enqueue([1, 2, 3]);
    q.dispose();
    await flush();
    expect(h.order).toEqual([1]);
  });

  it("starts nothing behind a run that finishes after it", async () => {
    const h = harness<number>();
    const q = createRefreshQueue(1, h.run);
    q.enqueue([1, 2, 3]);
    q.dispose();
    await h.settleOldest();
    expect(h.order).toEqual([1]);
  });

  it("accepts nothing new afterwards", async () => {
    const h = harness<number>();
    const q = createRefreshQueue(1, h.run);
    q.enqueue([1, 2, 3]);
    q.dispose();
    await h.settleOldest();
    q.enqueue([4]);
    await flush();
    expect(h.order).toEqual([1]);
  });
});

describe("createRefreshQueue: draining (spec §4.2)", () => {
  it("runs every item it was given, in order, within the limit", async () => {
    const h = harness<number>();
    createRefreshQueue(2, h.run).enqueue([1, 2, 3, 4, 5, 6, 7]);
    while (await h.settleOldest()) { /* … */ }
    expect([h.order, h.maxActive()]).toEqual([[1, 2, 3, 4, 5, 6, 7], 2]);
  });

  it("is idle rather than finished once it has drained", async () => {
    const h = harness<number>();
    const q = createRefreshQueue(2, h.run);
    q.enqueue([1, 2, 3, 4, 5, 6, 7]);
    while (await h.settleOldest()) { /* … */ }
    q.enqueue([8]);
    await flush();
    expect(h.order).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
