import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";

// The Lobby half of the channel: joining it, the wake rules over a real stream, the two stored
// tokens a request needs, redeeming the invitation it produces, and the two-step leave. The same
// in-process harness as channel.test.ts (which is already long enough), spelled out here because
// importing a test module would run its suites a second time.
let s: TestServer | undefined;
beforeAll(async () => { s = await startTestServer(); await s.core.ensureLobby(); });
afterAll(async () => { await s?.close(); });

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(path.join(tmpdir(), "loom-lb-")); });

const SERVER_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/server.js");

async function withChannel<T>(dir: string, fn: (client: Client) => Promise<T>, extraEnv: Record<string, string> = {}): Promise<T> {
  let stderrBuf = "";
  const client = new Client({ name: "claude-code-like", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_JS],
    env: { ...process.env, LOOM_URL: s!.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CHANNEL_STATE_DIR: dir, ...extraEnv },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });
  await client.connect(transport);
  try {
    return await fn(client);
  } catch (err) {
    if (stderrBuf) (err as Error).message += `\n--- channel stderr ---\n${stderrBuf}`;
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}

const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
function readState(dir: string) {
  const versions = readdirSync(dir).map((f) => /^config\.(\d+)\.json$/.exec(f)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  if (versions.length === 0) throw new Error(`no state committed in ${dir}`);
  return JSON.parse(readFileSync(path.join(dir, `config.${Math.max(...versions)}.json`), "utf8"));
}

const ChannelNotification = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});
type Note = { content: string; meta: Record<string, string> };
function collectNotifications(c: Client): Note[] {
  const got: Note[] = [];
  c.setNotificationHandler(ChannelNotification, (n) => { got.push(n.params); });
  return got;
}
/** The event text alone: the first turn for a Weave carries the guidelines preamble ahead of it. */
function body(n: Note): string {
  if (n.meta.preamble !== "guidelines") return n.content;
  const sep = "\n\n---\n\n";
  return n.content.slice(n.content.indexOf(sep) + sep.length);
}
function waitFor(pred: () => boolean, what = "condition", ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error(`timeout waiting for ${what}`)); else setTimeout(tick, 25); };
    tick();
  });
}
const typed = (got: Note[], type: string) => got.find((g) => g.meta.type === type);

/**
 * The profile the Lobby carries for a participant, or null when it carries none. Read through
 * `find_agents`: `getWeave` carries no Lobby profile at all now (core spec §3.1), and `find_agents`
 * lists only participants that have one, so an absent entry is a cleared profile.
 *
 * …*provided the participant is still there*. An absent `find_agents` entry would otherwise read
 * the same for a listener that had vanished altogether, which is not what leaving promises, so the
 * row itself is asserted first: `getWeave` still lists every Lobby participant, minus their
 * profiles.
 */
async function profileOf(credential: string, participantId: string): Promise<unknown> {
  const actor = await s!.core.resolveCredential(credential);
  const info = await s!.core.getWeave(actor, await lobbyId());
  expect(info.participants.some((p) => p.id === participantId)).toBe(true);
  return (await s!.core.findAgents(actor, {})).find((a) => a.participant.id === participantId)?.capabilities ?? null;
}

/** Lobby names are unique per instance, and the Lobby outlives every test in this file. */
let n = 0;
const uniq = (prefix: string) => `${prefix}-${++n}`;
const HELPER_PROFILE = { owner: "bob", serves: "anyone", models: [{ model: "gpt-5.6-sol", effort: "high" }], tools: ["shell"], runtime: "claude-code", spawnsSubagents: true };
const REQUIREMENTS = { models: [{ model: "gpt-5.6-sol" }] };
const lobbyId = async () => (await s!.core.getLobby()).weaveId;

describe("the Lobby over the channel", () => {
  it("runs the whole loop: two stored tokens open a request, an offer is accepted, and the invitation lands the helper in the target Weave", async () => {
    const dirB = mkdtempSync(path.join(tmpdir(), "loom-lb-"));
    const L = await lobbyId();
    await withChannel(stateDir, async (a) => {
      const gotA = collectNotifications(a);
      // The requester's two identities, both stored by this channel: keeper of the target Weave…
      const target = json(await a.callTool({ name: "create_weave", arguments: { title: "Loom session", opener: "start", name: uniq("Claude") } }));
      // …and a Lobby participant, which is what `credential: "stored"` means for every Lobby tool.
      const lob = json(await a.callTool({ name: "join_lobby", arguments: { name: uniq("Asker") } }));
      expect(lob.weaveId).toBe(L);
      expect(readState(stateDir).weaves[L]).toMatchObject({ token: lob.token, isLobby: true });
      await a.callTool({ name: "set_capabilities", arguments: { credential: "stored", profile: { owner: "paw", serves: "anyone" } } });
      // Mentions-only from here on: every Lobby event that follows wakes because it is addressed.
      await a.callTool({ name: "set_wake", arguments: { weaveId: L, wake: "mentions" } });

      await withChannel(dirB, async (b) => {
        const gotB = collectNotifications(b);
        const helper = json(await b.callTool({ name: "join_lobby", arguments: { name: uniq("Helper") } }));
        await b.callTool({ name: "set_capabilities", arguments: { credential: "stored", profile: HELPER_PROFILE } });

        const req = json(await a.callTool({ name: "open_request", arguments: {
          credential: "stored", title: "Review PR 14", requirements: REQUIREMENTS, wanted: 1,
          targetWeaveId: target.weave.id, targetThreadId: target.generalThread.id, targetCredential: "stored",
        } }));
        expect(req.eligible).toContain(helper.participant.id);

        await waitFor(() => gotB.some((g) => g.meta.type === "request.opened"), "request.opened on the helper");
        const opened = typed(gotB, "request.opened")!;
        expect(opened.meta).toMatchObject({ weave: L, request: req.id, thread_name: "Review PR 14" });
        expect(body(opened)).toMatch(new RegExp(`^Request "Review PR 14": wants 1, until \\d\\d:\\d\\d — you are eligible; offer with offer\\(${req.id}\\)$`));
        expect(typed(gotA, "request.opened")).toBeUndefined();          // never woken by its own request
        // …nor is the helper woken by the request Thread's companion (the Lobby's own General
        // thread.created, replayed from the start of the log, is an ordinary one and does wake).
        expect(gotB.some((g) => g.meta.type === "thread.created" && g.meta.request === req.id)).toBe(false);

        // The requester's own view of the Lobby, read with the token the channel stored for it.
        const listed: { id: string }[] = JSON.parse(((await a.readResource({ uri: "loom://lobby/requests" })).contents[0] as { text: string }).text);
        expect(listed.map((r) => r.id)).toContain(req.id);

        expect((await b.callTool({ name: "offer", arguments: { credential: "stored", requestId: req.id, model: "gpt-5.6-sol", effort: "high", note: "can start now" } })).isError).toBeFalsy();
        await waitFor(() => gotA.some((g) => g.meta.type === "request.offered"), "request.offered on the requester");
        expect(body(typed(gotA, "request.offered")!)).toBe(`Offer from ${helper.participant.name} (gpt-5.6-sol/high): "can start now"`);

        expect((await a.callTool({ name: "accept", arguments: { credential: "stored", requestId: req.id, participantIds: [helper.participant.id], deadlineMs: 3_600_000 } })).isError).toBeFalsy();
        await waitFor(() => gotB.some((g) => g.meta.type === "weave.invited"), "weave.invited on the helper");
        expect(body(typed(gotB, "request.accepted")!)).toBe('Accepted: you were invited to "Loom session" — the invitation id arrives on the weave.invited event beside this (or from inbox); redeem with join_weave({ inviteId })');
        const invited = typed(gotB, "weave.invited")!;
        expect(invited.meta.invitation).toBeTruthy();
        // The closure that acceptance caused is the requester's own act, so it does not wake it
        // (a closure it did not cause does — see the restored-session test below).
        expect(typed(gotA, "request.closed")).toBeUndefined();

        // Redeemed with the Lobby identity the channel holds: no secret anywhere in this test.
        const landed = json(await b.callTool({ name: "join_weave", arguments: { inviteId: invited.meta.invitation } }));
        expect(landed.weaveId).toBe(target.weave.id);
        expect(Object.keys(readState(dirB).weaves).sort()).toEqual([L, target.weave.id].sort());

        // …and the target Weave's stream is running for the helper, as after a secret join.
        await a.callTool({ name: "post_message", arguments: { credential: "stored", threadId: target.generalThread.id, text: `welcome @${helper.participant.name}` } });
        await waitFor(() => gotB.some((g) => body(g) === `welcome @${helper.participant.name}`), "the target Weave message on the helper");
      });
    });
  });

  it("silences new requests when requests is off, without silencing an invitation addressed to me", async () => {
    const L = await lobbyId();
    await withChannel(stateDir, async (b) => {
      const got = collectNotifications(b);
      const helper = json(await b.callTool({ name: "join_lobby", arguments: { name: uniq("Quiet") } }));
      await b.callTool({ name: "set_capabilities", arguments: { credential: "stored", profile: HELPER_PROFILE } });
      expect(json(await b.callTool({ name: "set_wake", arguments: { weaveId: L, requests: false } })))
        .toEqual({ weaveId: L, wake: "all", invites: true, requests: false });

      // A requester elsewhere on the instance, with a Weave of its own to invite into.
      const asker = await s!.core.joinLobby({ name: uniq("Asker"), kind: "agent" });
      const askerLobby = await s!.core.resolveCredential(asker.token);
      await s!.core.setCapabilities(askerLobby, { owner: "paw", serves: "anyone" });
      const weave = await s!.core.createWeave({ title: "Nightly", opener: "o", creator: { name: uniq("Paw"), kind: "human" } });
      const askerTarget = await s!.core.resolveCredential(weave.token);
      const req = await s!.core.openRequest(askerLobby, askerTarget, {
        title: "Review PR 15", requirements: REQUIREMENTS, wanted: 1,
        targetWeaveId: weave.weave.id, targetThreadId: weave.generalThread.id, url: null,
      });
      expect(req.eligible).toContain(helper.participant.id);   // eligible, and still not woken:
      await new Promise((r) => setTimeout(r, 500));
      expect(typed(got, "request.opened")).toBeUndefined();

      await s!.core.inviteToWeave(askerTarget, helper.participant.id, weave.weave.id, weave.generalThread.id);
      await waitFor(() => got.some((g) => g.meta.type === "weave.invited"), "weave.invited");
      expect(body(typed(got, "weave.invited")!)).toBe('Invited to "Nightly" — join_weave({ inviteId: "' + typed(got, "weave.invited")!.meta.invitation + '" })');
    });
  });

  it("wakes a restored mentions-only session with the closure of the request it left behind", async () => {
    const L = await lobbyId();
    const SESSION = { CLAUDE_CODE_SESSION_ID: "lobby-restore" };
    let requestId = "";
    await withChannel(stateDir, async (a) => {
      const target = json(await a.callTool({ name: "create_weave", arguments: { title: "Fix build", opener: "o", name: uniq("Claude") } }));
      await a.callTool({ name: "join_lobby", arguments: { name: uniq("Asker") } });
      await a.callTool({ name: "set_capabilities", arguments: { credential: "stored", profile: { owner: "paw", serves: "anyone" } } });
      await a.callTool({ name: "set_wake", arguments: { weaveId: L, wake: "mentions" } });
      requestId = json(await a.callTool({ name: "open_request", arguments: {
        credential: "stored", title: "Fix the build", requirements: REQUIREMENTS, wanted: 1,
        targetWeaveId: target.weave.id, targetThreadId: target.generalThread.id, targetCredential: "stored",
      } })).id;
    }, SESSION);

    // The deadline passes while the session is away, and the sweeper closes it.
    await s!.core.db.$client.unsafe("update requests set expires_at = now() - interval '1 minute' where id = $1", [requestId] as never);
    expect((await s!.sweepNow()).closed).toBeGreaterThanOrEqual(1);

    await withChannel(stateDir, async (a2) => {
      const got = collectNotifications(a2);
      await waitFor(() => got.some((g) => g.meta.type === "request.closed"), "request.closed after restore");
      const closed = typed(got, "request.closed")!;
      expect(closed.meta).toMatchObject({ weave: L, request: requestId });
      expect(body(closed)).toBe('Request "Fix the build" expired: nobody accepted');
      expect(got.some((g) => g.meta.type === "thread.closed")).toBe(false);   // the companion Thread closure wakes nobody
    }, SESSION);
  });

  // join_lobby is not the only way in: the Lobby has a secret of its own, and an identity that
  // reached it that way owes the same two-step on the way out (spec 5).
  it("recognises a Lobby joined by its secret, so leaving still clears the profile", async () => {
    const L = await lobbyId();
    const { secret } = await s!.core.ensureLobby();                 // idempotent; the Lobby's own secret
    await withChannel(stateDir, async (a) => {
      const j = json(await a.callTool({ name: "join_weave", arguments: { secret, name: uniq("Sneaky") } }));
      expect(j.weaveId).toBe(L);
      expect(readState(stateDir).weaves[L]).toMatchObject({ token: j.token, isLobby: true });
      await a.callTool({ name: "set_capabilities", arguments: { credential: j.token, profile: { owner: "paw", serves: "anyone" } } });
      expect(await profileOf(j.token, j.participant.id)).toMatchObject({ owner: "paw" });

      const left = json(await a.callTool({ name: "leave_weave", arguments: { weaveId: L } }));
      expect(left).toEqual({ weaveId: L, left: true });
      // The point of the flag: the profile is gone from the server before the credential is,
      // so nothing eligible is left behind with nobody to answer for it.
      expect(await profileOf(j.token, j.participant.id)).toBeNull();
      expect(readState(stateDir).weaves[L]).toBeUndefined();
    });
  });

  it("clears the Lobby profile on the server before it forgets the credential", async () => {
    const L = await lobbyId();
    await withChannel(stateDir, async (a) => {
      const lob = json(await a.callTool({ name: "join_lobby", arguments: { name: uniq("Leaver") } }));
      await a.callTool({ name: "set_capabilities", arguments: { credential: "stored", profile: { owner: "paw", serves: "anyone" } } });
      expect(await profileOf(lob.token, lob.participant.id)).toMatchObject({ owner: "paw" });

      const left = json(await a.callTool({ name: "leave_weave", arguments: { weaveId: L } }));
      expect(left).toEqual({ weaveId: L, left: true });
      expect(readState(stateDir).weaves[L]).toBeUndefined();
      expect(await profileOf(lob.token, lob.participant.id)).toBeNull();
    });
  });

  it("complete and remove_participant work with credential stored", async () => {
    const dirB = mkdtempSync(path.join(tmpdir(), "loom-lb-"));
    await withChannel(stateDir, async (a) => {
      const target = json(await a.callTool({ name: "create_weave", arguments: { title: "Stored work", opener: "start", name: uniq("Claude") } }));
      await a.callTool({ name: "join_lobby", arguments: { name: uniq("Asker") } });
      await a.callTool({ name: "set_capabilities", arguments: { credential: "stored", profile: { owner: "paw", serves: "anyone" } } });
      await withChannel(dirB, async (b) => {
        const helper = json(await b.callTool({ name: "join_lobby", arguments: { name: uniq("Helper") } }));
        await b.callTool({ name: "set_capabilities", arguments: { credential: "stored", profile: HELPER_PROFILE } });
        const ask = async (title: string) => json(await a.callTool({ name: "open_request", arguments: {
          credential: "stored", title, requirements: REQUIREMENTS, wanted: 1,
          targetWeaveId: target.weave.id, targetThreadId: target.generalThread.id, targetCredential: "stored",
        } }));
        const acceptIt = async (id: string) => {
          expect((await b.callTool({ name: "offer", arguments: { credential: "stored", requestId: id } })).isError).toBeFalsy();
          expect((await a.callTool({ name: "accept", arguments: { credential: "stored", requestId: id, participantIds: [helper.participant.id], deadlineMs: 3_600_000 } })).isError).toBeFalsy();
        };
        const done = await ask("Stored complete");
        await acceptIt(done.id);
        expect(json(await b.callTool({ name: "complete", arguments: { credential: "stored", requestId: done.id } })).status).toBe("completed");

        const dropped = await ask("Stored removal");
        await acceptIt(dropped.id);
        // "stored" finds a Thread's Weave through the streams, which learn the request Thread when its
        // thread.created arrives on the Lobby stream; until then the wrapper answers no_weave.
        const remove = () => a.callTool({ name: "remove_participant", arguments: { credential: "stored", threadId: dropped.threadId, participantId: helper.participant.id } });
        let removed = await remove();
        for (let i = 0; i < 100 && removed.isError && json(removed).code === "no_weave"; i++) {
          await new Promise((r) => setTimeout(r, 50));
          removed = await remove();
        }
        expect(removed.isError).toBeFalsy();
        expect(json(removed)).toMatchObject({ created: true, acceptanceRemoved: true });
      });
    });
  });
});
