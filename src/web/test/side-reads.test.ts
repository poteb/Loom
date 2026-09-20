import { describe, it, expect } from "vitest";
import { createCounter, isCurrent, type Now, type Stamp } from "../src/side-reads.js";

const STAMP: Stamp = { id: "p1", token: "t1", generation: 3, n: 5 };
const NOW: Now = { generation: 3, meId: "p1", meToken: "t1", applied: 4 };
const now = (over: Partial<Now> = {}): Now => ({ ...NOW, ...over });

describe("createCounter", () => {
  it("hands out request numbers from one, in the order the reads start", () => {
    const c = createCounter();
    expect([c.next(), c.next(), c.next()]).toEqual([1, 2, 3]);
  });

  it("starts with nothing applied, so the first answer of all is newer than the watermark", () => {
    expect(createCounter().applied()).toBe(0);
  });

  it("remembers the newest answer that was acted on", () => {
    const c = createCounter();
    c.markApplied(2);
    expect(c.applied()).toBe(2);
  });
});

describe("isCurrent (spec §3.3)", () => {
  it("accepts an answer for this generation and this identity that is newer than the last applied", () => {
    expect(isCurrent(STAMP, now())).toBe(true);
  });

  it("refuses one whose generation has been retired", () => {
    expect(isCurrent(STAMP, now({ generation: 4 }))).toBe(false);
  });

  it("refuses one read for a different participant", () => {
    expect(isCurrent(STAMP, now({ meId: "p2" }))).toBe(false);
  });

  it("refuses one read with a different token of the same participant", () => {
    // A rejoin under the same name is refused, so in practice a new identity carries a new id — but
    // the token is the thing being invalidated, and it is compared for exactly that reason.
    expect(isCurrent(STAMP, now({ meToken: "t2" }))).toBe(false);
  });

  it("refuses an answer — or a rejection — no newer than the one already acted on", () => {
    expect([isCurrent(STAMP, now({ applied: 5 })), isCurrent(STAMP, now({ applied: 6 }))]).toEqual([false, false]);
  });

  it("refuses one when the session holds no identity at all", () => {
    expect(isCurrent(STAMP, { generation: 3, applied: 4 })).toBe(false);
  });
});
