import { describe, it, expect } from "vitest";
import type { EventType, LoomEvent } from "@loom/client";
import { foldStream, runSummary, timeRange } from "../src/components/fold.js";

let seq = 0;
const ev = (type: EventType, at = "2026-09-24T13:07:09.000Z"): LoomEvent =>
  ({ weaveId: "w1", seq: ++seq, threadId: "g1", type, actor: "p1", at, payload: {} });
const msg = (at?: string) => ev("message", at);
const joined = (at?: string) => ev("participant.joined", at);
const profile = (at?: string) => ev("participant.capabilities_changed", at);
const invited = (at?: string) => ev("thread.invited", at);
/** An item as a short word, so a whole stream reads as one line in an assertion. */
const shape = (items: ReturnType<typeof foldStream>) =>
  items.map((i) => (i.kind === "run" ? `run(${i.events.length})` : i.kind));

describe("foldStream", () => {
  it("folds two or more consecutive system events into one run", () => {
    expect(shape(foldStream([joined(), joined(), profile()], true))).toEqual(["run(3)"]);
  });

  it("leaves a single system event as it is", () => {
    expect(shape(foldStream([msg(), joined(), msg()], true))).toEqual(["message", "system", "message"]);
  });

  it("lets a message break a run in two", () => {
    expect(shape(foldStream([joined(), joined(), msg(), profile(), profile(), profile(), msg(), joined()], true)))
      .toEqual(["run(2)", "message", "run(3)", "message", "system"]);
  });

  it("keeps every event, in order, inside the runs", () => {
    const events = [joined(), profile(), msg(), invited()];
    const flat = foldStream(events, true).flatMap((i) => (i.kind === "run" ? i.events : [i.event]));
    expect(flat).toEqual(events);
  });

  it("keys a run by its first event, so a run that grows keeps its key", () => {
    const a = joined(); const b = joined(); const c = profile();
    const before = foldStream([a, b], true)[0]!;
    const after = foldStream([a, b, c], true)[0]!;
    expect([before.key, after.key]).toEqual([a.seq, a.seq]);
  });

  it("folds nothing when folding is off: every system event is its own line", () => {
    expect(shape(foldStream([joined(), joined(), msg(), profile()], false))).toEqual(["system", "system", "message", "system"]);
  });

  it("returns nothing for no events", () => {
    expect(foldStream([], true)).toEqual([]);
  });
});

describe("runSummary", () => {
  it("counts a run by kind, in the order each kind first appears", () => {
    const run = [joined(), profile(), joined(), invited(), ...Array.from({ length: 9 }, () => profile()), joined()];
    expect(runSummary(run)).toEqual(["3 joined", "10 profile updates", "1 invited"]);
  });

  it("uses the singular for one of a counted noun", () => {
    expect(runSummary([profile(), ev("thread.created"), ev("request.offered"), ev("request.offered")]))
      .toEqual(["1 profile update", "1 thread created", "2 offers"]);
  });

  it("names a kind it has no word for by its event type", () => {
    expect(runSummary([ev("weave.archived"), ev("some.new_event" as EventType)])).toEqual(["1 weave archived", "1 some.new_event"]);
  });
});

describe("timeRange", () => {
  const hms = (iso: string) => iso.slice(11, 19);

  it("spans the first to the last event", () => {
    expect(timeRange([joined("2026-09-24T13:07:09.000Z"), joined("2026-09-24T13:07:10.000Z"), profile("2026-09-24T13:07:11.000Z")], hms))
      .toBe("13:07:09-13:07:11");
  });

  it("is one time when both ends read the same", () => {
    expect(timeRange([joined("2026-09-24T13:07:09.100Z"), joined("2026-09-24T13:07:09.900Z")], hms)).toBe("13:07:09");
  });

  it("defaults to the browser's clock", () => {
    const a = "2026-09-24T13:07:09.000Z"; const b = "2026-09-24T14:00:00.000Z";
    expect(timeRange([joined(a), joined(b)]))
      .toBe(`${new Date(a).toLocaleTimeString()}-${new Date(b).toLocaleTimeString()}`);
  });
});
