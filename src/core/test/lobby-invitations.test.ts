import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, weaveInvitations, weaves } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { archiveWeave, createWeave, joinWeave } from "../src/weaves.js";
import { closeThread, createThread } from "../src/threads.js";
import { ensureLobby, joinLobby, lobbyGeneralThreadId } from "../src/lobby/lobby.js";
import { inviteToWeave, listInvitations, redeemInvitation, withdrawInvitation } from "../src/lobby/invitations.js";
import { inbox } from "../src/inbox.js";
import { setRole } from "../src/participants.js";
import { setCapabilities } from "../src/lobby/profile.js";
import { accept, complete, offer, openRequest, sweepOverdue } from "../src/lobby/requests.js";
import { removeParticipant } from "../src/removals.js";
import { createCore } from "../src/index.js";
import type { Db } from "../src/db/index.js";
import type { Actor, LoomEvent } from "../src/types.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const TARGET_TITLE = "Loom session 2026-09-16";

/**
 * A Lobby with two listeners — one of them behind an agent key, so redemption can be driven from
 * either credential — and a target Weave whose keeper is Paw, with a Thread to be invited into.
 */
async function setup() {
  const { weaveId: lobbyId } = await ensureLobby(db);
  await seedKeepers(db, [keeperToken("k")]);
  const instanceKeeper = await resolveCredential(db, keeperToken("k"));

  const target = await createWeave(db, bus, { title: TARGET_TITLE, opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw: Actor = { kind: "participant", participant: target.participant };
  const prThread = await createThread(db, bus, paw, target.weave.id, "PR 14", "https://example.com/pr/14");

  const { key } = await addAgent(db, instanceKeeper, "Helper");
  const helperKey = await resolveCredential(db, key);
  const helperJoin = await joinLobby(db, bus, { name: "Helper", kind: "agent" }, helperKey);
  const helper = { id: helperJoin.participant.id, key, keyActor: helperKey, actor: await resolveCredential(db, helperJoin.token) };

  const otherJoin = await joinLobby(db, bus, { name: "Other", kind: "agent" });
  const other = { id: otherJoin.participant.id, actor: await resolveCredential(db, otherJoin.token) };

  const memberJoin = await joinWeave(db, bus, target.secret, { name: "Member", kind: "human" });
  const targetMember = await resolveCredential(db, memberJoin.token);

  return { lobbyId, instanceKeeper, target, paw, pawId: target.participant.id, prThread, helper, other, targetMember };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const invitationRow = async (id: string) =>
  (await db.select().from(weaveInvitations).where(eq(weaveInvitations.id, id)))[0]!;
const lobbyEvents = (f: Fixture): Promise<LoomEvent[]> => readEvents(db, f.lobbyId, {});
const targetEvents = (f: Fixture, threadId?: string): Promise<LoomEvent[]> =>
  readEvents(db, f.target.weave.id, { threadId });
const targetParticipants = (f: Fixture) =>
  db.select().from(participants).where(eq(participants.weaveId, f.target.weave.id));

describe("inviteToWeave", () => {
  it("records an invitation for a Lobby participant and announces it in the Lobby General", async () => {
    const f = await setup();
    const { invitationId, seq } = await inviteToWeave(db, bus, f.paw, f.helper.id, f.target.weave.id, f.prThread.id);
    expect(await invitationRow(invitationId)).toMatchObject({
      targetWeaveId: f.target.weave.id, targetThreadId: f.prThread.id,
      inviteeParticipantId: f.helper.id, requestId: null, redeemedAt: null, redeemedParticipantId: null,
      createdBy: f.pawId,
    });
    const general = await lobbyGeneralThreadId(db, f.lobbyId);
    const invited = (await lobbyEvents(f)).filter((e) => e.type === "weave.invited");
    expect(invited).toHaveLength(1);
    expect(invited[0]!.seq).toBe(seq);
    expect(invited[0]!.threadId).toBe(general);
    expect(invited[0]!.payload).toEqual({ invitationId, participantId: f.helper.id, targetWeaveTitle: TARGET_TITLE, requestId: null });
  });

  it("copies the invitee's agent id, so the key that owns it can redeem", async () => {
    const f = await setup();
    const { invitationId } = await inviteToWeave(db, bus, f.paw, f.helper.id, f.target.weave.id, f.prThread.id);
    const [lobbyParticipant] = await db.select().from(participants).where(eq(participants.id, f.helper.id));
    expect((await invitationRow(invitationId)).inviteeAgentId).toBe(lobbyParticipant!.agentId);
  });

  it("never lets the target Weave's secret into the Lobby log", async () => {
    const f = await setup();
    await inviteToWeave(db, bus, f.paw, f.helper.id, f.target.weave.id, f.prThread.id);
    for (const e of await lobbyEvents(f)) {
      expect(JSON.stringify(e.payload)).not.toContain(f.target.secret);
    }
  });

  it("refuses anyone who is not a keeper of the target Weave", async () => {
    const f = await setup();
    await expect(inviteToWeave(db, bus, f.targetMember, f.helper.id, f.target.weave.id, f.prThread.id))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(inviteToWeave(db, bus, f.helper.actor, f.other.id, f.target.weave.id, f.prThread.id))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(await db.select().from(weaveInvitations)).toHaveLength(0);
  });

  it("refuses a Thread of another Weave, or one that is closed", async () => {
    const f = await setup();
    const general = await lobbyGeneralThreadId(db, f.lobbyId);
    await expect(inviteToWeave(db, bus, f.paw, f.helper.id, f.target.weave.id, general))
      .rejects.toMatchObject({ code: "thread_not_found" });
    await closeThread(db, bus, f.paw, f.prThread.id);
    await expect(inviteToWeave(db, bus, f.paw, f.helper.id, f.target.weave.id, f.prThread.id))
      .rejects.toMatchObject({ code: "thread_closed" });
  });

  it("announces an invitation issued for a request in that request's own Thread", async () => {
    const f = await setup();
    const request = await openRequest(db, bus, f.helper.actor, f.paw, {
      title: "Review PR 14", requirements: {}, wanted: 1,
      targetWeaveId: f.target.weave.id, targetThreadId: f.prThread.id, url: null,
    });
    const { invitationId } = await inviteToWeave(db, bus, f.paw, f.other.id, f.target.weave.id, f.prThread.id, request.id);
    const invited = (await lobbyEvents(f)).filter((e) => e.type === "weave.invited");
    expect(invited).toHaveLength(1);
    expect(invited[0]!.threadId).toBe(request.threadId);
    expect((await invitationRow(invitationId)).requestId).toBe(request.id);
  });

  it("refuses an invitee who is not a participant of the Lobby", async () => {
    const f = await setup();
    await expect(inviteToWeave(db, bus, f.paw, f.target.participant.id, f.target.weave.id, f.prThread.id))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("weave.invited carries requestId for an acceptance and null for a direct invitation", async () => {
    const f = await setup();
    const direct = await inviteToWeave(db, bus, f.paw, f.other.id, f.target.weave.id, f.prThread.id);
    await setCapabilities(db, bus, f.other.actor, { owner: "paw", serves: "anyone" });
    const request = await openRequest(db, bus, f.helper.actor, f.paw, {
      title: "Review PR 14", requirements: {}, wanted: 1,
      targetWeaveId: f.target.weave.id, targetThreadId: f.prThread.id, url: null,
    });
    await offer(db, bus, f.other.actor, request.id, {});
    const { invitationIds } = await accept(db, bus, f.helper.actor, request.id, [f.other.id], { deadlineMs: 3_600_000 });
    const invited = (await lobbyEvents(f)).filter((e) => e.type === "weave.invited");
    expect(invited.find((e) => e.payload.invitationId === direct.invitationId)!.payload.requestId).toBeNull();
    expect(invited.find((e) => e.payload.invitationId === invitationIds[0])!.payload.requestId).toBe(request.id);
  });

  it("no new event payload carries a Weave secret or a token", async () => {
    const f = await setup();
    await setCapabilities(db, bus, f.other.actor, { owner: "paw", serves: "anyone" });
    const ask = (title: string) => openRequest(db, bus, f.helper.actor, f.paw, {
      title, requirements: {}, wanted: 1, targetWeaveId: f.target.weave.id, targetThreadId: f.prThread.id, url: null,
    });
    const first = await ask("Review PR 14");
    await offer(db, bus, f.other.actor, first.id, {});
    const { invitationIds } = await accept(db, bus, f.helper.actor, first.id, [f.other.id], { deadlineMs: 3_600_000 });
    const landed = await redeemInvitation(db, bus, f.other.actor, invitationIds[0]!, { kind: "agent" });
    await sweepOverdue(db, bus, new Date(Date.now() + 2 * 3_600_000));
    await removeParticipant(db, bus, f.helper.actor, first.threadId, f.other.id);
    const second = await ask("Review PR 15");
    await offer(db, bus, f.other.actor, second.id, {});
    await accept(db, bus, f.helper.actor, second.id, [f.other.id], { deadlineMs: 3_600_000 });
    await complete(db, bus, f.other.actor, second.id, { note: "done" });
    const secrets = [
      f.helper.key, landed.token,
      ...(await db.select({ s: weaves.secret }).from(weaves)).map((w) => w.s),
      ...(await db.select({ t: participants.token }).from(participants)).map((p) => p.t),
    ];
    const log = [...await lobbyEvents(f), ...await targetEvents(f)];
    for (const type of ["request.accepted", "weave.invited", "request.overdue", "thread.removed", "request.completed", "request.closed"]) {
      expect(log.map((e) => e.type)).toContain(type);
    }
    for (const e of log) for (const s of secrets) expect(JSON.stringify(e.payload)).not.toContain(s);
  });
});

describe("redeemInvitation", () => {
  const invite = async (f: Fixture, participantId = f.helper.id) =>
    (await inviteToWeave(db, bus, f.paw, participantId, f.target.weave.id, f.prThread.id)).invitationId;

  it("lands the invitee in the target Weave under its Lobby name, invited to the Thread", async () => {
    const f = await setup();
    const invitationId = await invite(f);
    const joined = await redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" });
    expect(joined.weaveId).toBe(f.target.weave.id);
    expect(joined.participant.name).toBe("Helper");
    expect(joined.alreadyJoined).toBe(false);
    expect(joined.token).toBeTruthy();
    const invited = (await targetEvents(f, f.prThread.id)).filter((e) => e.type === "thread.invited");
    expect(invited).toHaveLength(1);
    expect(invited[0]!.payload).toMatchObject({ threadId: f.prThread.id, participantId: joined.participant.id });
    const row = await invitationRow(invitationId);
    expect(row.redeemedAt).toBeInstanceOf(Date);
    expect(row.redeemedParticipantId).toBe(joined.participant.id);
  });

  it("accepts the agent key that owns the invitee", async () => {
    const f = await setup();
    const invitationId = await invite(f);
    const joined = await redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" });
    expect(joined.alreadyJoined).toBe(false);
    const [p] = await db.select().from(participants).where(eq(participants.id, joined.participant.id));
    expect(p!.agentId).toBe(f.helper.keyActor.kind === "agent" ? f.helper.keyActor.agent.id : null);
  });

  it("links the identity it creates to the agent behind the invitee, whichever credential redeems", async () => {
    const f = await setup();
    const invitationId = await invite(f);
    const joined = await redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" });
    const [lobbyParticipant] = await db.select().from(participants).where(eq(participants.id, f.helper.id));
    const [there] = await db.select().from(participants).where(eq(participants.id, joined.participant.id));
    expect(lobbyParticipant!.agentId).not.toBeNull();
    expect(there!.agentId).toBe(lobbyParticipant!.agentId);
  });

  it("adopts the agent's existing target identity even when the Lobby token redeems", async () => {
    const f = await setup();
    const first = await joinWeave(db, bus, f.target.secret, { name: "HelperThere", kind: "agent" }, f.helper.keyActor);
    const invitationId = await invite(f);
    const joined = await redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" });
    expect(joined.alreadyJoined).toBe(true);
    expect(joined.participant.id).toBe(first.participant.id);
    expect((await targetEvents(f)).filter((e) => e.type === "participant.joined" && e.payload.participantId === first.participant.id))
      .toHaveLength(1);
  });

  it("refuses anyone the invitation is not addressed to", async () => {
    const f = await setup();
    const invitationId = await invite(f);
    await expect(redeemInvitation(db, bus, f.other.actor, invitationId, { kind: "agent" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(redeemInvitation(db, bus, f.paw, invitationId, { kind: "human" }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect((await invitationRow(invitationId)).redeemedAt).toBeNull();
  });

  it("refuses an unknown invitation", async () => {
    const f = await setup();
    await expect(redeemInvitation(db, bus, f.helper.actor, "nope", { kind: "agent" }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(redeemInvitation(db, bus, f.helper.actor, "00000000-0000-4000-8000-000000000000", { kind: "agent" }))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("is single-use", async () => {
    const f = await setup();
    const invitationId = await invite(f);
    await redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" });
    await expect(redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("is single-use under simultaneous redemption: one identity, one join, one Thread invite", async () => {
    const f = await setup();
    const invitationId = await invite(f);
    const settled = await Promise.allSettled([
      redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }),
      redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "forbidden" });
    expect((await targetParticipants(f)).filter((p) => p.name === "Helper")).toHaveLength(1);
    const log = await targetEvents(f, f.prThread.id);
    expect(log.filter((e) => e.type === "participant.joined")).toHaveLength(1);
    expect(log.filter((e) => e.type === "thread.invited")).toHaveLength(1);
  });

  it("redeems an already-joined agent into its own identity, without joining it twice", async () => {
    const f = await setup();
    const first = await joinWeave(db, bus, f.target.secret, { name: "HelperThere", kind: "agent" }, f.helper.keyActor);
    const invitationId = await invite(f);
    const joined = await redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" });
    expect(joined.alreadyJoined).toBe(true);
    expect(joined.participant.id).toBe(first.participant.id);
    expect(joined.token).toBe(first.token);
    expect((await targetEvents(f)).filter((e) => e.type === "participant.joined" && e.payload.participantId === first.participant.id))
      .toHaveLength(1);
    const invited = (await targetEvents(f, f.prThread.id)).filter((e) => e.type === "thread.invited");
    expect(invited).toHaveLength(1);
    expect(invited[0]!.payload).toMatchObject({ participantId: first.participant.id });
    // The skills' join signal (spec 2026-09-28 §7.2 step 4, §7.3 step 6): a returning agent brings
    // only the thread.invited into the work Thread, never a participant.joined.
    expect((await targetEvents(f, f.prThread.id)).filter((e) => e.type === "participant.joined")).toEqual([]);
    expect((await invitationRow(invitationId)).redeemedAt).toBeInstanceOf(Date);
  });

  it("refuses an archived target Weave", async () => {
    const f = await setup();
    const invitationId = await invite(f);
    await archiveWeave(db, bus, f.paw, f.target.weave.id);
    await expect(redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }))
      .rejects.toMatchObject({ code: "weave_archived" });
  });

  it("refuses a target Thread closed since the invitation was issued", async () => {
    const f = await setup();
    const invitationId = await invite(f);
    await closeThread(db, bus, f.paw, f.prThread.id);
    await expect(redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }))
      .rejects.toMatchObject({ code: "thread_closed" });
    expect((await invitationRow(invitationId)).redeemedAt).toBeNull();
  });

  it("reports name_taken when the Lobby name is already used there, and takes the name the caller then picks", async () => {
    const f = await setup();
    await joinWeave(db, bus, f.target.secret, { name: "Helper", kind: "human" });
    const invitationId = await invite(f);
    await expect(redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }))
      .rejects.toMatchObject({ code: "name_taken" });
    expect((await invitationRow(invitationId)).redeemedAt).toBeNull();
    const joined = await redeemInvitation(db, bus, f.helper.actor, invitationId, { name: "Helper2", kind: "agent" });
    expect(joined.participant.name).toBe("Helper2");
  });

  it("is what the facade's joinWeave does with an inviteId, with no secret at all", async () => {
    const f = await setup();
    const core = createCore(db);
    const invitationId = await invite(f);
    const joined = await core.joinWeave("", { kind: "agent" }, f.helper.keyActor, { inviteId: invitationId });
    expect(joined.weaveId).toBe(f.target.weave.id);
    expect(joined.participant.name).toBe("Helper");
    expect((await invitationRow(invitationId)).redeemedAt).toBeInstanceOf(Date);
  });
});

const REQUEST_REFUSAL = "This invitation belongs to a request: remove the agent from the request's Thread instead (remove_participant)";
const REDEEMED_REFUSAL = "This invitation was already redeemed: take the participant off the Thread with remove_participant instead";
const KEEPERS_ONLY = "Only a keeper of this Weave can do this";

/** Paw, keeper of the target, invites a Lobby participant straight into the PR Thread: a direct invitation. */
const direct = (f: Fixture, participantId = f.helper.id) =>
  inviteToWeave(db, bus, f.paw, participantId, f.target.weave.id, f.prThread.id);
/** A request Helper opened into the target, with Other's offer accepted: one invitation that belongs to it. */
async function requestInvitation(f: Fixture, title = "Review PR 14") {
  await setCapabilities(db, bus, f.other.actor, { owner: "paw", serves: "anyone" });
  const request = await openRequest(db, bus, f.helper.actor, f.paw, {
    title, requirements: {}, wanted: 1, targetWeaveId: f.target.weave.id, targetThreadId: f.prThread.id, url: null,
  });
  await offer(db, bus, f.other.actor, request.id, {});
  const { invitationIds } = await accept(db, bus, f.helper.actor, request.id, [f.other.id], { deadlineMs: 3_600_000 });
  return { request, invitationId: invitationIds[0]! };
}
/** A second Weave with a keeper of its own, Kay: a keeper, but not of the target. */
async function elsewhere() {
  const w = await createWeave(db, bus, { title: "Elsewhere", opener: "hi", creator: { name: "Kay", kind: "human" } });
  const kay: Actor = { kind: "participant", participant: w.participant };
  return { weaveId: w.weave.id, kay, thread: await createThread(db, bus, kay, w.weave.id, "Side") };
}
const withdrawals = async (f: Fixture): Promise<LoomEvent[]> =>
  (await lobbyEvents(f)).filter((e) => e.type === "weave.invitation_withdrawn");

describe("withdrawInvitation", () => {
  it("a keeper of the target withdraws a direct invitation: revoked_at set, one event on the Lobby's General, nothing in the target", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    const targetBefore = (await targetEvents(f)).length;
    const r = await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId);
    const row = await invitationRow(invitationId);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({ redeemedAt: null, redeemedParticipantId: null, requestId: null, createdBy: f.pawId });
    const all = await withdrawals(f);
    expect(all).toHaveLength(1);
    const event = all[0]!;
    expect(r).toEqual({ invitationId, seq: event.seq, withdrawnAt: row.revokedAt!.toISOString(), created: true });
    expect(event.threadId).toBe(await lobbyGeneralThreadId(db, f.lobbyId));
    expect(event.actor).toBe(f.pawId);
    expect(event.payload).toEqual({ invitationId, participantId: f.helper.id, targetWeaveTitle: TARGET_TITLE, withdrawnBy: f.pawId, withdrawnByName: "Paw" });
    expect((await targetEvents(f)).length).toBe(targetBefore);
  });

  it("the authority matrix: the target's keeper and the instance keeper withdraw; everyone else is refused and nothing is written", async () => {
    const f = await setup();
    const other = await elsewhere();
    const secret = await resolveCredential(db, f.target.secret);
    const { invitationId } = await direct(f);
    const refused: [Actor, string][] = [
      [f.targetMember, KEEPERS_ONLY], [other.kay, KEEPERS_ONLY],
      [f.helper.actor, KEEPERS_ONLY],               // the invitee itself, a Lobby participant
      [f.other.actor, KEEPERS_ONLY], [secret, KEEPERS_ONLY],
      [f.helper.keyActor, "Join the Weave first"],   // a raw agent key, never resolved into the target
    ];
    for (const [actor, message] of refused) {
      await expect(withdrawInvitation(db, bus, actor, f.target.weave.id, invitationId)).rejects.toMatchObject({ code: "forbidden", message });
    }
    expect((await invitationRow(invitationId)).revokedAt).toBeNull();
    expect(await withdrawals(f)).toEqual([]);

    expect((await withdrawInvitation(db, bus, f.instanceKeeper, f.target.weave.id, invitationId)).created).toBe(true);
    const keeperId = f.instanceKeeper.kind === "keeper" ? f.instanceKeeper.keeperId : "";
    expect((await withdrawals(f))[0]).toMatchObject({ actor: `keeper:${keeperId}`, payload: { withdrawnBy: `keeper:${keeperId}`, withdrawnByName: "Keeper" } });

    // Through the facade an agent key stands for the participant it owns in the target: a keeper there.
    const core = createCore(db);
    const own = await core.createWeave({ title: "Helper's Weave", opener: "", creator: { name: "HelperHost", kind: "agent" } }, f.helper.keyActor);
    const work = await core.createThread(f.helper.keyActor, own.weave.id, "Work");
    const viaKey = await core.inviteToWeave(f.helper.keyActor, f.other.id, own.weave.id, work.id);
    expect((await core.withdrawInvitation(f.helper.keyActor, own.weave.id, viaKey.invitationId)).created).toBe(true);
    // A key with no participant in the target is told to join first, by resolveInWeave.
    await expect(core.withdrawInvitation(f.helper.keyActor, f.target.weave.id, invitationId))
      .rejects.toMatchObject({ code: "forbidden", message: "Join the Weave first" });
  });

  it("a keeper demoted after its credential was resolved is refused inside the lock, and the row is unchanged", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId, {
      beforeLock: async () => { await setRole(db, bus, f.instanceKeeper, f.target.weave.id, f.pawId, "member"); },
    })).rejects.toMatchObject({ code: "forbidden", message: KEEPERS_ONLY });
    expect((await invitationRow(invitationId)).revokedAt).toBeNull();
    expect(await withdrawals(f)).toEqual([]);
  });

  it("a request's invitation is refused, whatever its state, and nothing is written", async () => {
    const f = await setup();
    const pending = await requestInvitation(f);
    // A second request whose accepted agent was then removed from its Thread: the removal withdrew it.
    const removed = await requestInvitation(f, "Review PR 15");
    await removeParticipant(db, bus, f.helper.actor, removed.request.threadId, f.other.id);
    expect((await invitationRow(removed.invitationId)).revokedAt).toBeInstanceOf(Date);
    const before = await lobbyEvents(f);
    for (const id of [pending.invitationId, removed.invitationId]) {
      await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, id)).rejects.toMatchObject({ code: "validation", message: REQUEST_REFUSAL });
    }
    expect((await invitationRow(pending.invitationId)).revokedAt).toBeNull();
    expect(await lobbyEvents(f)).toEqual(before);
  });

  it("a redeemed invitation is refused, and the row is unchanged", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" });
    const before = await invitationRow(invitationId);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId)).rejects.toMatchObject({ code: "validation", message: REDEEMED_REFUSAL });
    expect(await invitationRow(invitationId)).toEqual(before);
    expect(await withdrawals(f)).toEqual([]);
  });

  it("an unknown, malformed or other Weave's invitation, and the Lobby as target, answer not_found; a malformed target is weave_not_found", async () => {
    const f = await setup();
    const other = await elsewhere();
    const theirs = await inviteToWeave(db, bus, other.kay, f.helper.id, other.weaveId, other.thread.id);
    const notFound = { code: "not_found", message: "No such invitation in this Weave" };
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject(notFound);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, "nope")).rejects.toMatchObject(notFound);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, theirs.invitationId)).rejects.toMatchObject(notFound);
    // The instance keeper passes the authority check for any Weave, so this reaches the Lobby rule.
    await expect(withdrawInvitation(db, bus, f.instanceKeeper, f.lobbyId, theirs.invitationId)).rejects.toMatchObject(notFound);
    await expect(withdrawInvitation(db, bus, f.paw, "nope", theirs.invitationId)).rejects.toMatchObject({ code: "weave_not_found" });
    expect((await invitationRow(theirs.invitationId)).revokedAt).toBeNull();
  });

  it("a repeat is idempotent: created false, the first call's seq and withdrawnAt, and still one event", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    const first = await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId);
    expect(await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId)).toEqual({ ...first, created: false });
    expect((await withdrawals(f)).map((e) => e.payload.invitationId)).toEqual([invitationId]);
  });

  it("redeeming after a withdrawal is refused, whichever credential tries, and no participant is created in the target", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId);
    const before = (await targetParticipants(f)).length;
    for (const actor of [f.helper.actor, f.helper.keyActor]) {
      await expect(redeemInvitation(db, bus, actor, invitationId, { kind: "agent" }))
        .rejects.toMatchObject({ code: "forbidden", message: "This invitation was withdrawn" });
    }
    expect((await targetParticipants(f)).length).toBe(before);
  });

  it("withdraw racing redeem: a redemption that commits first wins, and the withdrawal writes nothing", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId, {
      beforeLock: async () => { await redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }); },
    })).rejects.toMatchObject({ code: "validation", message: REDEEMED_REFUSAL });
    const row = await invitationRow(invitationId);
    expect([row.redeemedAt instanceof Date, row.revokedAt]).toEqual([true, null]);
    expect(await withdrawals(f)).toEqual([]);
  });

  it("withdraw racing redeem: in twenty rounds exactly one wins each time, and the other answers its own refusal", async () => {
    const f = await setup();
    for (let round = 0; round < 20; round++) {
      const { invitationId } = await direct(f);
      const [w, r] = await Promise.allSettled([
        withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId),
        redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }),
      ]);
      expect([w.status, r.status].sort()).toEqual(["fulfilled", "rejected"]);
      if (w.status === "rejected") expect(w.reason).toMatchObject({ code: "validation", message: REDEEMED_REFUSAL });
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "forbidden", message: "This invitation was withdrawn" });
      const row = await invitationRow(invitationId);
      expect([row.redeemedAt !== null, row.revokedAt !== null].filter((set) => set)).toHaveLength(1);
    }
  });

  it("an archived target Weave: the withdrawal still works and is announced", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await archiveWeave(db, bus, f.paw, f.target.weave.id);
    expect((await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId)).created).toBe(true);
    expect((await withdrawals(f)).map((e) => e.payload.invitationId)).toEqual([invitationId]);
  });

  it("no withdrawal event carries a secret or a token", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId);
    const secrets = [
      f.helper.key, keeperToken("k"),
      ...(await db.select({ s: weaves.secret }).from(weaves)).map((w) => w.s),
      ...(await db.select({ t: participants.token }).from(participants)).map((p) => p.t),
    ];
    const log = await lobbyEvents(f);
    expect(log.map((e) => e.type)).toContain("weave.invitation_withdrawn");
    for (const e of log) for (const s of secrets) expect(JSON.stringify(e.payload)).not.toContain(s);
  });

  it("the inbox: the invitee's Lobby inbox carries the withdrawal; another Lobby participant's and the withdrawing keeper's do not", async () => {
    const f = await setup();
    const first = await direct(f);                        // Paw invites Helper
    await withdrawInvitation(db, bus, f.paw, f.target.weave.id, first.invitationId);
    // Helper keeps a Weave of its own and stands in the Lobby: as the withdrawing keeper it is not told.
    const core = createCore(db);
    const own = await core.createWeave({ title: "Helper's Weave", opener: "", creator: { name: "HelperHost", kind: "agent" } }, f.helper.keyActor);
    const work = await core.createThread(f.helper.keyActor, own.weave.id, "Work");
    const second = await core.inviteToWeave(f.helper.keyActor, f.other.id, own.weave.id, work.id);
    await core.withdrawInvitation(f.helper.keyActor, own.weave.id, second.invitationId);
    const withdrawn = async (actor: Actor) => (await inbox(db, actor, f.lobbyId, {}))
      .filter((e) => e.type === "weave.invitation_withdrawn").map((e) => e.payload.invitationId);
    expect(await withdrawn(f.helper.actor)).toEqual([first.invitationId]);
    expect(await withdrawn(f.other.actor)).toEqual([second.invitationId]);
  });
});

describe("listInvitations", () => {
  it("lists what is pending, oldest first, with every field; redeemed and withdrawn ones are left out", async () => {
    const f = await setup();
    const directOne = await direct(f);
    const viaRequest = await requestInvitation(f);
    const redeemed = await direct(f, f.other.id);
    await redeemInvitation(db, bus, f.other.actor, redeemed.invitationId, { kind: "agent" });
    const withdrawn = await direct(f);
    await withdrawInvitation(db, bus, f.paw, f.target.weave.id, withdrawn.invitationId);
    // Each row's created_at is its transaction's now(), and the database clock can step backwards
    // (KNOWN-ISSUES, the wall-clock created_at row). Pinned, and against insertion order.
    const pin = (id: string, at: string) => db.update(weaveInvitations).set({ createdAt: new Date(at) }).where(eq(weaveInvitations.id, id));
    await pin(directOne.invitationId, "2026-09-27T10:00:00.000Z");
    await pin(viaRequest.invitationId, "2026-09-27T09:00:00.000Z");
    expect(await listInvitations(db, f.paw, f.target.weave.id)).toEqual([
      { invitationId: viaRequest.invitationId, participantId: f.other.id, inviteeName: "Other", targetThreadId: f.prThread.id,
        targetThreadName: "PR 14", createdAt: "2026-09-27T09:00:00.000Z", createdBy: f.helper.id, createdByName: "Helper",
        requestId: viaRequest.request.id },
      { invitationId: directOne.invitationId, participantId: f.helper.id, inviteeName: "Helper", targetThreadId: f.prThread.id,
        targetThreadName: "PR 14", createdAt: "2026-09-27T10:00:00.000Z", createdBy: f.pawId, createdByName: "Paw", requestId: null },
    ]);
  });

  it("resolves createdByName: the inviting keeper's name in the target, the requester's Lobby name, Keeper, and null for a principal no row resolves", async () => {
    const f = await setup();
    const byPaw = await direct(f);
    const viaRequest = await requestInvitation(f);
    const byKeeper = await inviteToWeave(db, bus, f.instanceKeeper, f.other.id, f.target.weave.id, f.prThread.id);
    const orphan = await direct(f);
    await db.update(weaveInvitations).set({ createdBy: "00000000-0000-4000-8000-000000000000" }).where(eq(weaveInvitations.id, orphan.invitationId));
    const names = new Map((await listInvitations(db, f.paw, f.target.weave.id)).map((i) => [i.invitationId, i.createdByName]));
    expect([byPaw, viaRequest, byKeeper, orphan].map((i) => names.get(i.invitationId))).toEqual(["Paw", "Helper", "Keeper", null]);
  });

  it("authority: a keeper and the instance keeper read it; a member, another Weave's keeper and a Lobby participant are forbidden; an unknown Weave is weave_not_found", async () => {
    const f = await setup();
    await direct(f);
    const other = await elsewhere();
    expect(await listInvitations(db, f.paw, f.target.weave.id)).toHaveLength(1);
    expect(await listInvitations(db, f.instanceKeeper, f.target.weave.id)).toHaveLength(1);
    for (const actor of [f.targetMember, other.kay, f.helper.actor]) {
      await expect(listInvitations(db, actor, f.target.weave.id)).rejects.toMatchObject({ code: "forbidden", message: KEEPERS_ONLY });
    }
    await expect(listInvitations(db, f.instanceKeeper, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "weave_not_found" });
    await expect(listInvitations(db, f.paw, "nope")).rejects.toMatchObject({ code: "weave_not_found" });
  });

  it("an archived Weave still lists its pending rows", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await archiveWeave(db, bus, f.paw, f.target.weave.id);
    expect((await listInvitations(db, f.paw, f.target.weave.id)).map((i) => i.invitationId)).toEqual([invitationId]);
  });
});
