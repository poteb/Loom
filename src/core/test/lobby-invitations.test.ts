import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, weaveInvitations } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { archiveWeave, createWeave, joinWeave } from "../src/weaves.js";
import { closeThread, createThread } from "../src/threads.js";
import { ensureLobby, joinLobby, lobbyGeneralThreadId } from "../src/lobby/lobby.js";
import { inviteToWeave, redeemInvitation } from "../src/lobby/invitations.js";
import { openRequest } from "../src/lobby/requests.js";
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
    expect(invited[0]!.payload).toEqual({ invitationId, participantId: f.helper.id, targetWeaveTitle: TARGET_TITLE });
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
