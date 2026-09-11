import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelState } from "../src/state.js";

const w = { title: "T", token: "t".repeat(43), participantId: "p1", participantName: "Claude", generalThreadId: "g1", wake: "all" as const, lastSeq: 0 };

describe("ChannelState", () => {
  it("starts empty, persists weaves, cursors and wake mode", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const st = new ChannelState(dir);
    expect(st.get()).toEqual({ weaves: {} });
    st.upsertWeave("w1", w);
    st.setLastSeq("w1", 7);
    st.setWake("w1", "mentions");
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
    const again = new ChannelState(dir);
    expect(again.get().weaves.w1).toEqual({ ...w, lastSeq: 7, wake: "mentions" });
    again.removeWeave("w1");
    expect(new ChannelState(dir).get().weaves).toEqual({});
    expect(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"))).toEqual({ weaves: {} });
  });
  it("dirFrom honours LOOM_CHANNEL_STATE_DIR else ~/.claude/channels/loom", () => {
    expect(ChannelState.dirFrom({ LOOM_CHANNEL_STATE_DIR: "/x" })).toBe("/x");
    expect(ChannelState.dirFrom({ HOME: "/home/u" })).toBe(path.join("/home/u", ".claude", "channels", "loom"));
  });
  it("scrubs a legacy `secret` field from a weave on load and rewrites the file without it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const clean = { title: "T2", token: "u".repeat(43), participantId: "p2", participantName: "GPT", generalThreadId: "g2", wake: "all" as const, lastSeq: 3 };
    const legacy = { ...clean, secret: "s".repeat(43) };
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ weaves: { w1: legacy } }, null, 2) + "\n");
    const st = new ChannelState(dir);
    const loaded = st.get().weaves.w1;
    expect(loaded).toEqual(clean);
    expect(loaded && "secret" in loaded).toBe(false);
    const onDisk = readFileSync(path.join(dir, "config.json"), "utf8");
    expect(onDisk).not.toContain(legacy.secret);
    expect(onDisk).not.toContain("secret");
  });
});
