import { describe, it, expect } from "vitest";
import { cadenceOf } from "../src/lobby/status.js";

describe("cadenceOf (spec 2026-09-27 §4.4)", () => {
  const T = Date.parse("2026-09-27T10:00:00.000Z");
  /** Check-ins at T and then after each gap in turn, oldest first, as `seen_history` stores them. */
  const history = (gaps: number[]): Date[] =>
    gaps.reduce<Date[]>((out, g) => [...out, new Date(out.at(-1)!.getTime() + g)], [new Date(T)]);

  it("fewer than two check-ins gives null gaps", () => {
    expect([cadenceOf(null), cadenceOf([]), cadenceOf([new Date(T)])]).toEqual([
      { typicalGapMs: null, longestGapMs: null, samples: 0 },
      { typicalGapMs: null, longestGapMs: null, samples: 0 },
      { typicalGapMs: null, longestGapMs: null, samples: 1 },
    ]);
  });

  it("twenty check-ins give nineteen gaps", () => {
    // 11 000 to 29 000 ms in steps of 1 000, shuffled (7 is coprime with 19): the median must be sorted for.
    const gaps = Array.from({ length: 19 }, (_, i) => 11_000 + ((i * 7) % 19) * 1_000);
    expect(cadenceOf(history(gaps))).toEqual({ typicalGapMs: 20_000, longestGapMs: 29_000, samples: 20 });
  });

  it("an even number of gaps takes the floor of the mean of the two middle ones", () => {
    // Sorted 11 000, 20 001, 20 004, 40 000: the mean of the middle two is 20 002.5.
    expect(cadenceOf(history([40_000, 20_001, 11_000, 20_004]))).toEqual({ typicalGapMs: 20_002, longestGapMs: 40_000, samples: 5 });
  });
});
