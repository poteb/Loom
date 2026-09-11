import { describe, it, expect } from "vitest";
import { resolveBaseUrl, toWsUrl } from "../src/url.js";
import { LoomClientError } from "../src/errors.js";

describe("resolveBaseUrl", () => {
  it("accepts https and strips trailing slash", () => {
    expect(resolveBaseUrl("https://loom.example.com/")).toBe("https://loom.example.com");
    expect(resolveBaseUrl("https://loom.example.com/base/")).toBe("https://loom.example.com/base");
  });
  it("rejects http by default, even on localhost", () => {
    for (const u of ["http://loom.example.com", "http://localhost:3000", "http://127.0.0.1:3000"]) {
      expect(() => resolveBaseUrl(u)).toThrow(LoomClientError);
      try { resolveBaseUrl(u); } catch (e) { expect((e as LoomClientError).code).toBe("insecure_url"); }
    }
  });
  it("allows http only on loopback when allowInsecure is set", () => {
    expect(resolveBaseUrl("http://localhost:3000", true)).toBe("http://localhost:3000");
    expect(resolveBaseUrl("http://127.0.0.1:3000/", true)).toBe("http://127.0.0.1:3000");
    expect(resolveBaseUrl("http://[::1]:3000", true)).toBe("http://[::1]:3000");
    expect(() => resolveBaseUrl("http://loom.example.com", true)).toThrow(LoomClientError);
  });
  it("rejects garbage and other schemes", () => {
    expect(() => resolveBaseUrl("not a url")).toThrow(LoomClientError);
    expect(() => resolveBaseUrl("ftp://x")).toThrow(LoomClientError);
  });
});

describe("toWsUrl", () => {
  it("maps schemes", () => {
    expect(toWsUrl("https://loom.example.com")).toBe("wss://loom.example.com");
    expect(toWsUrl("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000");
  });
});
