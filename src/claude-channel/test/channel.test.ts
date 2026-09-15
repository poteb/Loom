import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_INSTANCE_GUIDELINES, INSTANCE_HEADING, WEAVE_HEADING } from "@loom/core";
import { api, keeperToken, startTestServer, type TestServer } from "../../server/test/helpers.js";

let s: TestServer | undefined;
beforeAll(async () => { s = await startTestServer(); });
afterAll(async () => { await s?.close(); });

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(path.join(tmpdir(), "loom-ch-")); });

const SERVER_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/server.js");

export async function spawnChannel(dir: string, onStderr?: (chunk: string) => void, extraEnv: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "claude-code-like", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_JS],
    env: { ...process.env, LOOM_URL: s!.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CHANNEL_STATE_DIR: dir, ...extraEnv },
    stderr: "pipe",
  });
  if (onStderr) transport.stderr?.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
  await client.connect(transport);
  return client;
}

/** Spawns a channel for `dir`, runs `fn`, and always closes the client — even when `fn` throws —
 * so a failed assertion never leaks the child process or hangs teardown. The child's stderr is
 * captured throughout and appended to a thrown error's message, and also handed to `fn` via
 * `getStderr()` for tests that want to assert on it directly. */
async function withChannel<T>(dir: string, fn: (client: Client, getStderr: () => string) => Promise<T>, extraEnv: Record<string, string> = {}): Promise<T> {
  let stderrBuf = "";
  const client = await spawnChannel(dir, (chunk) => { stderrBuf += chunk; }, extraEnv);
  try {
    return await fn(client, () => stderrBuf);
  } catch (err) {
    if (stderrBuf) (err as Error).message += `\n--- channel stderr ---\n${stderrBuf}`;
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
/** The channel's newest committed state file (`config.<n>.json`), parsed. */
function readState(dir: string) {
  const versions = readdirSync(dir).map((f) => /^config\.(\d+)\.json$/.exec(f)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  if (versions.length === 0) throw new Error(`no state committed in ${dir}`);
  return JSON.parse(readFileSync(path.join(dir, `config.${Math.max(...versions)}.json`), "utf8"));
}

describe("channel tools", () => {
  it("advertises the claude/channel capability and all tools", async () => {
    await withChannel(stateDir, async (c) => {
      const caps = c.getServerCapabilities();
      expect(caps?.experimental).toHaveProperty("claude/channel");
      const { tools } = await c.listTools();
      const names = tools.map((t) => t.name);
      for (const n of ["create_weave", "join_weave", "post_message", "read_events", "leave_weave", "set_wake", "list_joined", "set_weave_guidelines"]) expect(names).toContain(n);
      expect(c.getInstructions()).toMatch(/<channel source="loom"/);
    });
  });

  it("serves the instance guidelines it fetched at startup as part of its instructions", async () => {
    const instance = (await api(s!.baseUrl, "GET", "/api/guidelines")).json.guidelines as string;
    expect(instance).toBe(DEFAULT_INSTANCE_GUIDELINES);
    await withChannel(stateDir, async (c) => {
      const text = c.getInstructions() ?? "";
      expect(text).toContain(`${INSTANCE_HEADING}\n${instance}`);
      expect(text).toMatch(/<channel source="loom"/);          // the mechanics text is still there
      expect(text).toContain("weave.guidelines_changed");
      expect(text).toContain('preamble="guidelines"');
    });
  });

  it("starts within the deadline and serves the mechanics text alone when the instance endpoint stalls", async () => {
    const stalled: Server = createServer(() => { /* socket accepted, request never answered */ });
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`;
    try {
      const t0 = Date.now();
      await withChannel(stateDir, async (c, getStderr) => {
        const elapsed = Date.now() - t0;
        expect(c.getInstructions()).not.toContain(INSTANCE_HEADING);
        expect(c.getInstructions()).toMatch(/<channel source="loom"/);
        await waitFor(() => /instance guidelines not fetched/.test(getStderr()));
        expect(elapsed).toBeLessThan(5000);
      }, { LOOM_URL: url });
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((r) => stalled.close(() => r()));
    }
  });

  it("create_weave and join_weave persist the token; leave_weave forgets it", async () => {
    await withChannel(stateDir, async (c) => {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
      let cfg = readState(stateDir);
      expect(cfg.weaves[created.weave.id]).toMatchObject({ token: created.token, participantId: created.participant.id, wake: "all", lastSeq: 0, generalThreadId: created.generalThread.id });
      const listed = json(await c.callTool({ name: "list_joined", arguments: {} }));
      expect(listed).toEqual([expect.objectContaining({ weaveId: created.weave.id, title: "T", participantName: "Claude", wake: "all", invites: true })]);
      const waked = await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id, wake: "mentions", invites: false } });
      expect(waked.isError).toBeFalsy();
      expect(json(waked)).toEqual({ weaveId: created.weave.id, wake: "mentions", invites: false });
      cfg = readState(stateDir);
      // Preferences live under this session's entry, not on the machine-wide Weave record.
      expect(cfg.weaves[created.weave.id].wake).toBe("all");
      expect(Object.values(cfg.sessions as Record<string, { prefs?: Record<string, unknown> }>).map((sess) => sess.prefs?.[created.weave.id]))
        .toContainEqual({ wake: "mentions", invites: false });
      const nothing = await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id } });
      expect(nothing.isError).toBe(true);
      expect(json(nothing)).toEqual({ code: "validation", message: expect.any(String) });
      const left = await c.callTool({ name: "leave_weave", arguments: { weaveId: created.weave.id } });
      expect(left.isError).toBeFalsy();
      expect(json(left)).toEqual({ weaveId: created.weave.id, left: true });
      cfg = readState(stateDir);
      expect(cfg.weaves).toEqual({});
      const unknown = await c.callTool({ name: "leave_weave", arguments: { weaveId: created.weave.id } });
      expect(unknown.isError).toBe(true);
      expect(json(unknown)).toEqual({ code: "no_weave", message: expect.any(String) });
    });
  });

  it("join_weave twice with the same name returns the stored identity instead of name_taken", async () => {
    await withChannel(stateDir, async (a) => {
      const created = json(await a.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
      const stateDirB = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
      await withChannel(stateDirB, async (b) => {
        const first = json(await b.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "Other" } }));
        const again = json(await b.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "Other" } }));
        expect(again).toMatchObject({ weaveId: created.weave.id, token: first.token, participant: { id: first.participant.id, name: "Other" }, generalThreadId: created.generalThread.id, alreadyJoined: true });
        const info = json(await a.callTool({ name: "get_weave", arguments: { credential: created.token, weaveId: created.weave.id } }));
        expect(info.participants.map((p: { name: string }) => p.name)).toEqual(["Claude", "Other"]);
      });
    });
  });

  it("join_weave persists the joiner's own identity in its own state dir", async () => {
    await withChannel(stateDir, async (a) => {
      const created = json(await a.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
      const stateDirB = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
      await withChannel(stateDirB, async (b) => {
        const joined = json(await b.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "Other" } }));
        expect(joined).toMatchObject({ token: expect.any(String), participant: { name: "Other" } });
        const cfg = readState(stateDirB);
        expect(cfg.weaves[created.weave.id]).toMatchObject({
          token: joined.token, participantId: joined.participant.id, participantName: "Other",
          generalThreadId: created.generalThread.id, wake: "all", lastSeq: 0, title: created.weave.title,
        });
        const listed = json(await b.callTool({ name: "list_joined", arguments: {} }));
        expect(listed).toEqual([expect.objectContaining({ weaveId: created.weave.id, title: created.weave.title, participantName: "Other", wake: "all", invites: true })]);
      });
    });
  });

  it("other tools work with an explicit credential and map errors", async () => {
    await withChannel(stateDir, async (c) => {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
      const posted = json(await c.callTool({ name: "post_message", arguments: { credential: created.token, threadId: created.generalThread.id, text: "hello" } }));
      expect(posted.seq).toBe(4);
      const bad = await c.callTool({ name: "get_weave", arguments: { credential: "garbage", weaveId: created.weave.id } });
      expect(bad.isError).toBe(true);
      expect(json(bad).code).toBe("invalid_token");
    });
  });

  it("credential \"stored\" resolves to the saved token; keeper tools reject it", async () => {
    await withChannel(stateDir, async (c) => {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
      const posted = json(await c.callTool({ name: "post_message", arguments: { credential: "stored", threadId: created.generalThread.id, text: "hi" } }));
      expect(posted.seq).toBe(4);
      const events = json(await c.callTool({ name: "read_events", arguments: { credential: "stored", weaveId: created.weave.id } }));
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      const keeper = await c.callTool({ name: "keeper_list", arguments: { credential: "stored" } });
      expect(keeper.isError).toBe(true);
      expect(json(keeper).code).toBe("validation");
    });
  });

  it("credential \"stored\" resolves for a thread this session just created, before its own thread.created event round-trips through the stream", async () => {
    await withChannel(stateDir, async (c) => {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
      const thread = json(await c.callTool({ name: "create_thread", arguments: { credential: "stored", weaveId: created.weave.id, name: "Sub" } }));
      const posted = await c.callTool({ name: "post_message", arguments: { credential: "stored", threadId: thread.id, text: "immediate reply" } });
      expect(posted.isError).toBeFalsy();
      const events = json(await c.callTool({ name: "read_events", arguments: { credential: "stored", weaveId: created.weave.id, threadId: thread.id } }));
      expect(events.map((e: { type: string }) => e.type)).toEqual(["thread.created", "message"]);
    });
  });
});

import { z } from "zod";

const ChannelNotification = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});

function collectNotifications(c: Client): { content: string; meta: Record<string, string> }[] {
  const got: { content: string; meta: Record<string, string> }[] = [];
  c.setNotificationHandler(ChannelNotification, (n) => { got.push(n.params); });
  return got;
}
/** The event text alone: the first turn a channel process delivers for a Weave carries the
 * guidelines preamble ahead of it, which the tests below are not about. */
function body(n: { content: string; meta: Record<string, string> }): string {
  if (n.meta.preamble !== "guidelines") return n.content;
  const sep = "\n\n---\n\n";
  return n.content.slice(n.content.indexOf(sep) + sep.length);
}
function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 25); };
    tick();
  });
}

describe("channel streaming", () => {
  it("pushes others' events as channel notifications, never its own, and advances the cursor", async () => {
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "PR 42", opener: "start", name: "Claude" } }));
      // another participant (ChatGPT) joins and posts through the server core
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      const gptActor = await s!.core.resolveCredential(gpt.token);
      await s!.core.postMessage(gptActor, created.generalThread.id, "Hello @Claude, I joined");
      await waitFor(() => got.length >= 2);
      expect(got[0]!.meta).toMatchObject({ weave: created.weave.id, type: "participant.joined", from: "ChatGPT", seq: "4" });
      expect(body(got[1]!)).toBe("Hello @Claude, I joined");
      expect(got[1]!.meta).toMatchObject({ thread: created.generalThread.id, thread_name: "General", type: "message", from: "ChatGPT", from_kind: "agent", seq: "5", mentions: created.participant.id });
      // own message is not pushed back
      await c.callTool({ name: "post_message", arguments: { credential: "stored", threadId: created.generalThread.id, text: "thanks" } });
      await s!.core.postMessage(gptActor, created.generalThread.id, "np");
      await waitFor(() => got.length >= 3);
      expect(got.map((g) => g.meta.seq)).toEqual(["4", "5", "7"]);
      await waitFor(() => readState(stateDir).weaves[created.weave.id].lastSeq === 7);
    });
  });

  it("wake=mentions filters to mentions only, thread names resolve for new threads", async () => {
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "start", name: "Claude" } }));
      await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id, wake: "mentions" } });
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      const gptActor = await s!.core.resolveCredential(gpt.token);
      const t = await s!.core.createThread(gptActor, created.weave.id, "Design");
      await s!.core.postMessage(gptActor, t.id, "no mention here");
      await s!.core.postMessage(gptActor, t.id, "ping @claude");
      await waitFor(() => got.length >= 1);
      await new Promise((r) => setTimeout(r, 300));
      expect(got).toHaveLength(1);
      expect(got[0]!.meta).toMatchObject({ thread: t.id, thread_name: "Design", type: "message" });
    });
  });

  it("restores joined weaves on restart from the saved cursor without duplicates", async () => {
    let created!: { secret: string; weave: { id: string }; generalThread: { id: string } };
    let gptActor!: Awaited<ReturnType<TestServer["core"]["resolveCredential"]>>;
    await withChannel(stateDir, async (c1) => {
      const got1 = collectNotifications(c1);
      created = json(await c1.callTool({ name: "create_weave", arguments: { title: "T", opener: "start", name: "Claude" } }));
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      gptActor = await s!.core.resolveCredential(gpt.token);
      await s!.core.postMessage(gptActor, created.generalThread.id, "one");
      await waitFor(() => got1.length >= 2);
    });
    // events while the channel is down
    await s!.core.postMessage(gptActor, created.generalThread.id, "two");
    await withChannel(stateDir, async (c2) => {
      const got2 = collectNotifications(c2);
      await waitFor(() => got2.length >= 1);
      expect(got2.map(body)).toEqual(["two"]);
      await s!.core.postMessage(gptActor, created.generalThread.id, "three");
      await waitFor(() => got2.length >= 2);
      expect(body(got2[1]!)).toBe("three");
    });
  });

  it("a resumed session replays what it missed even if another session consumed those events; a fresh session does not", async () => {
    let created!: { secret: string; weave: { id: string }; generalThread: { id: string } };
    let gptActor!: Awaited<ReturnType<TestServer["core"]["resolveCredential"]>>;
    const A = { CLAUDE_CODE_SESSION_ID: "session-A" };
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "start", name: "Claude" } }));
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      gptActor = await s!.core.resolveCredential(gpt.token);
      await s!.core.postMessage(gptActor, created.generalThread.id, "one");
      await waitFor(() => got.some((g) => body(g) === "one"));
    }, A);
    await s!.core.postMessage(gptActor, created.generalThread.id, "two"); // while A is down
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      await waitFor(() => got.some((g) => body(g) === "two")); // B (a different session) consumes it
    }, { CLAUDE_CODE_SESSION_ID: "session-B" });
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      await waitFor(() => got.some((g) => body(g) === "two")); // A resumed: still gets "two"
      expect(got.map(body)).toEqual(["two"]);
    }, A);
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      await s!.core.postMessage(gptActor, created.generalThread.id, "three");
      await waitFor(() => got.some((g) => body(g) === "three"));
      expect(got.map(body)).toEqual(["three"]); // fresh session: no replay of "two"
    }, { CLAUDE_CODE_SESSION_ID: "session-C" });
  });

  it("does not replay saved streams (or advance cursors) until the client has completed initialize", async () => {
    let created!: { secret: string; weave: { id: string }; generalThread: { id: string } };
    let gptActor!: Awaited<ReturnType<TestServer["core"]["resolveCredential"]>>;
    await withChannel(stateDir, async (c1) => {
      const got1 = collectNotifications(c1);
      created = json(await c1.callTool({ name: "create_weave", arguments: { title: "T", opener: "start", name: "Claude" } }));
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      gptActor = await s!.core.resolveCredential(gpt.token);
      await waitFor(() => got1.length >= 1);
    });
    const seqBefore = () => readState(stateDir).weaves[created.weave.id].lastSeq as number;
    const saved = seqBefore();
    // An event while the channel is down: it must wait for a client that can actually receive it.
    await s!.core.postMessage(gptActor, created.generalThread.id, "offline");

    // A raw stdio client that connects but does NOT initialize yet (the SDK Client initializes immediately).
    const child = spawn(process.execPath, [SERVER_JS], {
      env: { ...process.env, LOOM_URL: s!.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CHANNEL_STATE_DIR: stateDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: Record<string, unknown>[] = [];
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) lines.push(JSON.parse(l)); }
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    try {
      await waitFor(() => /connected/.test(stderr));
      await new Promise((r) => setTimeout(r, 1500));
      expect(lines, stderr).toEqual([]);
      expect(seqBefore()).toBe(saved);

      const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
      await waitFor(() => lines.some((l) => l.id === 1));
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await waitFor(() => lines.some((l) => l.method === "notifications/claude/channel"));
      const n = lines.find((l) => l.method === "notifications/claude/channel") as { params: { content: string; meta: Record<string, string> } };
      // Exactly the event, once the guidelines preamble this first turn carries is taken off.
      expect(body(n.params)).toBe("offline");
      await waitFor(() => seqBefore() > saved);
    } finally {
      child.kill();
    }
  });

  it("leave_weave stops delivery", async () => {
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "start", name: "Claude" } }));
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      await waitFor(() => got.length >= 1);
      await c.callTool({ name: "leave_weave", arguments: { weaveId: created.weave.id } });
      const gptActor = await s!.core.resolveCredential(gpt.token);
      await s!.core.postMessage(gptActor, created.generalThread.id, "after leave");
      await new Promise((r) => setTimeout(r, 500));
      expect(got.map((g) => g.meta.type)).toEqual(["participant.joined"]);
    });
  });

  it("an invite wakes a mentions-only session with thread_url; another session's prefs are its own", async () => {
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "start", name: "Claude" } }));
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      const gptActor = await s!.core.resolveCredential(gpt.token);
      await waitFor(() => got.some((g) => g.meta.type === "participant.joined"));
      const t = await s!.core.createThread(gptActor, created.weave.id, "PR 7", "https://github.com/poteb/Loom/pull/7");
      // A url change is a system event, so it only reaches a session while wake is still "all" —
      // do it here, before switching to "mentions", to cover the stream's url-refresh path.
      const CHANGED = "https://github.com/poteb/Loom/pull/7#changed";
      await s!.core.setThreadUrl(gptActor, t.id, CHANGED);
      await waitFor(() => got.some((g) => g.meta.type === "thread.url_changed"));
      const changed = got.find((g) => g.meta.type === "thread.url_changed")!;
      expect(changed.meta).toMatchObject({ thread: t.id, thread_name: "PR 7", thread_url: CHANGED });
      expect(body(changed)).toBe(`Thread "PR 7" now links to ${CHANGED}`);
      // …and the next event from that thread carries the refreshed url, not the stale one.
      await s!.core.postMessage(gptActor, t.id, "@Claude new link?");
      await waitFor(() => got.some((g) => body(g) === "@Claude new link?"));
      expect(got.find((g) => body(g) === "@Claude new link?")!.meta).toMatchObject({ thread: t.id, type: "message", thread_url: CHANGED });

      const prefs = json(await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id, wake: "mentions" } }));
      expect(prefs).toEqual({ weaveId: created.weave.id, wake: "mentions", invites: true });
      await s!.core.postMessage(gptActor, t.id, "not for you");                 // suppressed in mentions mode
      const inv = await s!.core.inviteParticipant(gptActor, t.id, created.participant.id);
      await waitFor(() => got.some((g) => g.meta.type === "thread.invited"));
      const wake = got.find((g) => g.meta.type === "thread.invited")!;
      expect(wake.meta).toMatchObject({ thread: t.id, thread_name: "PR 7", thread_url: CHANGED, seq: String(inv.seq), from: "ChatGPT" });
      expect(body(wake)).toContain('You were invited to Thread "PR 7" by ChatGPT');
      expect(got.some((g) => body(g) === "not for you")).toBe(false);
      // Session B on the same machine keeps default prefs and was never asked anything.
      const dirB = stateDir;
      await withChannel(dirB, async (b) => {
        const listed = json(await b.callTool({ name: "list_joined", arguments: {} }));
        expect(listed[0]).toMatchObject({ weaveId: created.weave.id, wake: "all", invites: true });
      }, { CLAUDE_CODE_SESSION_ID: "session-B" });
      await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id, invites: false } });
      const t2 = await s!.core.createThread(gptActor, created.weave.id, "PR 8");
      await s!.core.inviteParticipant(gptActor, t2.id, created.participant.id);
      await s!.core.postMessage(gptActor, t2.id, "@Claude wake up");
      await waitFor(() => got.some((g) => body(g) === "@Claude wake up"));
      expect(got.filter((g) => g.meta.type === "thread.invited")).toHaveLength(1);  // the second invite did not wake
    }, { CLAUDE_CODE_SESSION_ID: "session-A" });
  });
});

describe("subprocess stderr redaction", () => {
  it("never logs the URL credential or a joined Weave's token when the stream fails to connect on startup", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const TOKEN = "T".repeat(43);
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      weaves: {
        w1: { title: "T", token: TOKEN, participantId: "p1", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 0 },
      },
    }, null, 2) + "\n");

    const client = new Client({ name: "claude-code-like", version: "1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [SERVER_JS],
      // A URL-embedded credential and an unreachable loopback port so the restored Weave's stream
      // fails to connect immediately, exercising the failure-logging path.
      env: { ...process.env, LOOM_URL: "http://user:sekret@127.0.0.1:1", LOOM_ALLOW_INSECURE: "1", LOOM_CHANNEL_STATE_DIR: dir },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    try {
      await client.connect(transport);
      // The absence assertions below are only meaningful once the failure path has actually run and
      // logged, so *require* the stream-failure diagnostic (naming the weave) rather than waiting
      // out a swallowed timeout: a silent channel would otherwise pass this test vacuously.
      // (The client's own stream reconnects forever on a network error, so the diagnostic that is
      // guaranteed here is the startup name fetch; both startup failure lines name the weave.)
      await waitFor(() => /loom channel: (?:initial metadata fetch failed|stream start failed) for weave w1/.test(stderr), 10_000);
      // A little extra margin past the first log line, in case more diagnostics land shortly after.
      await new Promise((r) => setTimeout(r, 500));

      expect(stderr).toContain("for weave w1");
      expect(stderr).not.toContain("sekret");
      expect(stderr).not.toContain(TOKEN);
    } finally {
      await client.close();
    }
  });
});

describe("guidelines over the channel", () => {
  it("set_weave_guidelines takes the stored credential, and both joined Weaves' guidelines resources read", async () => {
    await withChannel(stateDir, async (c) => {
      const instance = (await api(s!.baseUrl, "GET", "/api/guidelines")).json.guidelines as string;
      const a = json(await c.callTool({ name: "create_weave", arguments: { title: "A", opener: "o", name: "Claude" } }));
      const b = json(await c.callTool({ name: "create_weave", arguments: { title: "B", opener: "o", name: "Claude", guidelines: "B rules" } }));

      const set = await c.callTool({ name: "set_weave_guidelines", arguments: { credential: "stored", weaveId: a.weave.id, guidelines: "A rules" } });
      expect(set.isError).toBeFalsy();
      expect(json(set)).toMatchObject({ weave: { id: a.weave.id, guidelines: "A rules" }, seq: expect.any(Number) });

      const textOf = async (id: string) => ((await c.readResource({ uri: `loom://weaves/${id}/guidelines` })).contents[0] as { text: string }).text;
      const ta = await textOf(a.weave.id);
      expect(ta).toContain(`${INSTANCE_HEADING}\n${instance}`);
      expect(ta).toContain(`${WEAVE_HEADING}\nA rules`);
      expect(await textOf(b.weave.id)).toContain(`${WEAVE_HEADING}\nB rules`);

      // A Weave this channel never joined has no stored token to read it with.
      await expect(c.readResource({ uri: `loom://weaves/${randomUUID()}/guidelines` })).rejects.toThrow(/forbidden/);

      const instanceRes = ((await c.readResource({ uri: "loom://guidelines" })).contents[0] as { text: string }).text;
      expect(instanceRes).toBe(instance);
    });
  });

  it("list_joined carries each Weave's combined guidelines", async () => {
    await withChannel(stateDir, async (c) => {
      const a = json(await c.callTool({ name: "create_weave", arguments: { title: "A", opener: "o", name: "Claude", guidelines: "A rules" } }));
      const listed = json(await c.callTool({ name: "list_joined", arguments: {} })) as { weaveId: string; guidelines: string }[];
      const mine = listed.find((w) => w.weaveId === a.weave.id)!;
      expect(mine.guidelines).toContain(`${WEAVE_HEADING}\nA rules`);
      expect(mine.guidelines).toContain(INSTANCE_HEADING);
    });
  });

  it("a repeat join_weave returns the stored identity carrying the guidelines as they stand now", async () => {
    await s!.core.seedKeepers([keeperToken("k1")]);
    const keeper = keeperToken("k1");
    await withChannel(stateDir, async (c) => {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "G", opener: "o", name: "Claude" } }));
      try {
        await c.callTool({ name: "set_weave_guidelines", arguments: { credential: "stored", weaveId: created.weave.id, guidelines: "Weave: one finding per message." } });
        const patched = await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeper, patch: { guidelines: "Instance: be terse." } } });
        expect(patched.isError).toBeFalsy();

        const again = json(await c.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "Claude" } }));
        expect(again.alreadyJoined).toBe(true);
        expect(again.guidelines).toContain("Instance: be terse.");
        expect(again.guidelines).toContain("Weave: one finding per message.");

        await c.callTool({ name: "set_weave_guidelines", arguments: { credential: "stored", weaveId: created.weave.id, guidelines: "" } });
        await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeper, patch: { guidelines: "" } } });
        const cleared = json(await c.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "Claude" } }));
        expect(cleared.alreadyJoined).toBe(true);
        expect(cleared.guidelines).toBe("");
      } finally {
        // Later files (and a re-run of this one) expect the shipped default on this instance.
        await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeper, patch: { guidelines: DEFAULT_INSTANCE_GUIDELINES } } });
      }
    });
  });

  it("a restored session whose cursor is already current still gets the guidelines, folded into its first event", async () => {
    let created!: { secret: string; weave: { id: string }; generalThread: { id: string } };
    let gptActor!: Awaited<ReturnType<TestServer["core"]["resolveCredential"]>>;
    const SESSION = { CLAUDE_CODE_SESSION_ID: "session-preamble" };
    // Session A consumes everything there is, so its cursor sits at the latest seq: a restart of it
    // will replay nothing at all — not the weave.guidelines_changed the Weave was created with, and
    // not the rules themselves.
    await withChannel(stateDir, async (a) => {
      const got = collectNotifications(a);
      created = json(await a.callTool({ name: "create_weave", arguments: { title: "G", opener: "o", name: "Claude", guidelines: "one finding per message" } }));
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      gptActor = await s!.core.resolveCredential(gpt.token);
      await s!.core.postMessage(gptActor, created.generalThread.id, "one");
      await waitFor(() => got.some((g) => body(g) === "one"));
      await waitFor(() => {
        const st = readState(stateDir);
        return st.sessions[SESSION.CLAUDE_CODE_SESSION_ID]?.cursors[created.weave.id] === st.weaves[created.weave.id].lastSeq;
      });
    }, SESSION);

    await withChannel(stateDir, async (b) => {
      const got = collectNotifications(b);
      await s!.core.postMessage(gptActor, created.generalThread.id, "two");
      await waitFor(() => got.length >= 1);
      expect(got[0]!.meta).toMatchObject({ preamble: "guidelines", type: "message", weave: created.weave.id });
      expect(got[0]!.content).toContain(INSTANCE_HEADING);
      expect(got[0]!.content).toContain(`${WEAVE_HEADING}\none finding per message`);
      expect(got[0]!.content.endsWith("\n\n---\n\ntwo")).toBe(true);   // one turn: the rules and the event

      await s!.core.postMessage(gptActor, created.generalThread.id, "three");
      await waitFor(() => got.length >= 2);
      expect(body(got[1]!)).toBe("three");
      expect(got[1]!.meta.preamble).toBeUndefined();
    }, SESSION);
  });
});
