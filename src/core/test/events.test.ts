import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { weaves, threads } from "../src/db/schema.js";
import { EventBus } from "../src/bus.js";
import { withWeaveLock, readEvents, appendInTx } from "../src/events.js";
import { newId, newSecret } from "../src/ids.js";
import type { Db } from "../src/db/index.js";
import type { LoomEvent } from "../src/types.js";

afterAll(closeTestDb);

let db: Db;
let weaveId: string;
let threadId: string;

beforeEach(async () => {
  db = await freshDb();
  weaveId = newId(); threadId = newId();
  await db.insert(weaves).values({ id: weaveId, secret: newSecret(), title: "t" });
  await db.insert(threads).values({ id: threadId, weaveId, name: "General", isGeneral: true, createdBy: "x" });
});

describe("EventBus", () => {
  it("delivers only to subscribers of that weave and supports unsubscribe", () => {
    const bus = new EventBus();
    const got: string[] = [];
    const off = bus.subscribe("w1", (e) => got.push(`a${e.seq}`));
    bus.subscribe("w2", (e) => got.push(`b${e.seq}`));
    const ev = (weaveId: string, seq: number): LoomEvent =>
      ({ weaveId, seq, threadId: "t", type: "message", actor: "p", at: new Date().toISOString(), payload: {} });
    bus.publish(ev("w1", 1));
    off();
    bus.publish(ev("w1", 2));
    bus.publish(ev("w2", 1));
    expect(got).toEqual(["a1", "b1"]);
  });
});

describe("withWeaveLock + appendInTx", () => {
  it("assigns gap-free seq and publishes after commit", async () => {
    const bus = new EventBus();
    const published: number[] = [];
    bus.subscribe(weaveId, (e) => published.push(e.seq));
    const r = await withWeaveLock(db, bus, weaveId, async () => ({
      result: "ok",
      events: [
        { threadId, type: "message", actor: "p", payload: { text: "a" } },
        { threadId, type: "message", actor: "p", payload: { text: "b" } },
      ],
    }));
    expect(r).toBe("ok");
    expect(published).toEqual([1, 2]);
    const rows = await readEvents(db, weaveId, {});
    expect(rows.map((e) => e.seq)).toEqual([1, 2]);
    const [w] = await db.select().from(weaves);
    expect(w!.lastSeq).toBe(2);
  });

  it("serializes concurrent writers: 20 parallel appends yield seq 1..20 with no gaps", async () => {
    const bus = new EventBus();
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      withWeaveLock(db, bus, weaveId, async () => ({
        result: null,
        events: [{ threadId, type: "message", actor: "p", payload: { i } }],
      }))));
    const rows = await readEvents(db, weaveId, {});
    expect(rows.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("does not publish when the transaction fails", async () => {
    const bus = new EventBus();
    let n = 0; bus.subscribe(weaveId, () => n++);
    await expect(withWeaveLock(db, bus, weaveId, async (tx, weave) => {
      await appendInTx(tx, weave, [{ threadId, type: "message", actor: "p", payload: {} }]);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(n).toBe(0);
    expect(await readEvents(db, weaveId, {})).toEqual([]);
  });

  it("throws weave_not_found for unknown weave", async () => {
    await expect(withWeaveLock(db, new EventBus(), newId(), async () => ({ result: 1, events: [] })))
      .rejects.toMatchObject({ code: "weave_not_found" });
  });
});

describe("readEvents", () => {
  it("filters by since, thread, and limit", async () => {
    const bus = new EventBus();
    const other = newId();
    await db.insert(threads).values({ id: other, weaveId, name: "Other", createdBy: "x" });
    await withWeaveLock(db, bus, weaveId, async () => ({
      result: null,
      events: [
        { threadId, type: "message", actor: "p", payload: { n: 1 } },
        { threadId: other, type: "message", actor: "p", payload: { n: 2 } },
        { threadId, type: "message", actor: "p", payload: { n: 3 } },
      ],
    }));
    expect((await readEvents(db, weaveId, { since: 1 })).map((e) => e.seq)).toEqual([2, 3]);
    expect((await readEvents(db, weaveId, { threadId: other })).map((e) => e.seq)).toEqual([2]);
    expect((await readEvents(db, weaveId, { limit: 2 })).map((e) => e.seq)).toEqual([1, 2]);
  });
});
