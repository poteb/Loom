import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelState } from "../src/state.js";

const w = { title: "T", token: "t".repeat(43), participantId: "p1", participantName: "Claude", generalThreadId: "g1", wake: "all" as const, lastSeq: 0 };

describe("ChannelState", () => {
  it("starts empty, persists weaves, cursors and wake mode", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const st = new ChannelState(dir, "s1");
    expect(st.get().weaves).toEqual({});
    await st.upsertWeave("w1", w);
    await st.setLastSeq("w1", 7);
    await st.setWake("w1", "mentions");
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
    const again = new ChannelState(dir, "s1");
    expect(again.get().weaves.w1).toEqual({ ...w, lastSeq: 7, wake: "mentions" });
    expect(again.cursor("w1")).toBe(7);
    await again.removeWeave("w1");
    expect(new ChannelState(dir, "s1").get().weaves).toEqual({});
    const onDisk = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(onDisk.weaves).toEqual({});
    expect(JSON.stringify(onDisk)).not.toContain("w1"); // the removed weave's cursors go too
  });

  it("two processes on one file never lose each other's writes (locked read-merge-write)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const a = new ChannelState(dir, "sA");
    const b = new ChannelState(dir, "sB");
    a.get(); b.get(); // both hold a (stale) cache of the empty file
    await Promise.all([
      a.upsertWeave("w1", w),
      b.upsertWeave("w2", { ...w, participantId: "p2" }),
    ]);
    await a.setLastSeq("w1", 5);
    await b.setWake("w2", "mentions");
    const disk = new ChannelState(dir, "sC").get();
    expect(Object.keys(disk.weaves).sort()).toEqual(["w1", "w2"]);
    expect(disk.weaves.w1!.lastSeq).toBe(5);
    expect(disk.weaves.w2!.wake).toBe("mentions");
    expect(existsSync(path.join(dir, "config.json.lock"))).toBe(false);
  });

  it("keeps a cursor per session: a resumed session replays what it missed, a new session starts at the watermark", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const s1 = new ChannelState(dir, "s1");
    await s1.upsertWeave("w1", w);
    await s1.setLastSeq("w1", 5);
    const s2 = new ChannelState(dir, "s2");
    expect(s2.cursor("w1")).toBe(5); // new session: nothing delivered to it yet, start at the machine-wide watermark
    await s2.setLastSeq("w1", 9);   // s2 consumes 6..9 while s1 is away
    expect(new ChannelState(dir, "s1").cursor("w1")).toBe(5); // s1 resumes exactly where *it* left off
    expect(new ChannelState(dir, "s3").cursor("w1")).toBe(9); // a fresh session does not replay 6..9
    expect(new ChannelState(dir, "s1").get().weaves.w1!.lastSeq).toBe(9); // watermark = max over sessions
  });

  it("ensureCursor pins a quiet session's starting point so it resumes from there, not from a later watermark", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const a = new ChannelState(dir, "sA");
    await a.upsertWeave("w1", w);
    await a.setLastSeq("w1", 5);
    const b = new ChannelState(dir, "sB");
    expect(await b.ensureCursor("w1")).toBe(5); // B starts listening at the watermark and *records* that
    await a.setLastSeq("w1", 9);                 // A moves on while B is away without ever receiving an event
    expect(new ChannelState(dir, "sB").cursor("w1")).toBe(5); // B resumes at 5, so 6..9 are not skipped
    expect(await new ChannelState(dir, "sB").ensureCursor("w1")).toBe(5); // idempotent
  });

  it("waits for a lock whose owner process is alive instead of taking it over, however old it is", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const st = new ChannelState(dir, "s1");
    await st.upsertWeave("w1", w);
    const lock = path.join(dir, "config.json.lock");
    writeFileSync(lock, `${process.pid}:someone-else-in-this-process`); // a live pid that is not us
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    await expect(st.setLastSeq("w1", 2)).rejects.toThrow(/lock/);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}:someone-else-in-this-process`);
    expect(new ChannelState(dir, "s1").cursor("w1")).toBe(0);
  }, 15_000);

  it("takes over a lock whose owner process is dead right away", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const st = new ChannelState(dir, "s1");
    await st.upsertWeave("w1", w);
    const lock = path.join(dir, "config.json.lock");
    writeFileSync(lock, "999999999:dead"); // no such pid
    const t0 = Date.now();
    await st.setLastSeq("w1", 2);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(st.cursor("w1")).toBe(2);
    expect(existsSync(lock)).toBe(false);
  });

  it("cursors and the watermark only move forward", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const st = new ChannelState(dir, "s1");
    await st.upsertWeave("w1", w);
    await st.setLastSeq("w1", 9);
    await st.setLastSeq("w1", 4);
    expect(st.cursor("w1")).toBe(9);
    expect(st.get().weaves.w1!.lastSeq).toBe(9);
  });

  it("forgets sessions that have not been seen for 30 days", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const old = new ChannelState(dir, "old", () => new Date("2026-01-01T00:00:00Z"));
    await old.upsertWeave("w1", w);
    await old.setLastSeq("w1", 3);
    const now = new ChannelState(dir, "new", () => new Date("2026-03-01T00:00:00Z"));
    await now.setLastSeq("w1", 8);
    expect(new ChannelState(dir, "old").cursor("w1")).toBe(8); // pruned: treated as a new session
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).not.toContain('"old"');
  });

  it("takes over a stale lock left by a crashed process", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const st = new ChannelState(dir, "s1");
    await st.upsertWeave("w1", w);
    const lock = path.join(dir, "config.json.lock");
    writeFileSync(lock, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    await st.setLastSeq("w1", 2);
    expect(st.cursor("w1")).toBe(2);
    expect(existsSync(lock)).toBe(false);
  });

  it("aborts a write, and leaves the other owner's lock alone, when its lease was taken over mid-mutation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const lock = path.join(dir, "config.json.lock");
    let calls = 0;
    // `now` runs inside the locked section (session stamp / prune): the first call simulates another
    // process that judged our lock stale and replaced it with its own.
    const st = new ChannelState(dir, "s1", () => { if (++calls === 1) writeFileSync(lock, "other-owner"); return new Date(); });
    await expect(st.upsertWeave("w1", w)).rejects.toThrow(/lock/);
    expect(existsSync(path.join(dir, "config.json"))).toBe(false); // nothing written
    expect(readFileSync(lock, "utf8")).toBe("other-owner");        // and the new owner's lock still stands
  });

  it("sessionIdFrom uses CLAUDE_CODE_SESSION_ID, else a per-process id", () => {
    expect(ChannelState.sessionIdFrom({ CLAUDE_CODE_SESSION_ID: "abc" })).toBe("abc");
    expect(ChannelState.sessionIdFrom({})).toMatch(/^pid:\d+$/);
  });
  it("dirFrom honours LOOM_CHANNEL_STATE_DIR else ~/.claude/channels/loom", () => {
    expect(ChannelState.dirFrom({ LOOM_CHANNEL_STATE_DIR: "/x" })).toBe("/x");
    expect(ChannelState.dirFrom({ HOME: "/home/u" })).toBe(path.join("/home/u", ".claude", "channels", "loom"));
  });
  it("scrubs a legacy `secret` field from a weave on load and rewrites the file without it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const clean = { title: "T2", token: "u".repeat(43), participantId: "p2", participantName: "GPT", generalThreadId: "g2", wake: "all" as const, lastSeq: 3 };
    const legacy = { ...clean, secret: "s".repeat(43) };
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ weaves: { w1: legacy } }, null, 2) + "\n");
    const st = new ChannelState(dir, "s1");
    const loaded = st.get().weaves.w1;
    expect(loaded).toEqual(clean);
    expect(loaded && "secret" in loaded).toBe(false);
    // load() never writes (that would bypass the lock); migrate() rewrites the file through it.
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toContain("secret");
    await st.migrate();
    const onDisk = readFileSync(path.join(dir, "config.json"), "utf8");
    expect(onDisk).not.toContain(legacy.secret);
    expect(onDisk).not.toContain("secret");
  });
});
