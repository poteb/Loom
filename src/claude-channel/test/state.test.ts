import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
    await st.setWake("w1", "mentions"); // compatibility shim: records this session's preference
    expect(existsSync(st.file)).toBe(true);
    const again = new ChannelState(dir, "s1");
    expect(again.get().weaves.w1).toEqual({ ...w, lastSeq: 7 }); // the machine-wide field is no longer written
    expect(again.prefs("w1")).toEqual({ wake: "mentions", invites: true });
    expect(again.cursor("w1")).toBe(7);
    await again.removeWeave("w1");
    expect(new ChannelState(dir, "s1").get().weaves).toEqual({});
    const onDisk = JSON.parse(readFileSync(again.file, "utf8"));
    expect(onDisk.weaves).toEqual({});
    expect(JSON.stringify(onDisk)).not.toContain("w1"); // the removed weave's cursors go too
  });

  it("two processes on one state never lose each other's writes (optimistic versioned commits)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const a = new ChannelState(dir, "sA");
    const b = new ChannelState(dir, "sB");
    a.get(); b.get(); // both hold a (stale) cache of the empty file
    await Promise.all([
      a.upsertWeave("w1", w),
      b.upsertWeave("w2", { ...w, participantId: "p2" }),
    ]);
    await a.setLastSeq("w1", 5);
    await b.setPrefs("w2", { wake: "mentions" });
    const disk = new ChannelState(dir, "sC").get();
    expect(Object.keys(disk.weaves).sort()).toEqual(["w1", "w2"]);
    expect(disk.weaves.w1!.lastSeq).toBe(5);
    expect(new ChannelState(dir, "sB").prefs("w2").wake).toBe("mentions");
    // Only the newest version and its predecessor stay behind; no temp files, no legacy file.
    const files = readdirSync(dir).sort();
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files).not.toContain("config.json");
    expect(files.filter((f) => /^config\.\d+\.json$/.test(f)).length).toBeLessThanOrEqual(3);
  });

  it("a writer whose snapshot went stale re-applies its change on the fresh state instead of overwriting", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const seed = new ChannelState(dir, "s0");
    await seed.upsertWeave("w0", w);
    let intrusions = 0;
    // `now` runs inside the mutation, after the snapshot was taken: the first call plays another
    // process that commits the next version in the meantime.
    const a = new ChannelState(dir, "sA", () => {
      if (intrusions++ === 0) {
        const latest = Number(/config\.(\d+)\.json$/.exec(new ChannelState(dir, "x").file)![1]);
        const other = JSON.parse(readFileSync(path.join(dir, `config.${latest}.json`), "utf8"));
        other.weaves.w1 = { ...w, participantId: "p-other" };
        writeFileSync(path.join(dir, `config.${latest + 1}.json`), JSON.stringify(other));
      }
      return new Date();
    });
    await a.upsertWeave("w2", { ...w, participantId: "p-a" });
    const final = new ChannelState(dir, "x").get();
    expect(Object.keys(final.weaves).sort()).toEqual(["w0", "w1", "w2"]);
    expect(intrusions).toBeGreaterThanOrEqual(2); // the mutation ran again on the fresh snapshot
  });

  it("reads past an unreadable newest version when an older one exists, and never reuses its number", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const st = new ChannelState(dir, "s1");
    await st.upsertWeave("w1", w);
    const good = Number(/config\.(\d+)\.json$/.exec(st.file)![1]);
    writeFileSync(path.join(dir, `config.${good + 1}.json`), '{"weaves": {"w1": {"title": "trunc'); // corrupt
    const fresh = new ChannelState(dir, "s2");
    expect(fresh.get().weaves.w1).toEqual(w); // reads the last good version
    await fresh.setLastSeq("w1", 4);
    expect(fresh.file).toBe(path.join(dir, `config.${good + 2}.json`)); // committed past the broken number
    expect(new ChannelState(dir, "s1").get().weaves.w1!.lastSeq).toBe(4);
  });

  it("throws instead of resetting the state when the only versions on disk are unreadable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    writeFileSync(path.join(dir, "config.7.json"), "{ not json");
    expect(() => new ChannelState(dir, "s1").get()).toThrow(/unreadable/);
  });

  it("a delayed writer whose version number was superseded and swept does not count its publish as success", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const seed = new ChannelState(dir, "s0");
    await seed.upsertWeave("w0", w);               // version 1
    let intrusions = 0;
    const a = new ChannelState(dir, "sA", () => {
      // Inside A's first attempt (snapshot taken at version 1): another process commits 2, 3 and 4
      // and sweeps 2, exactly the window in which A's hard link to config.2.json will succeed.
      if (intrusions++ === 0) {
        const cur = JSON.parse(readFileSync(path.join(dir, "config.1.json"), "utf8"));
        cur.weaves.w1 = { ...w, participantId: "p-other" };
        for (const v of [2, 3, 4]) writeFileSync(path.join(dir, `config.${v}.json`), JSON.stringify(cur));
        writeFileSync(path.join(dir, "config.2.json"), JSON.stringify(cur)); // (re)written, then swept:
        rmSync(path.join(dir, "config.2.json"));
      }
      return new Date();
    });
    await a.upsertWeave("w2", { ...w, participantId: "p-a" });
    const final = new ChannelState(dir, "x").get();
    expect(Object.keys(final.weaves).sort()).toEqual(["w0", "w1", "w2"]); // A's change landed on top of 4, not under it
    expect(a.file).toBe(path.join(dir, "config.5.json"));
    expect(intrusions).toBeGreaterThanOrEqual(2);
  });

  it("a publish that a later writer built upon counts as success and is not re-applied", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    let intruded = false;
    let applications = 0;
    class Observed extends ChannelState {
      protected override publish(tmp: string, target: string): void {
        super.publish(tmp, target);
        if (intruded) return;
        intruded = true;
        // Between A's publish of version 1 and its newest-version check, session B reads version 1,
        // delivers up to seq 10 and commits version 2 *on top of it* (parent = A's commit id).
        const v1 = JSON.parse(readFileSync(target, "utf8"));
        v1.weaves.w1.lastSeq = 10;
        v1.sessions.sB = { at: new Date().toISOString(), cursors: { w1: 10 } };
        v1.commit = { id: "b-commit", parent: v1.commit.id };
        writeFileSync(path.join(dir, "config.2.json"), JSON.stringify(v1));
      }
    }
    const a = new Observed(dir, "sA", () => { applications++; return new Date(); });
    await a.upsertWeave("w1", w); // lastSeq 0
    const final = new ChannelState(dir, "x").get();
    expect(final.weaves.w1!.lastSeq).toBe(10);          // B's progress preserved: A did not re-apply its join over it
    expect(final.sessions.sB!.cursors.w1).toBe(10);
    expect(applications).toBe(3); // `now` runs three times per attempt (session stamp, prune, writer stamp): one attempt, no re-apply
    expect(a.file).toBe(path.join(dir, "config.2.json"));
  });

  it("a landed commit is never re-applied, even after every trace of its successor has been swept", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const seed = new ChannelState(dir, "s0");
    await seed.upsertWeave("w1", w);                           // version 1
    let intruded = false;
    let applications = 0;
    class Paused extends ChannelState {
      protected override publish(tmp: string, target: string): void {
        super.publish(tmp, target);                            // A publishes removal of w1 as version 2 ...
        if (intruded) return;
        intruded = true;
        // ... and pauses. B reads version 2 (w1 gone), stores a NEW identity for w1 with wake=mentions,
        // then makes three cursor commits. Its writes sweep versions 2 and 3 before A resumes.
        const v = Number(/config\.(\d+)\.json$/.exec(target)![1]);
        const base = JSON.parse(readFileSync(target, "utf8"));
        let cur = { ...base, weaves: { w1: { ...w, token: "b-token", wake: "mentions" } }, sessions: { sB: { at: new Date().toISOString(), cursors: { w1: 0 } } } };
        for (let i = 1; i <= 4; i++) {
          cur = { ...cur, sessions: { sB: { at: new Date().toISOString(), cursors: { w1: i * 5 } } }, commit: { id: `b${i}`, parent: i === 1 ? base.commit.id : `b${i - 1}` } };
          writeFileSync(path.join(dir, `config.${v + i}.json`), JSON.stringify(cur));
        }
        rmSync(path.join(dir, `config.${v}.json`));
        rmSync(path.join(dir, `config.${v + 1}.json`));
      }
    }
    const a = new Paused(dir, "sA", () => { applications++; return new Date(); });
    await a.removeWeave("w1");
    const final = new ChannelState(dir, "x").get();
    expect(final.weaves.w1).toMatchObject({ token: "b-token", wake: "mentions" }); // B's new identity survives
    expect(final.sessions.sB!.cursors.w1).toBe(20);
    expect(applications).toBe(2); // `now` runs twice per attempt here (prune, writer stamp): removeWeave ran once
  });

  it("keeps a live writer's receipt however long ago it was written, and drops a dead writer's", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const a = new ChannelState(dir, "sA", () => new Date("2026-01-01T00:00:00Z"));
    await a.upsertWeave("w1", w);
    // Plant a receipt of a writer whose process is gone next to A's (A's process is this one: alive).
    const cur = JSON.parse(readFileSync(a.file, "utf8"));
    cur.writers["999999999:gone"] = { id: "g", at: "2026-01-01T00:00:00Z" };
    cur.commit = { id: "planted", parent: cur.commit.id };
    writeFileSync(path.join(dir, "config.2.json"), JSON.stringify(cur));
    const aReceipt = Object.keys(cur.writers).find((k) => k !== "999999999:gone")!;
    // B commits a week later: A may still be suspended and resume, so its receipt must survive.
    const b = new ChannelState(dir, "sB", () => new Date("2026-01-08T00:00:00Z"));
    await b.setLastSeq("w1", 3);
    const writers = new ChannelState(dir, "x").get().writers;
    expect(writers[aReceipt]).toBeDefined();
    expect(writers["999999999:gone"]).toBeUndefined();
  });

  it("a sibling's commit leaves a live writer's temp file alone, however old it is, and sweeps a dead one's", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const seed = new ChannelState(dir, "s0");
    await seed.upsertWeave("w1", w);
    // Two temp files written a minute ago: one by a process that still exists and could resume and
    // link it, one by a process that is gone. Age alone says nothing about which is which.
    const live = path.join(dir, `config.9.${process.pid}.${randomUUID()}.tmp`);
    const dead = path.join(dir, `config.9.${spawnSync(process.execPath, ["-e", ""]).pid}.${randomUUID()}.tmp`);
    const junk = path.join(dir, `config.9.not-a-writer.tmp`);
    const old = new Date(Date.now() - 61_000);
    for (const f of [live, dead, junk]) { writeFileSync(f, "{}"); utimesSync(f, old, old); }

    await new ChannelState(dir, "s1").setLastSeq("w1", 4);   // a sibling commits, and sweeps

    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(junk)).toBe(false);                    // unattributable: the age rule still applies
  });

  it("re-writes and re-links a temp file that was swept away under a paused writer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    let swept = 0;
    class Swept extends ChannelState {
      protected override publish(tmp: string, target: string): void {
        // The writer paused after writing its temp file; something removed it before the link.
        if (swept++ === 0) rmSync(tmp, { force: true });
        super.publish(tmp, target);
      }
    }
    const a = new Swept(dir, "sA");
    await a.upsertWeave("w1", w);                            // must not fail, and must persist the token
    expect(swept).toBe(2);
    expect(new ChannelState(dir, "x").get().weaves.w1).toEqual(w);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("re-applying a join over state that already holds the same token keeps the advanced watermark and cursors", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const a = new ChannelState(dir, "sA");
    await a.upsertWeave("w1", w);
    await new ChannelState(dir, "sB").setLastSeq("w1", 10);
    await a.setLastSeq("w1", 6);
    await a.upsertWeave("w1", w);                        // same token: idempotent
    let c = new ChannelState(dir, "x").get();
    expect(c.weaves.w1!.lastSeq).toBe(10);
    expect(c.sessions.sA!.cursors.w1).toBe(6);
    expect(c.sessions.sB!.cursors.w1).toBe(10);
    await a.upsertWeave("w1", { ...w, token: "new-identity" }); // genuinely new identity: history replays for this session
    c = new ChannelState(dir, "x").get();
    expect(c.weaves.w1!.lastSeq).toBe(0);
    expect(c.sessions.sA!.cursors.w1).toBe(0);
    expect(c.sessions.sB!.cursors.w1).toBe(10);           // other sessions untouched
  });

  it("re-checks for versions when the legacy file vanishes because another process just migrated it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ weaves: { w1: w } }));
    let listings = 0;
    class Racy extends ChannelState {
      protected override versions(): number[] {
        const v = super.versions();
        if (listings++ === 0) {
          // Another process migrates: commits version 1 from the legacy file and removes config.json.
          writeFileSync(path.join(dir, "config.1.json"), JSON.stringify({ weaves: { w1: w }, sessions: {}, commit: { id: "m" } }));
          rmSync(path.join(dir, "config.json"));
        }
        return v;
      }
    }
    expect(new Racy(dir, "sR").get().weaves.w1).toEqual(w); // not an empty store
  });

  it("re-enumerates when the versions it listed were swept before it could read them", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const seed = new ChannelState(dir, "s0");
    await seed.upsertWeave("w1", w);               // version 1
    let listings = 0;
    class Racy extends ChannelState {
      protected override versions(): number[] {
        const v = super.versions();
        if (listings++ === 0) {
          // Between our listing and our read, another process commits 2 and 3 and sweeps 1.
          const cur = readFileSync(path.join(dir, "config.1.json"), "utf8");
          writeFileSync(path.join(dir, "config.2.json"), cur);
          writeFileSync(path.join(dir, "config.3.json"), cur);
          rmSync(path.join(dir, "config.1.json"));
        }
        return v;
      }
    }
    const r = new Racy(dir, "sR");
    expect(r.get().weaves.w1).toEqual(w); // not an empty store
    expect(listings).toBeGreaterThanOrEqual(2);
  });

  it("refuses a state dir on a filesystem without hard links instead of publishing non-atomically", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    class NoLinks extends ChannelState {
      protected override publish(): void { const e = new Error("EPERM: operation not permitted, link") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; }
    }
    await expect(new NoLinks(dir, "s1").upsertWeave("w1", w)).rejects.toThrow(/hard links/);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
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
    expect(readFileSync(now.file, "utf8")).not.toContain('"old"');
  });

  it("preferences are per session, default all/invites-on, and inherit a legacy machine-wide wake", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const a = new ChannelState(dir, "sA");
    await a.upsertWeave("w1", { ...w, wake: "mentions" });           // legacy machine-wide value
    expect(a.prefs("w1")).toEqual({ wake: "mentions", invites: true });
    expect(await a.setPrefs("w1", { invites: false })).toEqual({ wake: "mentions", invites: false });
    await a.setPrefs("w1", { wake: "all" });
    expect(new ChannelState(dir, "sA").prefs("w1")).toEqual({ wake: "all", invites: false });
    expect(new ChannelState(dir, "sB").prefs("w1")).toEqual({ wake: "mentions", invites: true }); // untouched by sA
    expect(new ChannelState(dir, "sB").prefs("unknown")).toEqual({ wake: "all", invites: true });
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
    // load() never writes; migrate() commits a clean first version and retires the legacy file.
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toContain("secret");
    await st.migrate();
    expect(existsSync(path.join(dir, "config.json"))).toBe(false);
    expect(st.file).toBe(path.join(dir, "config.1.json"));
    const onDisk = readFileSync(st.file, "utf8");
    expect(onDisk).not.toContain(legacy.secret);
    expect(onDisk).not.toContain("secret");
  });
});
