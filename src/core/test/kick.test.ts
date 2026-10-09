import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, requestOffers, weaveInvitations, weaves } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential, resolveInWeave } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { archiveWeave, createWeave, getWeave, joinWeave, type CreateWeaveResult } from "../src/weaves.js";
import { postMessage } from "../src/messages.js";
import { inviteParticipant } from "../src/invites.js";
import { exportWeave } from "../src/export.js";
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

describe("the refusals and the way back (spec 2026-10-09 §7)", () => {
  const REMOVED = { code: "forbidden", message: "You were removed from this Weave" };
  const REJOIN = { code: "forbidden", message: "You were removed from this Weave: a keeper must invite you back" };

  it("a repeat is idempotent: the first call's seq and kickedAt; an invitation issued between the two survives the repeat and readmits; after a second kick the repeat answers its seq", async () => {
    const f = await setup();
    const first = await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    expect(await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id)).toEqual({ ...first, created: false });
    expect(await kicks(f)).toHaveLength(1);

    const kicked = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const { invitationId } = await directInvite(f);       // a keeper means to readmit
    expect((await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id)).withdrawn).toEqual([]);
    expect((await invitation(invitationId)).revokedAt).toBeNull();
    const back = await redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" });
    expect([back.participant.id, back.participant.kickedAt]).toEqual([f.helper.id, null]);
    const second = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    expect(second.seq).toBeGreaterThan(kicked.seq);
    expect((await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id)).seq).toBe(second.seq);
  });

  it("the kicked token is refused on every path with You were removed from this Weave, and checks nothing in", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    await db.update(participants).set({ lastSeenAt: null }).where(eq(participants.id, f.mia.id));
    const core = createCore(db);
    // Every adapter turns the bearer string into an Actor with resolveCredential first (requireActor,
    // CoreToolBackend.actor, the WebSocket ticket and upgrade, a request's target credential), so each
    // call below resolves the token as they do.
    const as = () => core.resolveCredential(f.mia.token);
    const calls: [string, () => Promise<unknown>][] = [
      ["getWeave", async () => core.getWeave(await as(), f.weaveId)],
      ["readEvents", async () => core.readEvents(await as(), f.weaveId, {})],
      ["inbox", async () => core.inbox(await as(), f.weaveId, {})],
      ["postMessage", async () => core.postMessage(await as(), f.w.generalThread.id, "still here?")],
      ["createThread", async () => core.createThread(await as(), f.weaveId, "Mine")],
      ["markRead", async () => core.markRead(await as(), f.w.generalThread.id, 1)],
      ["readPositions", async () => core.readPositions(await as(), f.weaveId)],
      ["exportWeave", async () => core.exportWeave(await as(), f.weaveId, "md")],
      ["openRequest, as the target credential", async () => core.openRequest(f.requester, await as(),
        { title: "Review", requirements: {}, targetWeaveId: f.weaveId, targetThreadId: f.pr.id })],
    ];
    for (const [label, call] of calls) await expect(call(), label).rejects.toMatchObject(REMOVED);
    expect((await row(f.mia.id)).lastSeenAt).toBeNull();
  });

  it("the agent key is refused in that Weave only: the Lobby and another Weave it is in still answer", async () => {
    const f = await setup();
    const other = await elsewhere();
    await joinWeave(db, bus, other.w.secret, { name: "Helper", kind: "agent" }, f.helper.keyActor);
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    await expect(resolveInWeave(db, f.helper.keyActor, f.weaveId)).rejects.toMatchObject(REMOVED);
    const core = createCore(db);
    await expect(core.getWeave(f.helper.keyActor, f.weaveId)).rejects.toMatchObject(REMOVED);
    expect((await core.getWeave(f.helper.keyActor, f.lobbyId)).weave.id).toBe(f.lobbyId);
    expect((await core.getWeave(f.helper.keyActor, other.w.weave.id)).weave.id).toBe(other.w.weave.id);
  });

  it("rejoining with the secret is refused for that agent, on the lookup and on the race path, and no second identity is made", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    await expect(joinWeave(db, bus, f.w.secret, { kind: "agent" }, f.helper.keyActor)).rejects.toMatchObject(REJOIN);
    // The race: a first join by the same key commits, and is kicked, after this one's lookup missed it.
    const { key } = await addAgent(db, f.instanceKeeper, "Racer");
    const racer = await resolveCredential(db, key);
    await expect(joinWeave(db, bus, f.w.secret, { name: "Racer", kind: "agent" }, racer, {
      beforeLock: async () => {
        const first = await joinWeave(db, bus, f.w.secret, { name: "Racer-2", kind: "agent" }, racer);
        await kickParticipant(db, bus, f.paw, f.weaveId, first.participant.id);
      },
    })).rejects.toMatchObject(REJOIN);
    const agentId = racer.kind === "agent" ? racer.agent.id : "";
    expect(await db.select().from(participants).where(and(eq(participants.weaveId, f.weaveId), eq(participants.agentId, agentId)))).toHaveLength(1);
  });

  it("a keeper's invitation readmits the same identity: kicked_at cleared, a member, a new token, announced with participant.joined then thread.invited", async () => {
    const f = await setup();
    await setRole(db, bus, f.paw, f.weaveId, f.helper.id, "keeper");
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    // Kicked and not yet readmitted: the old token is known and refused.
    await expect(resolveCredential(db, f.helper.token)).rejects.toMatchObject(REMOVED);
    const { invitationId } = await directInvite(f);
    const r = await redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" });
    expect([r.participant.id, r.participant.kickedAt, r.participant.role, r.alreadyJoined]).toEqual([f.helper.id, null, "member", false]);
    expect(r.token).not.toBe(f.helper.token);
    // Readmitted: the row now carries the new token, so no row matches the old one and it is unknown.
    await expect(resolveCredential(db, f.helper.token)).rejects.toMatchObject({ code: "invalid_token" });
    expect(await resolveCredential(db, r.token)).toMatchObject({ kind: "participant", participant: { id: f.helper.id } });
    const [joined, invited] = (await readEvents(db, f.weaveId, { threadId: f.pr.id })).slice(-2);
    expect([joined!.type, joined!.payload, invited!.type, invited!.payload.participantId])
      .toEqual(["participant.joined", { participantId: f.helper.id, name: "Helper", kind: "agent", role: "member" }, "thread.invited", f.helper.id]);
    // The Lobby-token redemption reaches the same row.
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const again = await directInvite(f);
    const viaLobby = await redeemInvitation(db, bus, f.helper.lobbyActor, again.invitationId, { kind: "agent" });
    expect([viaLobby.participant.id, viaLobby.participant.kickedAt]).toEqual([f.helper.id, null]);
  });

  it("an invitation issued after the kick readmits, even dated before the kick", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const kickedAt = (await row(f.helper.id)).kickedAt!;
    const { invitationId } = await directInvite(f);
    await pin(invitationId, new Date(kickedAt.getTime() - 3_600_000));
    const r = await redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" });
    expect([r.participant.id, r.participant.kickedAt, r.alreadyJoined]).toEqual([f.helper.id, null, false]);
  });

  it("a kick racing inviteToWeave: both complete, and exactly one order holds", async () => {
    const f = await setup();
    const [k, inv] = await Promise.all([kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id), directInvite(f)]);
    const log = await lobbyLog(f);
    const invited = log.find((e) => e.type === "weave.invited" && e.payload.invitationId === inv.invitationId)!;
    const withdrawal = log.find((e) => e.type === "weave.invitation_withdrawn" && e.payload.invitationId === inv.invitationId);
    if (withdrawal) {
      // The invitation came first: the kick withdrew it.
      expect([withdrawal.seq > invited.seq, k.withdrawn]).toEqual([true, [inv.invitationId]]);
      await expect(redeemInvitation(db, bus, f.helper.keyActor, inv.invitationId, { kind: "agent" })).rejects.toMatchObject(WITHDRAWN);
    } else {
      // The kick came first: the invitation was issued after it, and readmits.
      expect(k.withdrawn).toEqual([]);
      expect((await redeemInvitation(db, bus, f.helper.keyActor, inv.invitationId, { kind: "agent" })).participant.kickedAt).toBeNull();
    }
  });

  it("a kick racing inviteToWeave, each order forced once: committed before the kick's locks, withdrawn; after the kick, it readmits", async () => {
    const f = await setup();
    let before = "";
    const k = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id, {
      beforeLock: async () => { before = (await directInvite(f)).invitationId; },
    });
    expect(k.withdrawn).toEqual([before]);
    await expect(redeemInvitation(db, bus, f.helper.keyActor, before, { kind: "agent" })).rejects.toMatchObject(WITHDRAWN);
    const after = await directInvite(f);
    expect((await redeemInvitation(db, bus, f.helper.keyActor, after.invitationId, { kind: "agent" })).participant)
      .toMatchObject({ id: f.helper.id, kickedAt: null });
  });

  it("names still resolve: getWeave keeps the kicked participant with kickedAt, and the export names it, prints the kick and marks it", async () => {
    const f = await setup();
    await postMessage(db, bus, f.mia.actor, f.w.generalThread.id, "hello from Mia");
    const r = await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    const info = await getWeave(db, f.paw, f.weaveId);
    expect(info.participants.find((p) => p.id === f.mia.id)!.kickedAt).toBe(r.kickedAt);
    const md = await exportWeave(db, f.paw, f.weaveId, "md");
    expect(md).toContain("**Mia** · ");
    expect(md).toContain("_system: Mia was kicked by Paw_");
    expect(md).toContain("Mia (human, member, kicked)");
    const json = JSON.parse(await exportWeave(db, f.paw, f.weaveId, "json"));
    expect(json.participants.find((p: { id: string }) => p.id === f.mia.id).kickedAt).toBe(r.kickedAt);
  });

  it("mentions skip a kicked participant", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    const m = await postMessage(db, bus, f.paw, f.w.generalThread.id, "@Mia and @Helper, a look?");
    expect(m.payload.mentions).toEqual([f.helper.id]);
  });

  it("invite_participant and set_role refuse a kicked participant", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    const answer = { code: "validation", message: "That participant was kicked from this Weave" };
    await expect(inviteParticipant(db, bus, f.paw, f.pr.id, f.mia.id)).rejects.toMatchObject(answer);
    await expect(setRole(db, bus, f.paw, f.weaveId, f.mia.id, "keeper")).rejects.toMatchObject(answer);
  });
});
