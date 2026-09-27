import { describe, it, expect } from "vitest";
import type { Profile } from "@loom/client";
import { durationText, rateText } from "../src/components/listeners/listener-status.js";

const none = { typicalGapMs: null, longestGapMs: null, samples: 0 };
/** A stored profile whose `pollIntervalMs` is not a number reads as declaring none. */
const notANumber = { owner: "a", pollIntervalMs: "5 min" } as unknown as Profile;

describe("rateText and durationText (spec 2026-09-27 §6.3)", () => {
  it("writes each of the four forms", () => {
    expect([
      rateText({ typicalGapMs: 300_000, longestGapMs: 2_400_000, samples: 20 }, { owner: "a", pollIntervalMs: 300_000 }),
      rateText(none, { owner: "a", pollIntervalMs: 300_000 }),
      rateText({ typicalGapMs: 720_000, longestGapMs: 1_800_000, samples: 8 }, { owner: "a" }),
      rateText(none, notANumber),
    ]).toEqual([
      "every ~5 min (declares 5 min), longest 40 min",
      "rate unknown (declares 5 min)",
      "every ~12 min (no declared interval), longest 30 min",
      "rate unknown (no declared interval)",
    ]);
  });

  it("rounds at the edges: 89 s, 90 s, 89 min, 90 min", () => {
    expect([durationText(89_000), durationText(90_000), durationText(5_340_000), durationText(5_400_000)])
      .toEqual(["89 s", "2 min", "89 min", "2 h"]);
  });

  it("writes no 0 at the floors a gap and a declared interval can reach", () => {
    expect([durationText(10_001), durationText(60_000)]).toEqual(["10 s", "60 s"]);
  });
});
