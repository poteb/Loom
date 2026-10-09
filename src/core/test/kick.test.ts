import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, requestOffers, weaveInvitations, weaves } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { archiveWeave, createWeave, joinWeave, type CreateWeaveResult } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { kickParticipant, setRole } from "../src/participants.js";
import { removeParticipant } from "../src/removals.js";
import { ensureLobby, joinLobby, lobbyGeneralThreadId } from "../src/lobby/lobby.js";
import { inviteToWeave, listInvitations, redeemInvitation, withdrawInvitation } from "../src/lobby/invitations.js";
import { setCapabilities } from "../src/lobby/profile.js";
import { accept, offer, openRequest } from "../src/lobby/requests.js";
import { inbox } from "../src/inbox.js";
import { createCore } from "../src/index.js";
import type { Db } from "../src/db/index.js";
import type { Actor, LoomEvent } from "../src/types.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const TITLE = "Loom development";
const KEEPERS_ONLY = { code: "forbidden", message: "Only a keeper of this Weave can do this" };
const NO_SUCH = { code: "validation", message: "No such participant in this Weave" };
const WITHDRAWN = { code: "forbidden", message: "This invitation was withdrawn" };

/** A keyed agent standing in the Lobby that joined the Weave with its key: what an invitation can readmit. */
async function keyedAgent(instanceKeeper: Actor, w: CreateWeaveResult, name: string) {
  const { key } = await addAgent(db, instanceKeeper, name);
  const keyActor = await resolveCredential(db, key);
  const lobbyJoin = await joinLobby(db, bus, { name, kind: "agent" }, keyActor);
  const join = await joinWeave(db, bus, w.secret, { name, kind: "agent" }, keyActor);
  return {
    id: join.participant.id, token: join.token, key, keyActor, actor: await resolveCredential(db, join.token),
    lobbyId: lobbyJoin.participant.id, lobbyToken: lobbyJoin.token, lobbyActor: await resolveCredential(db, lobbyJoin.token),
  };
}
type Agent = Awaited<ReturnType<typeof keyedAgent>>;

/**
 * Loom development, kept by Paw (a human), with a PR Thread; Mia, a human member; Helper, a keyed
 * agent standing in the Lobby and in the Weave; Req, a Lobby participant who opens requests; and the
 * instance keeper.
 */
async function setup() {
  const { weaveId: lobbyId } = await ensureLobby(db);
  await seedKeepers(db, [keeperToken("k")]);
  const instanceKeeper = await resolveCredential(db, keeperToken("k"));
  const keeperId = instanceKeeper.kind === "keeper" ? instanceKeeper.keeperId : "";
  const w = await createWeave(db, bus, { title: TITLE, opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw = await resolveCredential(db, w.token);
  const pr = await createThread(db, bus, paw, w.weave.id, "PR 14");
  const miaJoin = await joinWeave(db, bus, w.secret, { name: "Mia", kind: "human" });
  const mia = { id: miaJoin.participant.id, token: miaJoin.token, actor: await resolveCredential(db, miaJoin.token) };
  const helper = await keyedAgent(instanceKeeper, w, "Helper");
  const requester = await resolveCredential(db, (await joinLobby(db, bus, { name: "Req", kind: "agent" })).token);
  return { lobbyId, instanceKeeper, keeperId, w, weaveId: w.weave.id, paw, pawId: w.participant.id, pr, mia, helper, requester };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const row = async (id: string) => (await db.select().from(participants).where(eq(participants.id, id)))[0]!;
const invitation = async (id: string) => (await db.select().from(weaveInvitations).where(eq(weaveInvitations.id, id)))[0]!;
const pin = (id: string, at: Date) => db.update(weaveInvitations).set({ createdAt: at }).where(eq(weaveInvitations.id, id));
const weaveLog = (f: Fixture): Promise<LoomEvent[]> => readEvents(db, f.weaveId, {});
const lobbyLog = (f: Fixture): Promise<LoomEvent[]> => readEvents(db, f.lobbyId, {});
const kicks = async (f: Fixture) => (await weaveLog(f)).filter((e) => e.type === "participant.kicked");
const withdrawals = async (f: Fixture) => (await lobbyLog(f)).filter((e) => e.type === "weave.invitation_withdrawn");
/** Paw invites the agent's Lobby participant straight into the PR Thread: a direct invitation. */
const directInvite = (f: Fixture, agent: Agent = f.helper) => inviteToWeave(db, bus, f.paw, agent.lobbyId, f.weaveId, f.pr.id);
/** A request Req opened into the Weave on `authority`'s standing, with the agent's offer on it. */
async function offered(f: Fixture, agent: Agent = f.helper, authority: Actor = f.paw, title = "Review PR 14") {
  await setCapabilities(db, bus, agent.lobbyActor, { owner: "paw", serves: "anyone" });
  const request = await openRequest(db, bus, f.requester, authority, {
    title, requirements: {}, wanted: 1, targetWeaveId: f.weaveId, targetThreadId: f.pr.id, url: null,
  });
  await offer(db, bus, agent.lobbyActor, request.id, {});
  return request;
}
/** The same, accepted: one invitation of the request's to the agent. */
async function requestInvite(f: Fixture, agent: Agent = f.helper, title = "Review PR 14") {
  const request = await offered(f, agent, f.paw, title);
  const { invitationIds } = await accept(db, bus, f.requester, request.id, [agent.lobbyId], { deadlineMs: 3_600_000 });
  return { request, invitationId: invitationIds[0]! };
}
/** A second Weave with a keeper of its own, Kay: a keeper, but not of Loom development. */
async function elsewhere() {
  const w = await createWeave(db, bus, { title: "Elsewhere", opener: "hi", creator: { name: "Kay", kind: "human" } });
  const kay = await resolveCredential(db, w.token);
  return { w, kay, kayId: w.participant.id, thread: await createThread(db, bus, kay, w.weave.id, "Side") };
}

describe("kickParticipant (spec 2026-10-09 §4)", () => {
  it("a keeper kicks a member: kicked_at set, role member, one participant.kicked on General with the exact payload, and the answer names it", async () => {
    const f = await setup();
    const r = await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    const after = await row(f.mia.id);
    expect([after.kickedAt instanceof Date, after.role]).toEqual([true, "member"]);
    const all = await kicks(f);
    expect(all).toHaveLength(1);
    const event = all[0]!;
    expect(r).toEqual({ participantId: f.mia.id, name: "Mia", seq: event.seq, kickedAt: after.kickedAt!.toISOString(), created: true, withdrawn: [] });
    expect([event.threadId, event.actor]).toEqual([f.w.generalThread.id, f.pawId]);
    expect(event.payload).toEqual({ participantId: f.mia.id, name: "Mia", kickedBy: f.pawId, kickedByName: "Paw" });
  });

  it("the authority matrix: a keeper and the instance keeper kick, a keeper kicks another keeper, an agent key kicks through the facade; everyone else is refused and nothing is written", async () => {
    const f = await setup();
    const other = await elsewhere();
    const secret = await resolveCredential(db, f.w.secret);
    const refused: [Actor, { code: string; message: string }][] = [
      [f.mia.actor, KEEPERS_ONLY], [other.kay, KEEPERS_ONLY], [secret, KEEPERS_ONLY],
      [f.helper.keyActor, { code: "forbidden", message: "Join the Weave first" }],   // a raw agent key, never resolved into the Weave
    ];
    for (const [actor, answer] of refused) {
      await expect(kickParticipant(db, bus, actor, f.weaveId, f.helper.id)).rejects.toMatchObject(answer);
    }
    expect([(await row(f.helper.id)).kickedAt, await kicks(f)]).toEqual([null, []]);

    await kickParticipant(db, bus, f.instanceKeeper, f.weaveId, f.mia.id);
    expect((await kicks(f))[0]).toMatchObject({ actor: `keeper:${f.keeperId}`, payload: { kickedBy: `keeper:${f.keeperId}`, kickedByName: "Keeper" } });

    // Through the facade an agent key stands for the participant it owns in the Weave: here a keeper,
    // who kicks Paw, another keeper. Paw's role is member from then on.
    await setRole(db, bus, f.paw, f.weaveId, f.helper.id, "keeper");
    const core = createCore(db);
    expect(await core.kickParticipant(f.helper.keyActor, f.weaveId, f.pawId)).toMatchObject({ participantId: f.pawId, name: "Paw", created: true });
    expect((await row(f.pawId)).role).toBe("member");
    expect((await kicks(f)).at(-1)!.payload).toEqual({ participantId: f.pawId, name: "Paw", kickedBy: f.helper.id, kickedByName: "Helper" });
    // A key with no participant in the Weave is told to join first, by resolveInWeave.
    const { key } = await addAgent(db, f.instanceKeeper, "Stranger");
    await expect(core.kickParticipant(await resolveCredential(db, key), f.weaveId, f.helper.id))
      .rejects.toMatchObject({ code: "forbidden", message: "Join the Weave first" });
  });

  it("nobody kicks itself: a keeper, and an agent key mapped to a keeper, are told so", async () => {
    const f = await setup();
    const self = { code: "validation", message: "You cannot kick yourself" };
    await expect(kickParticipant(db, bus, f.paw, f.weaveId, f.pawId)).rejects.toMatchObject(self);
    await setRole(db, bus, f.paw, f.weaveId, f.helper.id, "keeper");
    await expect(createCore(db).kickParticipant(f.helper.keyActor, f.weaveId, f.helper.id)).rejects.toMatchObject(self);
    expect(await kicks(f)).toEqual([]);
  });

  it("a keeper demoted after its credential was resolved is refused inside the lock, and the target is unchanged", async () => {
    const f = await setup();
    await setRole(db, bus, f.paw, f.weaveId, f.mia.id, "keeper");
    const miaKeeper = await resolveCredential(db, f.mia.token);
    await expect(kickParticipant(db, bus, miaKeeper, f.weaveId, f.helper.id, {
      beforeLock: async () => { await setRole(db, bus, f.paw, f.weaveId, f.mia.id, "member"); },
    })).rejects.toMatchObject(KEEPERS_ONLY);
    expect([(await row(f.helper.id)).kickedAt, await kicks(f)]).toEqual([null, []]);
  });

  it("the Lobby is refused, and nothing is written", async () => {
    const f = await setup();
    const before = (await lobbyLog(f)).length;
    // The instance keeper passes the authority check for any Weave, so this reaches the Lobby rule.
    await expect(kickParticipant(db, bus, f.instanceKeeper, f.lobbyId, f.helper.lobbyId))
      .rejects.toMatchObject({ code: "validation", message: "Nobody is kicked from the Lobby" });
    expect([(await row(f.helper.lobbyId)).kickedAt, (await lobbyLog(f)).length]).toEqual([null, before]);
  });

  it("an unknown, malformed or other Weave's participant answers No such participant; a malformed weaveId is weave_not_found", async () => {
    const f = await setup();
    const other = await elsewhere();
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope", other.kayId]) {
      await expect(kickParticipant(db, bus, f.paw, f.weaveId, id)).rejects.toMatchObject(NO_SUCH);
    }
    await expect(kickParticipant(db, bus, f.paw, "nope", f.mia.id)).rejects.toMatchObject({ code: "weave_not_found" });
    expect(await kicks(f)).toEqual([]);
  });

  it("an archived Weave: the kick still works and is announced", async () => {
    const f = await setup();
    await archiveWeave(db, bus, f.paw, f.weaveId);
    expect((await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id)).created).toBe(true);
    expect((await kicks(f)).map((e) => e.payload.participantId)).toEqual([f.mia.id]);
  });

  it("an invitation pending at the kick is withdrawn by it, whatever its timestamp, and cannot readmit", async () => {
    const f = await setup();
    const other = await elsewhere();
    const rex = await keyedAgent(f.instanceKeeper, f.w, "Rex");
    // Untouched by the kick: one already redeemed (an adoption, before it), one into another Weave,
    // and one to another agent.
    const redeemed = await directInvite(f);
    await redeemInvitation(db, bus, f.helper.keyActor, redeemed.invitationId, { kind: "agent" });
    const intoOther = await inviteToWeave(db, bus, other.kay, f.helper.lobbyId, other.w.weave.id, other.thread.id);
    const toRex = await directInvite(f, rex);
    // The two that can readmit Helper, committed before the kick, then dated an hour after it: a
    // database clock that stepped backwards (KNOWN-ISSUES, the wall-clock created_at row).
    const direct = await directInvite(f);
    const viaRequest = await requestInvite(f);
    const later = Date.now() + 3_600_000;
    await pin(direct.invitationId, new Date(later));
    await pin(viaRequest.invitationId, new Date(later + 1000));

    const r = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const kickedAt = (await row(f.helper.id)).kickedAt!;
    expect(r.withdrawn).toEqual([direct.invitationId, viaRequest.invitationId]);
    for (const id of r.withdrawn) expect((await invitation(id)).revokedAt?.getTime()).toBe(kickedAt.getTime());
    for (const id of r.withdrawn) for (const actor of [f.helper.keyActor, f.helper.lobbyActor]) {
      await expect(redeemInvitation(db, bus, actor, id, { kind: "agent" })).rejects.toMatchObject(WITHDRAWN);
    }
    expect((await row(f.helper.id)).kickedAt).toEqual(kickedAt);
    for (const id of r.withdrawn) expect((await invitation(id)).redeemedAt).toBeNull();
    for (const id of [redeemed.invitationId, intoOther.invitationId, toRex.invitationId]) expect((await invitation(id)).revokedAt).toBeNull();
  });

  it("the kick announces each withdrawal to its invitee, where its weave.invited landed, in withdrawInvitation's own shape", async () => {
    const f = await setup();
    const direct = await directInvite(f);
    const viaRequest = await requestInvite(f);
    await pin(direct.invitationId, new Date("2026-10-01T10:00:00.000Z"));
    await pin(viaRequest.invitationId, new Date("2026-10-01T10:00:01.000Z"));
    const r = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const events = await withdrawals(f);
    expect(events.map((e) => e.payload.invitationId)).toEqual([direct.invitationId, viaRequest.invitationId]);
    expect(events.map((e) => e.threadId)).toEqual([await lobbyGeneralThreadId(db, f.lobbyId), viaRequest.request.threadId]);
    for (const [i, e] of events.entries()) {
      expect(e.actor).toBe(f.pawId);
      expect(e.payload).toEqual({ invitationId: r.withdrawn[i], participantId: f.helper.lobbyId, targetWeaveTitle: TITLE, withdrawnBy: f.pawId, withdrawnByName: "Paw" });
    }
    const told = (await inbox(db, f.helper.lobbyActor, f.lobbyId, {})).filter((e) => e.type === "weave.invitation_withdrawn");
    expect(told.map((e) => e.payload.invitationId)).toEqual(r.withdrawn);
    expect(await listInvitations(db, f.paw, f.weaveId)).toEqual([]);
    const again = await withdrawInvitation(db, bus, f.paw, f.weaveId, direct.invitationId);
    expect([again.created, again.seq]).toEqual([false, events[0]!.seq]);

    // The instance keeper's kick names it Keeper.
    const rex = await keyedAgent(f.instanceKeeper, f.w, "Rex");
    const toRex = await directInvite(f, rex);
    await kickParticipant(db, bus, f.instanceKeeper, f.weaveId, rex.id);
    expect((await withdrawals(f)).at(-1)).toMatchObject({ actor: `keeper:${f.keeperId}`,
      payload: { invitationId: toRex.invitationId, participantId: rex.lobbyId, withdrawnBy: `keeper:${f.keeperId}`, withdrawnByName: "Keeper" } });
  });

  it("a participant with no agent withdraws nothing: a human, and an agent that joined by secret without a key", async () => {
    const f = await setup();
    const hu = await joinLobby(db, bus, { name: "Hu", kind: "human" });
    const forHu = await inviteToWeave(db, bus, f.paw, hu.participant.id, f.weaveId, f.pr.id);
    expect((await invitation(forHu.invitationId)).inviteeAgentId).toBeNull();
    const carl = await joinWeave(db, bus, f.w.secret, { name: "Carl", kind: "agent" });
    const before = (await lobbyLog(f)).length;
    for (const id of [f.mia.id, carl.participant.id]) {
      expect((await kickParticipant(db, bus, f.paw, f.weaveId, id)).withdrawn).toEqual([]);
    }
    expect([(await lobbyLog(f)).length, (await invitation(forHu.invitationId)).revokedAt]).toEqual([before, null]);
  });

  it("a kick racing redeemInvitation: both settle, and either the redemption came first or the kick withdrew the invitation", async () => {
    const f = await setup();
    const { invitationId } = await directInvite(f);
    const [k, r] = await Promise.allSettled([
      kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id),
      redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" }),
    ]);
    if (k.status !== "fulfilled") throw k.reason;
    const inv = await invitation(invitationId);
    if (r.status === "fulfilled") {
      const invited = (await weaveLog(f)).filter((e) => e.type === "thread.invited" && e.payload.participantId === f.helper.id).at(-1)!;
      expect([k.value.withdrawn, inv.redeemedAt instanceof Date, inv.revokedAt, invited.seq < k.value.seq]).toEqual([[], true, null, true]);
    } else {
      expect(r.reason).toMatchObject(WITHDRAWN);
      expect([k.value.withdrawn, inv.redeemedAt, inv.revokedAt instanceof Date]).toEqual([[invitationId], null, true]);
    }
    expect((await row(f.helper.id)).kickedAt).toBeInstanceOf(Date);
  });

  it("a human rejoins only under a new name", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    await expect(joinWeave(db, bus, f.w.secret, { name: "Mia", kind: "human" })).rejects.toMatchObject({ code: "name_taken" });
    const again = await joinWeave(db, bus, f.w.secret, { name: "Mia-2", kind: "human" });
    expect(again.participant.id).not.toBe(f.mia.id);
  });

  it("a kicked keeper loses its recorded authority: accept refuses as after a demotion", async () => {
    const f = await setup();
    await setRole(db, bus, f.paw, f.weaveId, f.mia.id, "keeper");
    const miaKeeper = await resolveCredential(db, f.mia.token);
    const request = await offered(f, f.helper, miaKeeper);
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    await expect(accept(db, bus, f.requester, request.id, [f.helper.lobbyId], { deadlineMs: 3_600_000 }))
      .rejects.toMatchObject({ code: "forbidden", message: "The requester is no longer a keeper of the target Weave" });
  });

  it("an accepted agent kicked from the work Weave: its acceptance stands, its request invitation is withdrawn, and the removal then frees the slot with no second withdrawal", async () => {
    const f = await setup();
    const { request, invitationId } = await requestInvite(f);
    expect((await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id)).withdrawn).toEqual([invitationId]);
    const acceptance = async () => (await db.select().from(requestOffers)
      .where(and(eq(requestOffers.requestId, request.id), eq(requestOffers.participantId, f.helper.lobbyId))))[0]!;
    expect([(await acceptance()).accepted, (await acceptance()).removedAt]).toEqual([true, null]);
    expect((await removeParticipant(db, bus, f.requester, request.threadId, f.helper.lobbyId)).acceptanceRemoved).toBe(true);
    expect((await acceptance()).removedAt).toBeInstanceOf(Date);
    expect((await withdrawals(f)).filter((e) => e.payload.invitationId === invitationId)).toHaveLength(1);
  });

  it("no kick event, and no withdrawal a kick writes, carries a secret, a token or the agent key", async () => {
    const f = await setup();
    await directInvite(f);
    await requestInvite(f);
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    await kickParticipant(db, bus, f.instanceKeeper, f.weaveId, f.mia.id);
    const secrets = [
      f.helper.key, keeperToken("k"),
      ...(await db.select({ s: weaves.secret }).from(weaves)).map((w) => w.s),
      ...(await db.select({ t: participants.token }).from(participants)).map((p) => p.t),
    ];
    const weave = await weaveLog(f);
    const lobby = await lobbyLog(f);
    expect([weave.some((e) => e.type === "participant.kicked"), lobby.some((e) => e.type === "weave.invitation_withdrawn")]).toEqual([true, true]);
    for (const e of [...weave, ...lobby]) for (const s of secrets) expect(JSON.stringify(e.payload)).not.toContain(s);
  });
});
