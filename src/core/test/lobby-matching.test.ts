import { describe, it, expect } from "vitest";
import { LoomError } from "../src/errors.js";
import { admits, eligible, matches, validateRequirements } from "../src/lobby/matching.js";
import type { Profile, Requirements } from "../src/lobby/matching.js";

/** The code a call rejects with, or undefined when it is accepted. */
const codeOf = (fn: () => void): string | undefined => {
  try { fn(); return undefined; } catch (e) { return (e as LoomError).code; }
};

const listener: Profile = {
  models: [{ model: "gpt-5.6-sol", effort: "high" }],
  tools: ["github"],
  runtime: "codex-cli",
  spawnsSubagents: true,
  owner: "paw",
};

describe("validateRequirements", () => {
  it("accepts empty requirements", () => {
    expect(validateRequirements({})).toEqual({});
  });

  it("passes a valid value through, trimmed", () => {
    expect(validateRequirements({
      models: [{ model: "  gpt-5.6-sol  ", effort: " high " }],
      tools: [" github "],
      runtime: " codex-cli ",
      spawnsSubagents: true,
    })).toEqual({
      models: [{ model: "gpt-5.6-sol", effort: "high" }],
      tools: ["github"],
      runtime: "codex-cli",
      spawnsSubagents: true,
    });
  });

  it("rejects an unknown key", () => {
    expect(codeOf(() => validateRequirements({ tools: ["github"], anyOf: [] }))).toBe("validation");
  });

  it("rejects more than 20 model alternatives", () => {
    const model = (i: number) => ({ model: `model-${i}` });
    expect(codeOf(() => validateRequirements({ models: Array.from({ length: 20 }, (_, i) => model(i)) }))).toBeUndefined();
    expect(codeOf(() => validateRequirements({ models: Array.from({ length: 21 }, (_, i) => model(i)) }))).toBe("validation");
  });

  it("rejects an empty models list", () => {
    expect(codeOf(() => validateRequirements({ models: [] }))).toBe("validation");
  });

  it("rejects an empty model name", () => {
    expect(codeOf(() => validateRequirements({ models: [{ model: "   " }] }))).toBe("validation");
  });

  it("rejects an unknown key inside a model alternative", () => {
    expect(codeOf(() => validateRequirements({ models: [{ model: "gpt-5.6-sol", thinking: "high" }] }))).toBe("validation");
  });

  it("rejects a tool that is not a non-empty string", () => {
    expect(codeOf(() => validateRequirements({ tools: [42] }))).toBe("validation");
    expect(codeOf(() => validateRequirements({ tools: [""] }))).toBe("validation");
  });

  it("rejects more than 50 tools", () => {
    expect(codeOf(() => validateRequirements({ tools: Array.from({ length: 51 }, (_, i) => `tool-${i}`) }))).toBe("validation");
  });

  it("throws a LoomError naming the offending path", () => {
    try {
      validateRequirements({ runtime: "" });
      expect.unreachable("validateRequirements should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LoomError);
      expect((e as LoomError).message).toContain("requirements.runtime");
    }
  });
});

describe("matches", () => {
  it("matches any profile when the requirements are empty", () => {
    expect(matches({}, {})).toBe(true);
    expect(matches(listener, {})).toBe(true);
  });

  it("treats models as alternatives: any one is enough", () => {
    expect(matches(listener, { models: [{ model: "claude-opus-5", effort: "high" }, { model: "gpt-5.6-sol", effort: "high" }] })).toBe(true);
  });

  it("fails when no model alternative is offered", () => {
    expect(matches(listener, { models: [{ model: "claude-opus-5" }, { model: "gemini-4" }] })).toBe(false);
  });

  it("matches any effort when the requirement omits one", () => {
    expect(matches(listener, { models: [{ model: "gpt-5.6-sol" }] })).toBe(true);
  });

  it("requires the named effort when the requirement gives one", () => {
    expect(matches(listener, { models: [{ model: "gpt-5.6-sol", effort: "medium" }] })).toBe(false);
  });

  it("fails a model requirement when the profile lists no models", () => {
    expect(matches({}, { models: [{ model: "gpt-5.6-sol" }] })).toBe(false);
  });

  it("requires every tool", () => {
    expect(matches(listener, { tools: ["github"] })).toBe(true);
    expect(matches(listener, { tools: ["github", "web"] })).toBe(false);
  });

  it("requires an equal runtime when one is named", () => {
    expect(matches(listener, { runtime: "codex-cli" })).toBe(true);
    expect(matches(listener, { runtime: "claude-code" })).toBe(false);
  });

  it("requires an equal spawnsSubagents when one is named", () => {
    expect(matches(listener, { spawnsSubagents: true })).toBe(true);
    expect(matches(listener, { spawnsSubagents: false })).toBe(false);
  });
});

describe("admits", () => {
  it("admits every owner when serves is \"anyone\"", () => {
    expect(admits({ owner: "paw", serves: "anyone" }, "bob")).toBe(true);
  });

  it("admits its own owner when serves is \"owner\"", () => {
    expect(admits({ owner: "paw", serves: "owner" }, "paw")).toBe(true);
  });

  it("refuses another owner when serves is \"owner\"", () => {
    expect(admits({ owner: "paw", serves: "owner" }, "bob")).toBe(false);
  });

  it("treats a missing serves as \"owner\"", () => {
    expect(admits({ owner: "paw" }, "paw")).toBe(true);
    expect(admits({ owner: "paw" }, "bob")).toBe(false);
  });

  it("admits an owner the list includes", () => {
    expect(admits({ owner: "paw", serves: ["bob", "ann"] }, "ann")).toBe(true);
  });

  it("refuses an owner the list omits", () => {
    expect(admits({ owner: "paw", serves: ["bob", "ann"] }, "carl")).toBe(false);
  });

  it("admits the empty owner only through \"anyone\"", () => {
    expect(admits({ owner: "", serves: "anyone" }, "")).toBe(true);
    expect(admits({ owner: "", serves: "owner" }, "")).toBe(false);
    expect(admits({ owner: "", serves: [""] }, "")).toBe(false);
  });
});

describe("eligible", () => {
  const req: Requirements = { tools: ["github"] };

  it("is never eligible without a profile", () => {
    expect(eligible(null, req, "paw")).toBe(false);
  });

  it("is eligible when the profile both matches and admits", () => {
    expect(eligible(listener, req, "paw")).toBe(true);
  });

  it("is not eligible when the profile matches but does not admit", () => {
    expect(eligible(listener, req, "bob")).toBe(false);
  });

  it("is not eligible when the profile admits but does not match", () => {
    expect(eligible(listener, { tools: ["github", "web"] }, "paw")).toBe(false);
  });
});
