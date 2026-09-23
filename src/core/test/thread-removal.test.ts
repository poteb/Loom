import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { requestOffers, requests as requestsTable, weaveInvitations, weaves } from "../src/db/schema.js";
import { readEvents, type NewEvent } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { archiveWeave, createWeave, joinWeave } from "../src/weaves.js";
import { closeThread, createThread } from "../src/threads.js";
import { setRole } from "../src/participants.js";
import { inviteParticipant } from "../src/invites.js";
import { postMessage } from "../src/messages.js";
import { removeParticipant } from "../src/removals.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities } from "../src/lobby/profile.js";
import { redeemInvitation } from "../src/lobby/invitations.js";
import { accept, offer, openRequest, versionOf } from "../src/lobby/requests.js";
import type { Db } from "../src/db/index.js";
import type { LoomEvent } from "../src/types.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const threadLog = (weaveId: string, threadId: string): Promise<LoomEvent[]> => readEvents(db, weaveId, { threadId });

/** A Weave kept by Paw with two members: Bob created the Thread "PR 1" and invited Carl to it. */
async function room() {
  const r = await createWeave(db, bus, { title: "Room", opener: "", creator: { name: "Paw", kind: "human" } });
  const paw = await resolveCredential(db, r.token);
  const bobJoin = await joinWeave(db, bus, r.secret, { name: "Bob", kind: "human" });
  const bob = await resolveCredential(db, bobJoin.token);
  const carlJoin = await joinWeave(db, bus, r.secret, { name: "Carl", kind: "agent" });
  const carl = await resolveCredential(db, carlJoin.token);
  const thread = await createThread(db, bus, bob, r.weave.id, "PR 1");
  await inviteParticipant(db, bus, bob, thread.id, carlJoin.participant.id);
  return { r, paw, bob, carl, bobId: bobJoin.participant.id, carlId: carlJoin.participant.id, thread };
}

describe("remove_participant on any Thread", () => {
  it("the Thread creator may remove a participant, and a keeper may", async () => {
    const f = await room();
    const byCreator = await removeParticipant(db, bus, f.bob, f.thread.id, f.carlId);
    expect(byCreator).toMatchObject({ created: true, acceptanceRemoved: false, targetRemoved: false });
    const ev = (await threadLog(f.r.weave.id, f.thread.id)).at(-1)!;
    expect(ev).toMatchObject({ seq: byCreator.seq, type: "thread.removed", actor: f.bobId });
    expect(ev.payload).toEqual({ threadId: f.thread.id, participantId: f.carlId, removedBy: f.bobId });
    await inviteParticipant(db, bus, f.bob, f.thread.id, f.carlId);
    expect((await removeParticipant(db, bus, f.paw, f.thread.id, f.carlId)).created).toBe(true);
  });

  it("a member who did not create the Thread is forbidden", async () => {
    const f = await room();
    await expect(removeParticipant(db, bus, f.carl, f.thread.id, f.bobId)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("General, oneself and a non-participant are validation", async () => {
    const f = await room();
    await expect(removeParticipant(db, bus, f.paw, f.r.generalThread.id, f.carlId))
      .rejects.toMatchObject({ code: "validation", message: "Nobody is removed from the General Thread" });
    await expect(removeParticipant(db, bus, f.bob, f.thread.id, f.bobId))
      .rejects.toMatchObject({ code: "validation", message: "You cannot remove yourself" });
    const stranger = await createWeave(db, bus, { title: "Elsewhere", opener: "", creator: { name: "Dana", kind: "human" } });
    await expect(removeParticipant(db, bus, f.bob, f.thread.id, stranger.participant.id))
      .rejects.toMatchObject({ code: "validation", message: "No such participant in this Weave" });
  });

  it("an archived Weave and a closed Thread are refused", async () => {
    const f = await room();
    await closeThread(db, bus, f.paw, f.thread.id);
    await expect(removeParticipant(db, bus, f.paw, f.thread.id, f.carlId)).rejects.toMatchObject({ code: "thread_closed" });
    const g = await room();
    await archiveWeave(db, bus, g.paw, g.r.weave.id);
    await expect(removeParticipant(db, bus, g.paw, g.thread.id, g.carlId)).rejects.toMatchObject({ code: "weave_archived" });
  });

  it("a removed participant cannot post in that Thread, and can after it is invited again", async () => {
    const f = await room();
    await removeParticipant(db, bus, f.bob, f.thread.id, f.carlId);
    await expect(postMessage(db, bus, f.carl, f.thread.id, "still here"))
      .rejects.toMatchObject({ code: "forbidden", message: "You were removed from this Thread; you can post here again once you are invited back" });
    expect((await postMessage(db, bus, f.carl, f.r.generalThread.id, "elsewhere is fine")).type).toBe("message");
    await inviteParticipant(db, bus, f.bob, f.thread.id, f.carlId);
    expect((await postMessage(db, bus, f.carl, f.thread.id, "back")).type).toBe("message");
  });

  it("inviting after a removal appends a fresh thread.invited with created true", async () => {
    const f = await room();
    const first = (await threadLog(f.r.weave.id, f.thread.id)).find((e) => e.type === "thread.invited")!.seq;
    expect(await inviteParticipant(db, bus, f.bob, f.thread.id, f.carlId)).toEqual({ seq: first, created: false });
    await removeParticipant(db, bus, f.bob, f.thread.id, f.carlId);
    const again = await inviteParticipant(db, bus, f.bob, f.thread.id, f.carlId);
    expect(again.created).toBe(true);
    expect(again.seq).toBeGreaterThan(first);
    expect(await inviteParticipant(db, bus, f.bob, f.thread.id, f.carlId)).toEqual({ seq: again.seq, created: false });
  });

  it("a repeated removal with no invite since is idempotent", async () => {
    const f = await room();
    const first = await removeParticipant(db, bus, f.bob, f.thread.id, f.carlId);
    const n = (await threadLog(f.r.weave.id, f.thread.id)).length;
    expect(await removeParticipant(db, bus, f.paw, f.thread.id, f.carlId))
      .toEqual({ seq: first.seq, created: false, acceptanceRemoved: false, targetRemoved: false });
    expect((await threadLog(f.r.weave.id, f.thread.id)).length).toBe(n);
  });
});

const MODEL = { model: "gpt-5.6-sol", effort: "high" };
let tag = 0;

/**
 * A request in the Lobby, opened by Claude for a work Thread of Paw's Weave; the requester's
 * recorded authority there is its own keeper participant, Claude-target. Pawbot and Shared offered
 * and Pawbot was accepted. `onGeneral` targets the Weave's General Thread instead. Names carry a
 * tag, so one test may build several.
 */
async function requested(opts: { onGeneral?: boolean } = {}) {
  const t = ++tag;
  const { weaveId: lobbyId } = await ensureLobby(db);
  await seedKeepers(db, [keeperToken("k")]);
  const target = await createWeave(db, bus, { title: `Session ${t}`, opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw = await resolveCredential(db, target.token);
  const work = opts.onGeneral ? target.generalThread : await createThread(db, bus, paw, target.weave.id, "PR 14");
  const there = await joinWeave(db, bus, target.secret, { name: "Claude-target", kind: "agent" });
  await setRole(db, bus, paw, target.weave.id, there.participant.id, "keeper");
  const targetKeeper = await resolveCredential(db, there.token);
  const join = async (name: string, profile: unknown) => {
    const j = await joinLobby(db, bus, { name: `${name}-${t}`, kind: "agent" });
    const actor = await resolveCredential(db, j.token);
    await setCapabilities(db, bus, actor, profile);
    return { id: j.participant.id, actor };
  };
  const claude = await join("Claude", { owner: "paw" });
  const pawbot = await join("Pawbot", { models: [MODEL], owner: "paw", serves: "owner" });
  const shared = await join("Shared", { models: [MODEL], owner: "shared", serves: "anyone" });
  const request = await openRequest(db, bus, claude.actor, targetKeeper, {
    title: "Review PR 14", requirements: { models: [MODEL] }, wanted: 2,
    targetWeaveId: target.weave.id, targetThreadId: work.id, url: null,
  });
  await offer(db, bus, pawbot.actor, request.id, {});
  await offer(db, bus, shared.actor, request.id, {});
  const { invitationIds } = await accept(db, bus, claude.actor, request.id, [pawbot.id], { deadlineMs: 3_600_000 });
  return { lobbyId, target, paw, work, there, claude, pawbot, shared, request, invitationId: invitationIds[0]! };
}
type Requested = Awaited<ReturnType<typeof requested>>;

/** Pawbot redeems its invitation into the work Thread, and is given back its identity there. */
const redeem = (f: Requested) => redeemInvitation(db, bus, f.pawbot.actor, f.invitationId, { kind: "agent" });
const offerOf = async (f: Requested, participantId: string) =>
  (await db.select().from(requestOffers).where(and(eq(requestOffers.requestId, f.request.id), eq(requestOffers.participantId, participantId))))[0]!;
const removeFromRequest = (f: Requested, participantId: string) =>
  removeParticipant(db, bus, f.claude.actor, f.request.threadId, participantId);

/** Holds a Weave row `FOR UPDATE` in a transaction of its own until `release()` is awaited. */
async function holdWeaveRow(weaveId: string) {
  let locked!: () => void; let letGo!: () => void;
  const isHeld = new Promise<void>((r) => { locked = r; });
  const releasable = new Promise<void>((r) => { letGo = r; });
  const side = db.transaction(async (tx) => {
    await tx.select().from(weaves).where(eq(weaves.id, weaveId)).for("update");
    locked();
    await releasable;
  });
  await isHeld;
  return { release: async () => { letGo(); await side; } };
}
const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T | "waiting"> =>
  Promise.race([p, new Promise<"waiting">((r) => setTimeout(() => r("waiting"), ms))]);

describe("remove_participant on a request Thread", () => {
  it("on a request Thread, removal marks the acceptance removed", async () => {
    const f = await requested();
    expect(await removeFromRequest(f, f.pawbot.id)).toMatchObject({ created: true, acceptanceRemoved: true, targetRemoved: false });
    expect((await offerOf(f, f.pawbot.id)).removedAt).not.toBeNull();
    expect((await threadLog(f.lobbyId, f.request.threadId)).at(-1)!.payload)
      .toEqual({ threadId: f.request.threadId, participantId: f.pawbot.id, removedBy: f.claude.id, requestId: f.request.id });
  });

  it("on a request Thread, removal withdraws the acceptance's unredeemed invitations, and redeeming one is forbidden", async () => {
    const f = await requested();
    await removeFromRequest(f, f.pawbot.id);
    const [inv] = await db.select().from(weaveInvitations).where(eq(weaveInvitations.id, f.invitationId));
    expect(inv!.revokedAt).not.toBeNull();
    await expect(redeem(f)).rejects.toMatchObject({ code: "forbidden", message: "This invitation was withdrawn" });
  });

  it("on a request Thread, removal appends thread.removed to the work Thread for the redeemed participant, under the recorded target authority", async () => {
    const f = await requested();
    const landed = await redeem(f);
    expect(await removeFromRequest(f, f.pawbot.id)).toMatchObject({ acceptanceRemoved: true, targetRemoved: true });
    const ev = (await threadLog(f.target.weave.id, f.work.id)).at(-1)!;
    expect(ev).toMatchObject({ type: "thread.removed", actor: f.there.participant.id });
    expect(ev.payload).toEqual({ threadId: f.work.id, participantId: landed.participant.id, removedBy: f.there.participant.id, requestId: f.request.id });
    await expect(postMessage(db, bus, await resolveCredential(db, landed.token), f.work.id, "still at it"))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("the target half is skipped, and the Lobby half commits, when the requester has been demoted in the target, the target is archived, or the work Thread is closed", async () => {
    const spoilers: Array<(f: Requested) => Promise<unknown>> = [
      (f) => setRole(db, bus, f.paw, f.target.weave.id, f.there.participant.id, "member"),
      (f) => archiveWeave(db, bus, f.paw, f.target.weave.id),
      (f) => closeThread(db, bus, f.paw, f.work.id),
    ];
    for (const spoil of spoilers) {
      const f = await requested();
      await redeem(f);
      await spoil(f);
      const targetBefore = (await readEvents(db, f.target.weave.id, {})).length;
      expect(await removeFromRequest(f, f.pawbot.id)).toMatchObject({ created: true, acceptanceRemoved: true, targetRemoved: false });
      expect((await readEvents(db, f.target.weave.id, {})).length).toBe(targetBefore);
      expect((await offerOf(f, f.pawbot.id)).removedAt).not.toBeNull();
    }
  });

  it("the target half is skipped when the work Thread is General", async () => {
    const f = await requested({ onGeneral: true });
    await redeem(f);
    expect(await removeFromRequest(f, f.pawbot.id)).toMatchObject({ acceptanceRemoved: true, targetRemoved: false });
    expect((await readEvents(db, f.target.weave.id, {})).filter((e) => e.type === "thread.removed")).toEqual([]);
  });

  it("removing an acceptance advances the request's lastEventSeq to the request Thread's thread.removed, and versionOf counts a thread.removed with a requestId and ignores one without", async () => {
    const f = await requested();
    const r = await removeFromRequest(f, f.pawbot.id);
    expect((await db.select().from(requestsTable).where(eq(requestsTable.id, f.request.id)))[0]!.lastEventSeq).toBe(r.seq);
    const withRequest: NewEvent[] = [{ threadId: "t", type: "thread.removed", actor: "a", payload: { requestId: "r" } }];
    const without: NewEvent[] = [
      { threadId: "t", type: "request.offered", actor: "a", payload: {} },
      { threadId: "t", type: "thread.removed", actor: "a", payload: {} },
    ];
    expect(versionOf({ lastSeq: 10 }, withRequest)).toBe(11);
    expect(versionOf({ lastSeq: 10 }, without)).toBe(11);
  });

  it("removal on a request Thread waits for a held target lock rather than deadlocking", async () => {
    const f = await requested();
    const held = await holdWeaveRow(f.target.weave.id);
    const removing = removeFromRequest(f, f.pawbot.id).then(() => "done" as const);
    try {
      expect(await settledWithin(removing, 200)).toBe("waiting");
    } finally {
      await held.release();                  // never leave the removal blocked on a failed assertion
    }
    expect(await removing).toBe("done");
  });

  it("a participant with no acceptance on a request Thread gets only the marker", async () => {
    const f = await requested();
    const targetBefore = (await readEvents(db, f.target.weave.id, {})).length;
    expect(await removeFromRequest(f, f.shared.id)).toMatchObject({ created: true, acceptanceRemoved: false, targetRemoved: false });
    expect((await offerOf(f, f.shared.id)).removedAt).toBeNull();
    expect((await readEvents(db, f.target.weave.id, {})).length).toBe(targetBefore);
    expect((await threadLog(f.lobbyId, f.request.threadId)).at(-1)!.payload)
      .toEqual({ threadId: f.request.threadId, participantId: f.shared.id, removedBy: f.claude.id, requestId: f.request.id });
  });
});
