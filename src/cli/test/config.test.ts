import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigStore } from "../src/config.js";

describe("ConfigStore", () => {
  it("returns an empty config when the file is missing, and round-trips", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-cli-"));
    const p = path.join(dir, "nested", "config.json");
    const store = new ConfigStore(p);
    expect(store.load()).toEqual({ weaves: {} });
    store.save({ url: "https://x", lastWeave: "w1", weaves: { w1: { title: "T", token: "t", participantId: "p", generalThreadId: "g", participantName: "Me" } } });
    expect(existsSync(p)).toBe(true);
    expect(store.load().lastWeave).toBe("w1");
    expect(JSON.parse(readFileSync(p, "utf8")).weaves.w1.token).toBe("t");
  });
  it("saving twice works and tightens permissions to 0o600 on non-Windows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-cli-"));
    const p = path.join(dir, "config.json");
    const store = new ConfigStore(p);
    store.save({ weaves: {} });
    store.save({ url: "https://x", lastWeave: "w1", weaves: { w1: { title: "T", token: "t", participantId: "p", generalThreadId: "g", participantName: "Me" } } });
    expect(store.load().lastWeave).toBe("w1");
    // chmodSync is a no-op on Windows and the mode bits are not meaningful there, so only assert on POSIX.
    if (process.platform !== "win32") {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it("update merges into the latest on-disk config under a lock, and clears a stale lock", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-cli-"));
    const p = path.join(dir, "config.json");
    const a = new ConfigStore(p);
    const b = new ConfigStore(p);
    const entry = { title: "T", token: "t", participantId: "p", generalThreadId: "g", participantName: "Me" };
    await Promise.all([
      a.update((c) => { c.weaves.w1 = entry; c.lastWeave = "w1"; }),
      b.update((c) => { c.weaves.w2 = entry; c.lastWeave = "w2"; }),
    ]);
    expect(Object.keys(a.load().weaves).sort()).toEqual(["w1", "w2"]);
    expect(existsSync(`${p}.lock`)).toBe(false);

    // A lock left behind by a crashed process (old mtime) is taken over rather than waited on forever.
    writeFileSync(`${p}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${p}.lock`, old, old);
    await a.update((c) => { c.url = "https://x"; });
    expect(a.load().url).toBe("https://x");
    expect(existsSync(`${p}.lock`)).toBe(false);
  });
  it("defaultPath honours LOOM_CONFIG, else ~/.loom/config.json", () => {
    expect(ConfigStore.defaultPath({ LOOM_CONFIG: "/tmp/c.json" })).toBe("/tmp/c.json");
    expect(ConfigStore.defaultPath({ HOME: "/home/u" })).toBe(path.join("/home/u", ".loom", "config.json"));
    expect(ConfigStore.defaultPath({ USERPROFILE: "C:\\Users\\u" })).toBe(path.join("C:\\Users\\u", ".loom", "config.json"));
  });
});
