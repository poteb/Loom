import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";

let s: TestServer | undefined;
beforeAll(async () => { s = await startTestServer(); });
afterAll(async () => { await s?.close(); });

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(path.join(tmpdir(), "loom-ch-")); });

const SERVER_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/server.js");

export async function spawnChannel(dir: string, onStderr?: (chunk: string) => void): Promise<Client> {
  const client = new Client({ name: "claude-code-like", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_JS],
    env: { ...process.env, LOOM_URL: s!.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CHANNEL_STATE_DIR: dir },
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
async function withChannel<T>(dir: string, fn: (client: Client, getStderr: () => string) => Promise<T>): Promise<T> {
  let stderrBuf = "";
  const client = await spawnChannel(dir, (chunk) => { stderrBuf += chunk; });
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

describe("channel tools", () => {
  it("advertises the claude/channel capability and all tools", async () => {
    await withChannel(stateDir, async (c) => {
      const caps = c.getServerCapabilities();
      expect(caps?.experimental).toHaveProperty("claude/channel");
      const { tools } = await c.listTools();
      const names = tools.map((t) => t.name);
      for (const n of ["create_weave", "join_weave", "post_message", "read_events", "leave_weave", "set_wake", "list_joined"]) expect(names).toContain(n);
      expect(c.getInstructions()).toMatch(/<channel source="loom"/);
    });
  });

  it("create_weave and join_weave persist the token; leave_weave forgets it", async () => {
    await withChannel(stateDir, async (c) => {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
      let cfg = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
      expect(cfg.weaves[created.weave.id]).toMatchObject({ token: created.token, participantId: created.participant.id, wake: "all", lastSeq: 0, generalThreadId: created.generalThread.id });
      const listed = json(await c.callTool({ name: "list_joined", arguments: {} }));
      expect(listed).toEqual([expect.objectContaining({ weaveId: created.weave.id, title: "T", participantName: "Claude", wake: "all" })]);
      const waked = await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id, wake: "mentions" } });
      expect(waked.isError).toBeFalsy();
      expect(json(waked)).toEqual({ weaveId: created.weave.id, wake: "mentions" });
      cfg = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
      expect(cfg.weaves[created.weave.id].wake).toBe("mentions");
      const left = await c.callTool({ name: "leave_weave", arguments: { weaveId: created.weave.id } });
      expect(left.isError).toBeFalsy();
      expect(json(left)).toEqual({ weaveId: created.weave.id, left: true });
      cfg = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
      expect(cfg.weaves).toEqual({});
      const unknown = await c.callTool({ name: "leave_weave", arguments: { weaveId: created.weave.id } });
      expect(unknown.isError).toBe(true);
      expect(json(unknown)).toEqual({ code: "no_weave", message: expect.any(String) });
    });
  });

  it("join_weave persists the joiner's own identity in its own state dir", async () => {
    await withChannel(stateDir, async (a) => {
      const created = json(await a.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
      const stateDirB = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
      await withChannel(stateDirB, async (b) => {
        const joined = json(await b.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "Other" } }));
        expect(joined).toMatchObject({ token: expect.any(String), participant: { name: "Other" } });
        const cfg = JSON.parse(readFileSync(path.join(stateDirB, "config.json"), "utf8"));
        expect(cfg.weaves[created.weave.id]).toMatchObject({
          token: joined.token, participantId: joined.participant.id, participantName: "Other",
          generalThreadId: created.generalThread.id, wake: "all", lastSeq: 0, title: created.weave.title,
        });
        const listed = json(await b.callTool({ name: "list_joined", arguments: {} }));
        expect(listed).toEqual([expect.objectContaining({ weaveId: created.weave.id, title: created.weave.title, participantName: "Other", wake: "all" })]);
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
      expect(got[1]!.content).toBe("Hello @Claude, I joined");
      expect(got[1]!.meta).toMatchObject({ thread: created.generalThread.id, thread_name: "General", type: "message", from: "ChatGPT", from_kind: "agent", seq: "5", mentions: created.participant.id });
      // own message is not pushed back
      await c.callTool({ name: "post_message", arguments: { credential: "stored", threadId: created.generalThread.id, text: "thanks" } });
      await s!.core.postMessage(gptActor, created.generalThread.id, "np");
      await waitFor(() => got.length >= 3);
      expect(got.map((g) => g.meta.seq)).toEqual(["4", "5", "7"]);
      await waitFor(() => JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8")).weaves[created.weave.id].lastSeq === 7);
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
      expect(got2.map((g) => g.content)).toEqual(["two"]);
      await s!.core.postMessage(gptActor, created.generalThread.id, "three");
      await waitFor(() => got2.length >= 2);
      expect(got2[1]!.content).toBe("three");
    });
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
      await waitFor(() => /initial name fetch failed|stream for weave/.test(stderr), 2000).catch(() => {});
      // A little extra margin past the first log line, in case more diagnostics land shortly after.
      await new Promise((r) => setTimeout(r, 500));

      expect(stderr).not.toContain("sekret");
      expect(stderr).not.toContain(TOKEN);
    } finally {
      await client.close();
    }
  });
});
