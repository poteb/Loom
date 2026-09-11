import { describe, it, expect } from "vitest";
import { completeMention, applyMention, clampSelection } from "../src/components/mention-logic.js";

const names = ["Claude", "ChatGPT", "Paw"];

describe("completeMention", () => {
  it("finds an @ query at the caret", () => {
    expect(completeMention("hi @cl", 6, names)).toEqual({ query: "cl", start: 3 });
    expect(completeMention("hi @", 4, names)).toEqual({ query: "", start: 3 });
  });
  it("returns null when not in a mention or the @ is part of an email", () => {
    expect(completeMention("hi there", 8, names)).toBeNull();
    expect(completeMention("me@claude", 9, names)).toBeNull();
    expect(completeMention("hi @cl x", 8, names)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the query with @name and a trailing space, and moves the caret", () => {
    expect(applyMention("hi @cl there", 3, 6, "Claude")).toEqual({ text: "hi @Claude  there", caret: 11 });
    expect(applyMention("@", 0, 1, "Paw")).toEqual({ text: "@Paw ", caret: 5 });
  });
});

describe("clampSelection", () => {
  it("keeps the highlight inside the current suggestion list", () => {
    expect(clampSelection(0, 3)).toBe(0);
    expect(clampSelection(2, 3)).toBe(2);
    // The list shrank under a highlight that was valid for the previous query.
    expect(clampSelection(5, 3)).toBe(2);
    expect(clampSelection(1, 1)).toBe(0);
  });
  it("returns 0 when there is nothing to select", () => {
    expect(clampSelection(0, 0)).toBe(0);
    expect(clampSelection(4, 0)).toBe(0);
  });
  it("never returns a negative index", () => {
    expect(clampSelection(-1, 3)).toBe(0);
    expect(clampSelection(-9, 0)).toBe(0);
  });
});
