import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPersistenceNotice } from "../src/persistence.js";
import { createWeavesSignal } from "../src/weaves-signal.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("one storage instance (spec §2.4a)", () => {
  it("constructs browserStorage() exactly once outside storage.ts", () => {
    const hits = sources(SRC)
      .filter((f) => path.basename(f) !== "storage.ts")
      .filter((f) => /browserStorage\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).replaceAll("\\", "/"));
    expect(hits).toEqual(["main.tsx"]);
  });
});

describe("PersistenceNotice (spec §6)", () => {
  it("stays undegraded while every write is durable", () => {
    const notice = createPersistenceNotice();
    notice.note("durable");
    expect(notice.degraded()).toBe(false);
  });

  it("degrades on the first memory write and tells every subscriber exactly once", () => {
    const notice = createPersistenceNotice();
    let a = 0;
    let b = 0;
    notice.subscribe(() => a++);
    notice.subscribe(() => b++);
    notice.note("memory");
    expect([notice.degraded(), a, b]).toEqual([true, 1, 1]);
  });

  it("notifies nobody on a second memory write: the notice is shown once per page", () => {
    const notice = createPersistenceNotice();
    notice.note("memory");
    let calls = 0;
    notice.subscribe(() => calls++);
    notice.note("memory");
    expect(calls).toBe(0);
  });

  it("dismiss() records the dismissal and notifies", () => {
    const notice = createPersistenceNotice();
    let calls = 0;
    notice.subscribe(() => calls++);
    notice.dismiss();
    expect([notice.dismissed(), calls]).toEqual([true, 1]);
  });

  it("stays degraded after a dismiss: the condition outlives the message", () => {
    const notice = createPersistenceNotice();
    notice.note("memory");
    notice.dismiss();
    expect(notice.degraded()).toBe(true);
  });
});

describe("WeavesSignal (spec §4.2)", () => {
  it("calls every subscriber exactly once per bump", () => {
    const weaves = createWeavesSignal();
    let a = 0;
    let b = 0;
    weaves.subscribe(() => a++);
    weaves.subscribe(() => b++);
    weaves.bump();
    expect([a, b]).toEqual([1, 1]);
  });

  it("calls them again on a second bump: every change is news, nothing latches", () => {
    const weaves = createWeavesSignal();
    let calls = 0;
    weaves.subscribe(() => calls++);
    weaves.bump();
    weaves.bump();
    expect(calls).toBe(2);
  });

  it("stops calling a listener that unsubscribed", () => {
    const weaves = createWeavesSignal();
    let calls = 0;
    const off = weaves.subscribe(() => calls++);
    weaves.bump();
    off();
    weaves.bump();
    expect(calls).toBe(1);
  });

  it("bumps with no subscribers without throwing", () => {
    const weaves = createWeavesSignal();
    expect(() => weaves.bump()).not.toThrow();
  });
});
