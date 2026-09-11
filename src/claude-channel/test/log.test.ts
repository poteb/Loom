import { describe, it, expect, vi, afterEach } from "vitest";
import { redact, log } from "../src/log.js";

const TOKEN = "t".repeat(43);

describe("redact", () => {
  it("removes 43-char token-shaped runs and URL credentials", () => {
    const out = redact(`token=${TOKEN} url=postgres://u:hunter2@h/db`);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("hunter2");
    expect(out).toBe("token=[redacted] url=postgres://[redacted]@h/db");
  });

  it("leaves ordinary text untouched", () => {
    expect(redact("hello world, weave abc123 joined")).toBe("hello world, weave abc123 joined");
  });
});

describe("log", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("writes a redacted, prefixed line to stderr and never emits the raw secret", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log(`leaked token ${TOKEN} and postgres://u:hunter2@h/db`);
    expect(spy).toHaveBeenCalledTimes(1);
    const written = spy.mock.calls[0]![0] as string;
    expect(written).toBe(`loom channel: leaked token [redacted] and postgres://[redacted]@h/db\n`);
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain("hunter2");
  });
});
