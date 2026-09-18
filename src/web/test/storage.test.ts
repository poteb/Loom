import { describe, it, expect, afterEach } from "vitest";
import { browserStorage, memoryStorage } from "../src/storage.js";

type Mode = "ok" | "throw" | "silent";

/** A localStorage that can refuse writes (blocked site data) or accept them and keep nothing. */
function installLocalStorage() {
  const raw = new Map<string, string>();
  let mode: Mode = "ok";
  const api = {
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (mode === "throw") throw new Error("QuotaExceededError");
      if (mode === "silent") return;                       // accepts the call, stores nothing
      raw.set(k, v);
    },
    removeItem: (k: string) => {
      if (mode === "throw") throw new Error("blocked");
      if (mode === "silent") return;
      raw.delete(k);
    },
    key: (i: number) => [...raw.keys()][i] ?? null,
    get length() { return raw.size; },
    clear: () => raw.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: api, configurable: true, writable: true });
  return { raw, api, setMode: (m: Mode) => { mode = m; } };
}
afterEach(() => { Reflect.deleteProperty(globalThis as object, "localStorage"); });

describe("memoryStorage", () => {
  it("reports durable by default and memory when told it is a fallback", () => {
    expect(memoryStorage().set("k", "v")).toBe("durable");
    expect(memoryStorage({ durable: false }).set("k", "v")).toBe("memory");
  });
});

describe("browserStorage write verdict", () => {
  it("is durable when the value reads back from localStorage", () => {
    installLocalStorage();
    expect(browserStorage().set("k", "v")).toBe("durable");
  });

  it("is memory when setItem throws, and the value is still readable", () => {
    const ls = installLocalStorage();
    ls.setMode("throw");
    const s = browserStorage();
    expect(s.set("k", "v")).toBe("memory");
    expect(s.get("k")).toBe("v");
    expect(ls.raw.has("k")).toBe(false);
  });

  it("is memory when setItem accepts the call and stores nothing", () => {
    const ls = installLocalStorage();
    ls.setMode("silent");
    const s = browserStorage();
    expect(s.set("k", "v")).toBe("memory");     // a 'did not throw' check would say durable here
    expect(s.get("k")).toBe("v");
  });

  it("judges each key on its own", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    ls.setMode("throw");
    expect(s.set("a", "1")).toBe("memory");
    ls.setMode("ok");
    expect(s.set("b", "2")).toBe("durable");
  });
});

describe("browserStorage read precedence", () => {
  it("a failed update to an existing durable key reads back the NEW value", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    expect(s.set("k", "old")).toBe("durable");
    ls.setMode("throw");
    expect(s.set("k", "new")).toBe("memory");
    expect(s.get("k")).toBe("new");
    expect(ls.raw.get("k")).toBe("old");        // the browser still holds the old one; the page does not
  });

  it("a failed remove of an existing durable key reads as absent and leaves keys()", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "v");
    ls.setMode("throw");
    s.remove("k");
    expect(s.get("k")).toBeNull();
    expect(s.keys()).not.toContain("k");
    expect(ls.raw.get("k")).toBe("v");
  });

  it("keys() includes a key that exists only as an override", () => {
    const ls = installLocalStorage();
    ls.setMode("throw");
    const s = browserStorage();
    s.set("k", "v");
    expect(s.keys()).toContain("k");
  });

  it("a later successful write clears the override", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "old");
    ls.setMode("throw");
    s.set("k", "new");
    ls.setMode("ok");
    expect(s.set("k", "newest")).toBe("durable");
    expect(ls.raw.get("k")).toBe("newest");     // durable storage is the single source again
    expect(s.get("k")).toBe("newest");
  });

  it("a later successful remove clears a tombstone", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "v");
    ls.setMode("throw");
    s.remove("k");
    ls.setMode("ok");
    s.remove("k");
    expect(ls.raw.has("k")).toBe(false);
    expect(s.get("k")).toBeNull();
  });

  it("get never writes", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "old");
    ls.setMode("throw");
    s.set("k", "new");
    s.get("k"); s.get("k");
    expect(ls.raw.get("k")).toBe("old");        // no opportunistic retry on a read
  });

  it("a key with no override reads localStorage first, then the memory fallback", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "v");                            // durable: in localStorage and in the fallback
    expect(s.get("k")).toBe("v");
    ls.raw.delete("k");                         // another tab cleared it; the fallback still has it
    expect(s.get("k")).toBe("v");
  });
});

describe("browserStorage when localStorage cannot be consulted", () => {
  it("a removal leaves a tombstone, so the value does not come back when storage returns", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "v");                            // durable
    Reflect.deleteProperty(globalThis as object, "localStorage");   // site data switched off
    s.remove("k");
    expect(s.get("k")).toBeNull();
    Object.defineProperty(globalThis, "localStorage", { value: ls.api, configurable: true, writable: true });
    expect(ls.raw.get("k")).toBe("v");          // the browser still holds it…
    expect(s.get("k")).toBeNull();              // …and this page still says it is gone
    expect(s.keys()).not.toContain("k");
  });

  it("a write is memory, and reads back the new value once storage returns", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "old");
    Reflect.deleteProperty(globalThis as object, "localStorage");
    expect(s.set("k", "new")).toBe("memory");
    Object.defineProperty(globalThis, "localStorage", { value: ls.api, configurable: true, writable: true });
    expect(s.get("k")).toBe("new");
    expect(ls.raw.get("k")).toBe("old");
  });

  it("a removal that IS confirmed absent still clears its override", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    ls.setMode("throw");
    s.set("k", "v");                            // override only
    ls.setMode("ok");
    s.remove("k");                              // getItem answers null: confirmed gone
    expect(s.get("k")).toBeNull();
    expect(s.keys()).not.toContain("k");
  });
});
