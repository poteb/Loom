import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { setRole } from "../src/participants.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities } from "../src/lobby/profile.js";
import { accept, complete, offer, openRequest, sweepOverdue, sweepRequests } from "../src/lobby/requests.js";
import { inviteParticipant } from "../src/invites.js";
import { postMessage } from "../src/messages.js";
import { removeParticipant } from "../src/removals.js";
import { inbox } from "../src/inbox.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { createCore } from "../src/index.js";
import { keeperToken } from "./helpers.js";
import { MAX_PAGE_LIMIT } from "../src/paging.js";
import type { Db } from "../src/db/index.js";
import type { Actor } from "../src/types.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

describe("inbox", () => {
  it("returns only invites to me and messages mentioning me, in seq order, never my own events", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const paw = await resolveCredential(db, r.token);
    const b = await joinWeave(db, bus, r.secret, { name: "Bot", kind: "agent" });
    const bot = await resolveCredential(db, b.token);
    const o = await joinWeave(db, bus, r.secret, { name: "Other", kind: "agent" });
    const t = await createThread(db, bus, paw, r.weave.id, "PR 1", "https://e.com/1");
    const inv = await inviteParticipant(db, bus, paw, t.id, b.participant.id);
    await inviteParticipant(db, bus, paw, t.id, o.participant.id);                 // someone else's invite
    const m1 = await postMessage(db, bus, paw, t.id, "@Bot please review");
    await postMessage(db, bus, paw, t.id, "@Other you too");                       // not for me
    await postMessage(db, bus, bot, t.id, "@Paw on it");                           // my own message (mentions Paw, not me)
    await postMessage(db, bus, bot, t.id, "@Bot noted");                           // my own message mentioning me: only the actor filter excludes it
    const m2 = await postMessage(db, bus, paw, r.generalThread.id, "ping @Bot again");
    const mine = await inbox(db, bot, r.weave.id, {});
    expect(mine.map((e) => [e.type, e.seq])).toEqual([["thread.invited", inv.seq], ["message", m1.seq], ["message", m2.seq]]);
    // Each item carries its Thread, so an invite arrives with the artefact's URL in one call.
    expect(mine[0]).toMatchObject({ threadName: "PR 1", threadUrl: "https://e.com/1" });
    expect(mine[2]).toMatchObject({ threadName: "General", threadUrl: null });
    const later = await inbox(db, bot, r.weave.id, { since: m1.seq });
    expect(later.map((e) => e.seq)).toEqual([m2.seq]);
    // No `since`: the most recent addressed events, not the oldest page (a remote agent with no
    // cursor wants what it just missed).
    const one = await inbox(db, bot, r.weave.id, { limit: 1 });
    expect(one.map((e) => e.seq)).toEqual([m2.seq]);
    const two = await inbox(db, bot, r.weave.id, { limit: 2 });
    expect(two.map((e) => e.seq)).toEqual([m1.seq, m2.seq]);   // newest two, still ascending
  });
  it("needs a participant credential of that Weave", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "", creator: { name: "Paw", kind: "human" } });
    const bySecret = await resolveCredential(db, r.secret);
    await expect(inbox(db, bySecret, r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
    const other = await createWeave(db, bus, { title: "O", opener: "", creator: { name: "Q", kind: "human" } });
    await expect(inbox(db, await resolveCredential(db, other.token), r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects an out-of-range page, malformed ids and keepers", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const paw = await resolveCredential(db, r.token);
    const b = await joinWeave(db, bus, r.secret, { name: "Bot", kind: "agent" });
    const bot = await resolveCredential(db, b.token);
    const t = await createThread(db, bus, paw, r.weave.id, "PR 1", null);
    const inv = await inviteParticipant(db, bus, paw, t.id, b.participant.id);
    const m1 = await postMessage(db, bus, paw, t.id, "@Bot please review");
    const m2 = await postMessage(db, bus, paw, t.id, "@Bot again");
    await expect(inbox(db, bot, r.weave.id, { limit: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(inbox(db, bot, r.weave.id, { limit: 5000 })).rejects.toMatchObject({ code: "validation" });
    await expect(inbox(db, bot, r.weave.id, { since: -1 })).rejects.toMatchObject({ code: "validation" });
    expect((await inbox(db, bot, r.weave.id, { limit: MAX_PAGE_LIMIT })).map((e) => e.seq)).toEqual([inv.seq, m1.seq, m2.seq]);
    await expect(inbox(db, bot, "nope", {})).rejects.toMatchObject({ code: "weave_not_found" });
    await seedKeepers(db, [keeperToken("k1")]);
    const keeper = await resolveCredential(db, keeperToken("k1"));
    await expect(inbox(db, keeper, r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
  it("facade maps an agent key to its participant", async () => {
    const core = createCore(db);
    await core.seedKeepers([keeperToken("k1")]);
    const keeper = await core.resolveCredential(keeperToken("k1"));
    const r = await core.createWeave({ title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const paw = await core.resolveCredential(r.token);
    const { key } = await core.addAgent(keeper, "Bot");
    const agent = await core.resolveCredential(key);
    await core.joinWeave(r.secret, { name: "Bot", kind: "agent" }, agent);
    const m = await core.postMessage(paw, r.generalThread.id, "@Bot hi");
    expect((await core.inbox(agent, r.weave.id, {})).map((e) => e.seq)).toEqual([m.seq]);
    const other = await core.createWeave({ title: "O", opener: "", creator: { name: "Q", kind: "human" } });
    await expect(core.inbox(agent, other.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("inbox returns thread.removed naming me and not others", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "", creator: { name: "Paw", kind: "human" } });
    const paw = await resolveCredential(db, r.token);
    const b = await joinWeave(db, bus, r.secret, { name: "Bot", kind: "agent" });
    const o = await joinWeave(db, bus, r.secret, { name: "Other", kind: "agent" });
    const t = await createThread(db, bus, paw, r.weave.id, "PR 1", null);
    await inviteParticipant(db, bus, paw, t.id, b.participant.id);
    await inviteParticipant(db, bus, paw, t.id, o.participant.id);
    const removed = await removeParticipant(db, bus, paw, t.id, b.participant.id);
    const mine = await inbox(db, await resolveCredential(db, b.token), r.weave.id, {});
    expect(mine.filter((e) => e.type === "thread.removed").map((e) => e.seq)).toEqual([removed.seq]);
    const theirs = await inbox(db, await resolveCredential(db, o.token), r.weave.id, {});
    expect(theirs.map((e) => e.type)).not.toContain("thread.removed");
  });
});

const MODEL = { model: "gpt-5.6-sol", effort: "high" };

/**
 * The spec's Lobby scenario as rows: a requester owned by "paw", two listeners its requirements and
 * owner admit who will offer, one that is admitted but stays silent, and one that serves someone
 * else. The request is open and wants one helper.
 */
async function lobbySetup() {
  const { weaveId: lobbyId } = await ensureLobby(db);
  const target = await createWeave(db, bus, { title: "Session", opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw = await resolveCredential(db, target.token);
  const prThread = await createThread(db, bus, paw, target.weave.id, "PR 14", "https://e.com/pr/14");
  // The requester's authority in the target Weave is its own keeper participant there.
  const there = await joinWeave(db, bus, target.secret, { name: "Claude-target", kind: "agent" });
  await setRole(db, bus, paw, target.weave.id, there.participant.id, "keeper");
  const targetKeeper = await resolveCredential(db, there.token);

  const join = async (name: string, profile: unknown) => {
    const j = await joinLobby(db, bus, { name, kind: "agent" });
    const actor = await resolveCredential(db, j.token);
    await setCapabilities(db, bus, actor, profile);
    return { id: j.participant.id, actor };
  };
  const claude = await join("Claude", { owner: "paw" });
  const pawbot = await join("Pawbot", { models: [MODEL], owner: "paw", serves: "owner" });
  const shared = await join("Shared", { models: [MODEL], owner: "shared", serves: "anyone" });
  const quiet = await join("Quiet", { models: [MODEL], owner: "paw", serves: "owner" });
  const bobbot = await join("Bobbot", { models: [MODEL], owner: "bob", serves: "owner" });

  const request = await openRequest(db, bus, claude.actor, targetKeeper, {
    title: "Review PR 14", requirements: { models: [MODEL] }, wanted: 1,
    targetWeaveId: target.weave.id, targetThreadId: prThread.id, url: "https://e.com/pr/14",
  });
  return { lobbyId, claude, pawbot, shared, quiet, bobbot, request };
}
type Lobby = Awaited<ReturnType<typeof lobbySetup>>;

const types = async (f: Lobby, who: { actor: Actor }) =>
  (await inbox(db, who.actor, f.lobbyId, {})).map((e) => e.type);

/** Both listeners offer; the requester accepts one, who completes, which closes the request. */
async function fillIt(f: Lobby) {
  await offer(db, bus, f.pawbot.actor, f.request.id, {});
  await offer(db, bus, f.shared.actor, f.request.id, {});
  await accept(db, bus, f.claude.actor, f.request.id, [f.pawbot.id], { deadlineMs: 3_600_000 });
  await complete(db, bus, f.pawbot.actor, f.request.id);
}

describe("inbox: addressed Lobby events", () => {
  it("delivers request.opened to an eligible listener and to nobody else", async () => {
    const f = await lobbySetup();
    expect(await types(f, f.pawbot)).toEqual(["request.opened"]);
    expect(await types(f, f.bobbot)).toEqual([]);
  });

  it("delivers every offer, and then the close, to the requester", async () => {
    const f = await lobbySetup();
    await offer(db, bus, f.pawbot.actor, f.request.id, {});
    await offer(db, bus, f.shared.actor, f.request.id, {});
    expect(await types(f, f.claude)).toEqual(["request.offered", "request.offered"]);
    // Swept rather than accepted: the close is addressed to the requester so that a close it did
    // not cause reaches it, and the inbox never hands anyone back their own events.
    await sweepRequests(db, bus, new Date(Date.parse(f.request.expiresAt) + 1000));
    expect(await types(f, f.claude)).toEqual(["request.offered", "request.offered", "request.closed"]);
  });

  it("tells an offerer who was not accepted that the request closed", async () => {
    const f = await lobbySetup();
    await fillIt(f);
    expect(await types(f, f.shared)).toEqual(["request.opened", "request.closed"]);
  });

  it("gives the accepted offerer its acceptance and its invitation, and not the close", async () => {
    const f = await lobbySetup();
    await fillIt(f);
    expect(await types(f, f.pawbot)).toEqual(["request.opened", "request.accepted", "weave.invited"]);
  });

  it("leaves an eligible listener that never offered with the opening alone", async () => {
    const f = await lobbySetup();
    await fillIt(f);
    expect(await types(f, f.quiet)).toEqual(["request.opened"]);
  });

  it("inbox returns request.completed and request.overdue addressed to me and not to others", async () => {
    const f = await lobbySetup();
    await offer(db, bus, f.pawbot.actor, f.request.id, {});
    await accept(db, bus, f.claude.actor, f.request.id, [f.pawbot.id], { deadlineMs: 3_600_000 });
    // It goes overdue while it is working, then the agent completes it after all.
    await sweepOverdue(db, bus, new Date(Date.now() + 2 * 3_600_000));
    await complete(db, bus, f.pawbot.actor, f.request.id);
    expect((await types(f, f.claude)).filter((t) => t === "request.overdue" || t === "request.completed"))
      .toEqual(["request.overdue", "request.completed"]);
    for (const other of [f.shared, f.pawbot]) {
      const mine = await types(f, other);
      expect(mine).not.toContain("request.overdue");
      expect(mine).not.toContain("request.completed");
    }
  });
});
