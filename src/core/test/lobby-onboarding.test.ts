import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { requests as requestsTable, weaveInvitations, weaves } from "../src/db/schema.js";
import { createCore, type Core } from "../src/index.js";
import type { Db } from "../src/db/index.js";
import type { Actor } from "../src/types.js";

afterAll(closeTestDb);
let db: Db; let core: Core; let lobbyId: string;
beforeEach(async () => {
  db = await freshDb();
  core = createCore(db);
  await core.seedKeepers([keeperToken("k")]);
  lobbyId = (await core.ensureLobby()).weaveId;
});

const MODEL = { model: "gpt-5.6-sol", effort: "high" };
const keeper = () => core.resolveCredential(keeperToken("k"));
const agentKey = async (name: string, owner?: string): Promise<Actor> =>
  core.resolveCredential((await core.addAgent(await keeper(), name, owner)).key);

/** A listener behind a key owned by paw, standing in the Lobby with a profile that serves paw. */
async function listener() {
  const agent = await agentKey("ChatGPT", "paw");
  const joined = await core.joinLobby({ kind: "agent" }, agent);
  await core.setCapabilities(agent, { models: [MODEL], serves: "owner" });
  return { agent, id: joined.participant.id };
}

/** A requester behind a key owned by paw, keeper of its own Weave, standing in the Lobby. */
async function requester(name: string) {
  const agent = await agentKey(name, "paw");
  const target = await core.createWeave({ title: `${name}'s Weave`, opener: "", creator: { name, kind: "agent" } }, agent);
  const thread = await core.createThread(agent, target.weave.id, "PR 14");
  await core.joinLobby({ kind: "agent" }, agent);
  await core.setCapabilities(agent, { runtime: "claude-code" });
  const open = (title: string) => core.openRequest(agent, undefined, {
    title, requirements: { models: [MODEL] }, wanted: 1, targetWeaveId: target.weave.id, targetThreadId: thread.id, url: null,
  });
  return { agent, target, thread, open };
}

/** A Weave kept by a human host with one open Thread, to invite from. */
async function host(title: string) {
  const w = await core.createWeave({ title, opener: "", creator: { name: "Host", kind: "human" } });
  const actor = await core.resolveCredential(w.token);
  const thread = await core.createThread(actor, w.weave.id, "Work");
  return { actor, weaveId: w.weave.id, threadId: thread.id };
}

describe("onboardingFacts", () => {
  it("onboardingFacts refuses anything but an agent key", async () => {
    const w = await core.createWeave({ title: "T", opener: "", creator: { name: "P", kind: "human" } });
    for (const actor of [await keeper(), await core.resolveCredential(w.token), await core.resolveCredential(w.secret)]) {
      await expect(core.onboardingFacts(actor)).rejects.toMatchObject({
        code: "validation", message: "get_started needs an agent-key connection: connect with ?agent=<key> on the /mcp URL",
      });
    }
  });

  it("facts before join_lobby have me null", async () => {
    const agent = await agentKey("ChatGPT", "paw");
    expect(await core.onboardingFacts(agent)).toEqual({
      agent: { name: "ChatGPT", owner: "paw" }, lobby: { weaveId: lobbyId, title: "Lobby" },
      me: null, invitations: [], requests: [],
    });
  });

  it("facts with a participant and no profile have hasProfile false", async () => {
    const agent = await agentKey("ChatGPT");
    const joined = await core.joinLobby({ kind: "agent" }, agent);
    const facts = await core.onboardingFacts(agent);
    expect(facts.agent).toEqual({ name: "ChatGPT", owner: null });
    expect(facts.me).toEqual({ participantId: joined.participant.id, name: "ChatGPT", hasProfile: false });
  });

  it("facts list unredeemed invitations with their Weave titles and request ids, and leave out redeemed, revoked, archived-target and closed-Thread ones", async () => {
    const l = await listener();
    const kept = await host("Alpha");
    const direct = await core.inviteToWeave(kept.actor, l.id, kept.weaveId, kept.threadId);
    const redeemedHost = await host("Bravo");
    const toRedeem = await core.inviteToWeave(redeemedHost.actor, l.id, redeemedHost.weaveId, redeemedHost.threadId);
    await core.joinWeave("", { kind: "agent" }, l.agent, { inviteId: toRedeem.invitationId });
    const revokedHost = await host("Charlie");
    const toRevoke = await core.inviteToWeave(revokedHost.actor, l.id, revokedHost.weaveId, revokedHost.threadId);
    await db.update(weaveInvitations).set({ revokedAt: new Date() }).where(eq(weaveInvitations.id, toRevoke.invitationId));
    const archivedHost = await host("Delta");
    await core.inviteToWeave(archivedHost.actor, l.id, archivedHost.weaveId, archivedHost.threadId);
    await core.archiveWeave(archivedHost.actor, archivedHost.weaveId);
    const closedHost = await host("Echo");
    await core.inviteToWeave(closedHost.actor, l.id, closedHost.weaveId, closedHost.threadId);
    await core.closeThread(closedHost.actor, closedHost.threadId);
    const r = await requester("Claude-Code");
    const request = await r.open("Review PR 14");
    await core.offer(l.agent, request.id, {});
    const accepted = await core.acceptRequest(r.agent, request.id, [l.id], 3_600_000);
    expect((await core.onboardingFacts(l.agent)).invitations).toEqual([
      { inviteId: direct.invitationId, weaveTitle: "Alpha", requestId: null },
      { inviteId: accepted.invitationIds[0], weaveTitle: "Claude-Code's Weave", requestId: request.id },
    ]);
  });

  it("facts list open eligible requests I have not offered on, and leave out offered, closed, window-expired and my own", async () => {
    const l = await listener();
    const r = await requester("Claude-Code");
    const wanted = await r.open("Ask 1");
    const offered = await r.open("Ask 2");
    await core.offer(l.agent, offered.id, {});
    const cancelled = await r.open("Ask 3");
    await core.cancelRequest(r.agent, cancelled.id);
    const lapsed = await r.open("Ask 4");
    await db.update(requestsTable).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(requestsTable.id, lapsed.id));
    // The listener's own request: it keeps a Weave of its own to ask for help in.
    const mine = await core.createWeave({ title: "Mine", opener: "", creator: { name: "ChatGPT", kind: "agent" } }, l.agent);
    const mineThread = await core.createThread(l.agent, mine.weave.id, "Own work");
    await core.openRequest(l.agent, undefined, { title: "My own", requirements: {}, wanted: 1, targetWeaveId: mine.weave.id, targetThreadId: mineThread.id, url: null });
    expect((await core.onboardingFacts(l.agent)).requests).toEqual([
      { requestId: wanted.id, title: "Ask 1", expiresAt: wanted.expiresAt },
    ]);
  });

  it("onboardingFacts appends no event", async () => {
    const l = await listener();
    const r = await requester("Claude-Code");
    await r.open("Ask 1");
    const lastSeq = async () => (await db.select({ n: weaves.lastSeq }).from(weaves).where(eq(weaves.id, lobbyId)))[0]!.n;
    const before = await lastSeq();
    await core.onboardingFacts(l.agent);
    expect(await lastSeq()).toBe(before);
  });
});
