// End-to-end v1 success scenario (see project spec §1): Claude Code (channel plugin over stdio)
// creates a Weave, hands the secret to a remote MCP client (standing in for ChatGPT), they
// collaborate across threads with mentions, and the Weave is archived.
//
// Requires a root `pnpm build` first — this spawns the built channel server at
// `src/claude-channel/dist/server.js` as a child process over stdio.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestServer, type TestServer } from "./helpers.js";

let s: TestServer | undefined;
beforeAll(async () => { s = await startTestServer(); });
afterAll(async () => { await s?.close(); });

const CHANNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../claude-channel/dist/server.js");
const Notification = z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) });
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
const waitFor = (pred: () => boolean, ms = 8000) => new Promise<void>((res, rej) => { const t0 = Date.now(); const tick = () => pred() ? res() : Date.now() - t0 > ms ? rej(new Error("timeout")) : setTimeout(tick, 25); tick(); });

describe("v1 success scenario", () => {
  it("Claude Code creates a Weave, ChatGPT joins via /mcp, they collaborate, the Weave is archived", async () => {
    // Claude Code side: the channel plugin over stdio
    const claude = new Client({ name: "claude-code", version: "1" });
    await claude.connect(new StdioClientTransport({
      command: process.execPath, args: [CHANNEL],
      env: { ...process.env, LOOM_URL: s!.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CHANNEL_STATE_DIR: mkdtempSync(path.join(tmpdir(), "loom-scn-")) },
      stderr: "pipe",
    }));
    const inbox: { content: string; meta: Record<string, string> }[] = [];
    claude.setNotificationHandler(Notification, (n) => { inbox.push(n.params); });

    // 1-2. The human asks Claude to create a Weave for a PR; Claude returns the secret.
    const created = json(await claude.callTool({ name: "create_weave", arguments: { title: "PR 42: rate limiter", opener: "Please review https://github.com/x/y/pull/42 with me.", name: "Claude", kind: "agent" } }));
    expect(created.secret).toHaveLength(43);

    // 3. The human gives the secret to ChatGPT, which connects to /mcp and joins.
    const gpt = new Client({ name: "chatgpt", version: "1" });
    await gpt.connect(new StreamableHTTPClientTransport(new URL(`${s!.baseUrl}/mcp`)));
    const joined = json(await gpt.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "ChatGPT", kind: "agent" } }));
    await waitFor(() => inbox.some((m) => m.meta.type === "participant.joined" && m.meta.from === "ChatGPT"));

    // 4. They collaborate: ChatGPT reads the opener, replies with a mention; Claude receives it as a channel turn and answers in a new thread.
    const events = json(await gpt.callTool({ name: "read_events", arguments: { credential: joined.token, weaveId: joined.weaveId, since: 0 } }));
    expect(events.find((e: { type: string }) => e.type === "message").payload.text).toContain("pull/42");
    await gpt.callTool({ name: "post_message", arguments: { credential: joined.token, threadId: created.generalThread.id, text: "@Claude the limiter never resets its window. Shall I open a thread?" } });
    await waitFor(() => inbox.some((m) => m.meta.type === "message" && m.content.includes("never resets")));
    const turn = inbox.find((m) => m.meta.type === "message")!;
    expect(turn.meta).toMatchObject({ weave: joined.weaveId, thread: created.generalThread.id, from: "ChatGPT", from_kind: "agent", mentions: created.participant.id });

    const thread = json(await claude.callTool({ name: "create_thread", arguments: { credential: "stored", weaveId: joined.weaveId, name: "Window reset bug" } }));
    await claude.callTool({ name: "post_message", arguments: { credential: "stored", threadId: thread.id, text: "@ChatGPT agreed, see limiter.ts:42 — the reset uses the wrong clock." } });
    const gptView = json(await gpt.callTool({ name: "read_events", arguments: { credential: joined.token, weaveId: joined.weaveId, threadId: thread.id } }));
    expect(gptView.map((e: { type: string }) => e.type)).toEqual(["thread.created", "message"]);
    expect(gptView[1].payload.mentions).toEqual([joined.participant.id]);

    // 5. (web UI covered by plan 2) 6. Claude, the keeper, archives; ChatGPT can still read/export.
    await claude.callTool({ name: "archive_weave", arguments: { credential: "stored", weaveId: joined.weaveId } });
    const late = await gpt.callTool({ name: "post_message", arguments: { credential: joined.token, threadId: created.generalThread.id, text: "late" } });
    expect(json(late).code).toBe("weave_archived");
    const md = (await gpt.callTool({ name: "export_weave", arguments: { credential: created.secret, weaveId: joined.weaveId, format: "md" } })).content as { text: string }[];
    expect(md[0]!.text).toContain("## Window reset bug");
    expect(md[0]!.text).toContain("_system: Weave archived_");

    await gpt.close();
    await claude.close();
  });
});
