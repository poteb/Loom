import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, requestOffers, requests as requestsTable, threads, weaveInvitations, weaves } from "../src/db/schema.js";
import { readEvents, withWeaveLocks } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { archiveWeave, createWeave, joinWeave } from "../src/weaves.js";
import { closeThread, createThread } from "../src/threads.js";
import { setRole } from "../src/participants.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities } from "../src/lobby/profile.js";
import {
  accept, cancelRequest, getRequest, listRequests, offer, openRequest, sweepRequests,
  type OpenRequestInput,
} from "../src/lobby/requests.js";
import { createCore } from "../src/index.js";
import type { Db } from "../src/db/index.js";
import type { Actor, LoomEvent } from "../src/types.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const MODEL = { model: "gpt-5.6-sol", effort: "high" };
const REQUIREMENTS = { models: [MODEL] };
const TARGET_TITLE = "Loom session 2026-09-16";

/**
 * The success scenario of the spec, as rows: a Lobby with four listeners (the requester Claude with
 * owner "paw", Bob's agent which serves only Bob, Paw's own agent and a shared one), and a target
 * Weave whose keepers are Paw and the requester's own participant there.
 */
async function setup() {
  const { weaveId: lobbyId } = await ensureLobby(db);
  await seedKeepers(db, [keeperToken("k")]);
  const instanceKeeper = await resolveCredential(db, keeperToken("k"));

  const target = await createWeave(db, bus, { title: TARGET_TITLE, opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw: Actor = { kind: "participant", participant: target.participant };
  const prThread = await createThread(db, bus, paw, target.weave.id, "PR 14", "https://example.com/pr/14");

  // The requester's authority in the target Weave is its own participant row there, a keeper.
  const targetJoin = await joinWeave(db, bus, target.secret, { name: "Claude-target", kind: "agent" });
  await setRole(db, bus, paw, target.weave.id, targetJoin.participant.id, "keeper");
  const targetKeeper = await resolveCredential(db, targetJoin.token);
  const memberJoin = await joinWeave(db, bus, target.secret, { name: "Member", kind: "human" });
  const targetMember = await resolveCredential(db, memberJoin.token);

  const join = async (name: string, profile: unknown) => {
    const j = await joinLobby(db, bus, { name, kind: "agent" });
    const actor = await resolveCredential(db, j.token);
    await setCapabilities(db, bus, actor, profile);
    return { id: j.participant.id, token: j.token, actor };
  };
  const claude = await join("Claude", { owner: "paw" });
  const bobbot = await join("Bobbot", { models: [MODEL], owner: "bob", serves: "owner" });
  const pawbot = await join("Pawbot", { models: [MODEL], owner: "paw", serves: "owner" });
  const shared = await join("Shared", { models: [MODEL], owner: "shared", serves: "anyone" });

  return { lobbyId, instanceKeeper, target, paw, prThread, targetKeeper, targetJoin, targetMember, claude, bobbot, pawbot, shared };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const inputFor = (f: Fixture, over: Partial<OpenRequestInput> = {}): OpenRequestInput => ({
  title: "Review PR 14", requirements: REQUIREMENTS, wanted: 1,
  targetWeaveId: f.target.weave.id, targetThreadId: f.prThread.id,
  url: "https://example.com/pr/14", ...over,
});

const rowOf = async (requestId: string) =>
  (await db.select().from(requestsTable).where(eq(requestsTable.id, requestId)))[0]!;
const offersOf = async (requestId: string) =>
  db.select().from(requestOffers).where(eq(requestOffers.requestId, requestId));
const invitationsOf = async (requestId: string) =>
  db.select().from(weaveInvitations).where(eq(weaveInvitations.requestId, requestId));
const threadEvents = (f: Fixture, threadId: string): Promise<LoomEvent[]> =>
  readEvents(db, f.lobbyId, { threadId });

describe("withWeaveLocks", () => {
  it("refuses two ids that name the same Weave", async () => {
    const f = await setup();
    await expect(withWeaveLocks(db, bus, [f.lobbyId, f.lobbyId], async () => ({ result: 1, events: {} })))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("appends each Weave's events under its own lock", async () => {
    const f = await setup();
    const general = (await db.select().from(threads).where(and(eq(threads.weaveId, f.lobbyId), eq(threads.isGeneral, true))))[0]!;
    const out = await withWeaveLocks(db, bus, [f.lobbyId, f.target.weave.id], async (_tx, byId) => ({
      result: byId[f.target.weave.id]!.title,
      events: {
        [f.lobbyId]: [{ threadId: general.id, type: "message" as const, actor: f.claude.id, payload: { text: "lobby", mentions: [] } }],
        [f.target.weave.id]: [{ threadId: f.prThread.id, type: "message" as const, actor: f.paw.participant.id, payload: { text: "target", mentions: [] } }],
      },
    }));
    expect(out).toBe(TARGET_TITLE);
    expect((await readEvents(db, f.lobbyId, { threadId: general.id })).at(-1)!.payload.text).toBe("lobby");
    expect((await readEvents(db, f.target.weave.id, { threadId: f.prThread.id })).at(-1)!.payload.text).toBe("target");
  });
});

describe("openRequest", () => {
  it("opens a request Thread and announces it to the eligible listeners", async () => {
    const f = await setup();
    const now = new Date("2026-09-16T12:00:00.000Z");
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { wanted: 2 }), now);

    const row = await rowOf(req.id);
    expect(row.requesterId).toBe(f.claude.id);
    expect(row.owner).toBe("paw");
    expect(row.status).toBe("open");
    expect(row.expiresAt.toISOString()).toBe("2026-09-16T13:00:00.000Z");
    expect(row.requesterTargetParticipantId).toBe(f.targetJoin.participant.id);
    expect(row.requesterTargetKeeperId).toBeNull();

    const [thread] = await db.select().from(threads).where(eq(threads.id, row.threadId));
    expect(thread!.name).toBe("Review PR 14");
    expect(thread!.requestId).toBe(req.id);

    const evs = await threadEvents(f, row.threadId);
    expect(evs.map((e) => e.type)).toEqual(["thread.created", "request.opened"]);
    expect(evs[0]!.payload).toEqual({ threadId: row.threadId, name: "Review PR 14", url: "https://example.com/pr/14", requestId: req.id });
    expect(evs[1]!.payload).toEqual({
      requestId: req.id, requesterId: f.claude.id, requirements: REQUIREMENTS, wanted: 2,
      expiresAt: "2026-09-16T13:00:00.000Z", owner: "paw", targetWeaveTitle: TARGET_TITLE,
      eligible: [f.pawbot.id, f.shared.id],
    });
    expect(row.lastEventSeq).toBe(evs[1]!.seq);
  });

  it("returns the eligibility snapshot it just recorded", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    const opened = (await threadEvents(f, req.threadId)).find((e) => e.type === "request.opened")!;
    expect(req.eligible).toEqual([f.pawbot.id, f.shared.id]);
    expect(req.eligible).toEqual(opened.payload.eligible);
  });

  it("refuses a target credential that is only a member of the target Weave", async () => {
    const f = await setup();
    await expect(openRequest(db, bus, f.claude.actor, f.targetMember, inputFor(f)))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("reports invalid_token when no credential for the target Weave is given", async () => {
    const f = await setup();
    await expect(openRequest(db, bus, f.claude.actor, f.claude.actor, inputFor(f)))
      .rejects.toMatchObject({ code: "invalid_token" });
  });

  it("lets one agent key stand for both credentials", async () => {
    const f = await setup();
    const core = createCore(db);
    const { key } = await addAgent(db, f.instanceKeeper, "ChatGPT");
    const agent = await resolveCredential(db, key);
    await joinLobby(db, bus, { kind: "agent" }, agent);
    const j = await joinWeave(db, bus, f.target.secret, { kind: "agent" }, agent);
    await setRole(db, bus, f.paw, f.target.weave.id, j.participant.id, "keeper");

    const req = await core.openRequest(agent, undefined, inputFor(f));
    expect((await rowOf(req.id)).requesterTargetParticipantId).toBe(j.participant.id);
  });

  it("records an instance keeper as the requester's target authority", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.instanceKeeper, inputFor(f));
    const row = await rowOf(req.id);
    expect(row.requesterTargetParticipantId).toBeNull();
    expect(row.requesterTargetKeeperId).toBe((f.instanceKeeper as { kind: "keeper"; keeperId: string }).keeperId);
  });

  it("keeps wanted within 1 and 20, defaulting to 1", async () => {
    const f = await setup();
    await expect(openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { wanted: 0 }))).rejects.toMatchObject({ code: "validation" });
    await expect(openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { wanted: 21 }))).rejects.toMatchObject({ code: "validation" });
    const { wanted, ...rest } = inputFor(f);
    expect((await openRequest(db, bus, f.claude.actor, f.targetKeeper, rest)).wanted).toBe(1);
  });

  it("keeps timeoutMs within a minute and a day, defaulting to an hour", async () => {
    const f = await setup();
    const now = new Date("2026-09-16T12:00:00.000Z");
    await expect(openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { timeoutMs: 59_999 }), now)).rejects.toMatchObject({ code: "validation" });
    await expect(openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { timeoutMs: 86_400_001 }), now)).rejects.toMatchObject({ code: "validation" });
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f), now);
    expect(req.expiresAt).toBe("2026-09-16T13:00:00.000Z");
  });

  it("refuses a sixth open request from the same requester", async () => {
    const f = await setup();
    for (let i = 0; i < 5; i++) await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { title: `Review ${i}` }));
    await expect(openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { title: "Review 6" })))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("refuses an archived target Weave", async () => {
    const f = await setup();
    await archiveWeave(db, bus, f.paw, f.target.weave.id);
    await expect(openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f)))
      .rejects.toMatchObject({ code: "weave_archived" });
  });

  it("refuses a Thread that is not the target Weave's", async () => {
    const f = await setup();
    const [general] = await db.select().from(threads).where(and(eq(threads.weaveId, f.lobbyId), eq(threads.isGeneral, true)));
    await expect(openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { targetThreadId: general!.id })))
      .rejects.toMatchObject({ code: "thread_not_found" });
  });

  it("refuses a closed target Thread", async () => {
    const f = await setup();
    const old = await createThread(db, bus, f.paw, f.target.weave.id, "PR 13");
    await closeThread(db, bus, f.paw, old.id);
    await expect(openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { targetThreadId: old.id })))
      .rejects.toMatchObject({ code: "thread_closed" });
  });

  it("refuses a request that targets the Lobby itself", async () => {
    const f = await setup();
    const [general] = await db.select().from(threads).where(and(eq(threads.weaveId, f.lobbyId), eq(threads.isGeneral, true)));
    await expect(openRequest(db, bus, f.claude.actor, f.instanceKeeper, inputFor(f, { targetWeaveId: f.lobbyId, targetThreadId: general!.id })))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("snapshots eligibility, so a later profile change does not join the request", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    await setCapabilities(db, bus, f.bobbot.actor, { models: [MODEL], owner: "bob", serves: "anyone" });
    await expect(offer(db, bus, f.bobbot.actor, req.id, {})).rejects.toMatchObject({ code: "forbidden" });
    expect((await getRequest(db, f.claude.actor, req.id)).eligible).toEqual([f.pawbot.id, f.shared.id]);
  });
});

describe("offer", () => {
  it("addresses the offer to the requester", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    const o = await offer(db, bus, f.pawbot.actor, req.id, { model: MODEL.model, effort: MODEL.effort, note: "can start now" });
    expect(o).toMatchObject({ requestId: req.id, participantId: f.pawbot.id, model: MODEL.model, effort: MODEL.effort, note: "can start now", accepted: false });
    const evs = await threadEvents(f, req.threadId);
    const offered = evs.at(-1)!;
    expect(offered.type).toBe("request.offered");
    expect(offered.payload).toEqual({ requestId: req.id, participantId: f.pawbot.id, model: MODEL.model, effort: MODEL.effort, note: "can start now", to: f.claude.id });
    expect((await rowOf(req.id)).lastEventSeq).toBe(offered.seq);
  });

  it("refuses an offer from a listener the request was not addressed to", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    await expect(offer(db, bus, f.bobbot.actor, req.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("is idempotent: a second offer returns the first and appends nothing", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    const first = await offer(db, bus, f.pawbot.actor, req.id, { note: "first" });
    const before = (await threadEvents(f, req.threadId)).length;
    const again = await offer(db, bus, f.pawbot.actor, req.id, { note: "second" });
    expect(again).toEqual(first);
    expect((await threadEvents(f, req.threadId)).length).toBe(before);
  });

  it("refuses a model the offerer's own profile does not name", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    await expect(offer(db, bus, f.pawbot.actor, req.id, { model: "claude-fable-5-1", effort: "high" }))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("refuses an offer on a request that is no longer open", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    await cancelRequest(db, bus, f.claude.actor, req.id);
    await expect(offer(db, bus, f.pawbot.actor, req.id, {})).rejects.toMatchObject({ code: "request_closed" });
  });
});

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

/** Whether a third transaction can take that Weave row right now: `false` means someone holds it. */
async function canLockWeaveRow(weaveId: string): Promise<boolean> {
  try {
    await db.transaction(async (tx) => { await tx.execute(sql`select 1 from weaves where id = ${weaveId} for update nowait`); });
    return true;
  } catch { return false; }
}

const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T | "waiting"> =>
  Promise.race([p, new Promise<"waiting">((r) => setTimeout(() => r("waiting"), ms))]);

/** A request wanting two helpers, with an offer from each of the two eligible listeners. */
async function twoOffers(f: Fixture) {
  const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { wanted: 2 }));
  await offer(db, bus, f.pawbot.actor, req.id, { note: "pawbot" });
  await offer(db, bus, f.shared.actor, req.id, { note: "shared" });
  return req;
}

describe("accept", () => {
  it("accepts one of two wanted and leaves the request open", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const { request, invitationIds } = await accept(db, bus, f.claude.actor, req.id, [f.pawbot.id]);

    expect(request.status).toBe("open");
    expect(invitationIds).toHaveLength(1);
    expect((await offersOf(req.id)).filter((o) => o.accepted).map((o) => o.participantId)).toEqual([f.pawbot.id]);
    const [inv] = await invitationsOf(req.id);
    expect(inv!).toMatchObject({
      targetWeaveId: f.target.weave.id, targetThreadId: f.prThread.id,
      inviteeParticipantId: f.pawbot.id, requestId: req.id, redeemedAt: null,
    });

    const evs = await threadEvents(f, req.threadId);
    expect(evs.slice(-2).map((e) => e.type)).toEqual(["request.accepted", "weave.invited"]);
    expect(evs.at(-2)!.payload).toEqual({ requestId: req.id, requesterId: f.claude.id, participantIds: [f.pawbot.id], targetWeaveTitle: TARGET_TITLE });
    expect(evs.at(-1)!.payload).toEqual({ invitationId: inv!.id, participantId: f.pawbot.id, targetWeaveTitle: TARGET_TITLE });
  });

  it("closes the request as filled in the same transaction as the last acceptance", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    await accept(db, bus, f.claude.actor, req.id, [f.pawbot.id]);
    const before = (await threadEvents(f, req.threadId)).length;
    const { request } = await accept(db, bus, f.claude.actor, req.id, [f.shared.id]);

    expect(request.status).toBe("filled");
    const row = await rowOf(req.id);
    expect(row.status).toBe("filled");
    expect(row.closedAt).not.toBeNull();
    const [thread] = await db.select().from(threads).where(eq(threads.id, req.threadId));
    expect(thread!.closedAt).not.toBeNull();

    const evs = await threadEvents(f, req.threadId);
    expect(evs.slice(before).map((e) => e.type)).toEqual(["request.accepted", "weave.invited", "request.closed", "thread.closed"]);
    // one uninterrupted run of seqs: the acceptance and the closure committed together
    expect(evs.slice(before).map((e) => e.seq)).toEqual([0, 1, 2, 3].map((i) => evs[before]!.seq + i));
    const closed = evs.at(-2)!;
    expect(closed.payload).toEqual({ requestId: req.id, requesterId: f.claude.id, to: [f.claude.id], reason: "filled", accepted: [f.pawbot.id, f.shared.id] });
    expect(evs.at(-1)!.payload).toEqual({ threadId: req.threadId, requestId: req.id });
    expect(row.lastEventSeq).toBe(closed.seq);
  });

  it("refuses an accept by someone who is neither the requester nor a Lobby keeper", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    await expect(accept(db, bus, f.pawbot.actor, req.id, [f.shared.id])).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a participant that has not offered", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    await expect(accept(db, bus, f.claude.actor, req.id, [f.bobbot.id])).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses to accept more than wanted", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { wanted: 1 }));
    await offer(db, bus, f.pawbot.actor, req.id, {});
    await offer(db, bus, f.shared.actor, req.id, {});
    await expect(accept(db, bus, f.claude.actor, req.id, [f.pawbot.id, f.shared.id])).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses once the requester has lost keeper standing in the target Weave", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const demote = () => setRole(db, bus, f.paw, f.target.weave.id, f.targetJoin.participant.id, "member").then(() => undefined);
    await expect(accept(db, bus, f.claude.actor, req.id, [f.pawbot.id], { beforeLock: demote }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect((await offersOf(req.id)).filter((o) => o.accepted)).toEqual([]);
    expect(await invitationsOf(req.id)).toEqual([]);
  });

  it("refuses once the target Weave has been archived", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const archive = () => archiveWeave(db, bus, f.paw, f.target.weave.id);
    await expect(accept(db, bus, f.claude.actor, req.id, [f.pawbot.id], { beforeLock: archive }))
      .rejects.toMatchObject({ code: "weave_archived" });
    expect(await invitationsOf(req.id)).toEqual([]);
  });

  it("refuses once the target Thread has been closed", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const close = () => closeThread(db, bus, f.paw, f.prThread.id);
    await expect(accept(db, bus, f.claude.actor, req.id, [f.pawbot.id], { beforeLock: close }))
      .rejects.toMatchObject({ code: "thread_closed" });
    expect(await invitationsOf(req.id)).toEqual([]);
  });

  it("refuses a Lobby keeper acting for a requester whose target authority is gone", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    await setRole(db, bus, f.instanceKeeper, f.lobbyId, f.pawbot.id, "keeper");
    const lobbyKeeper = await resolveCredential(db, f.pawbot.token);
    await setRole(db, bus, f.paw, f.target.weave.id, f.targetJoin.participant.id, "member");
    await expect(accept(db, bus, lobbyKeeper, req.id, [f.shared.id])).rejects.toMatchObject({ code: "forbidden" });
    expect(await invitationsOf(req.id)).toEqual([]);
  });

  it("rolls the whole acceptance back when it cannot finish", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const before = (await threadEvents(f, req.threadId)).length;
    await expect(accept(db, bus, f.claude.actor, req.id, [f.pawbot.id], { afterMutation: async () => { throw new Error("boom"); } }))
      .rejects.toThrow("boom");
    expect((await offersOf(req.id)).filter((o) => o.accepted)).toEqual([]);
    expect(await invitationsOf(req.id)).toEqual([]);
    expect((await threadEvents(f, req.threadId)).length).toBe(before);
    expect((await rowOf(req.id)).status).toBe("open");
  });

  it("waits for the target Weave row rather than deadlocking on it", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const held = await holdWeaveRow(f.target.weave.id);

    const accepting = accept(db, bus, f.claude.actor, req.id, [f.pawbot.id]).then(() => "done" as const);
    expect(await settledWithin(accepting, 200)).toBe("waiting");

    await held.release();
    expect(await accepting).toBe("done");
    expect(await invitationsOf(req.id)).toHaveLength(1);
  });

  it("takes the Lobby row before the target row", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const held = await holdWeaveRow(f.lobbyId);

    const accepting = accept(db, bus, f.claude.actor, req.id, [f.pawbot.id]).then(() => "done" as const);
    let targetFree: boolean;
    try {
      expect(await settledWithin(accepting, 200)).toBe("waiting");
      // Blocked on the Lobby row while holding nothing else, so a third transaction can still take
      // the target row. Were the order the other way round, accept would already hold the target
      // row and this probe would be refused (55P03) — which is what pins the order down.
      targetFree = await canLockWeaveRow(f.target.weave.id);
    } finally {
      await held.release();                  // never leave accept blocked on a failed assertion
    }
    expect(targetFree).toBe(true);
    expect(await accepting).toBe("done");
    expect(await invitationsOf(req.id)).toHaveLength(1);
  });
});

describe("cancelRequest", () => {
  it("addresses the closure to the requester and the offerers it did not accept", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    await accept(db, bus, f.claude.actor, req.id, [f.pawbot.id]);
    const cancelled = await cancelRequest(db, bus, f.claude.actor, req.id);

    expect(cancelled.status).toBe("cancelled");
    const evs = await threadEvents(f, req.threadId);
    expect(evs.slice(-2).map((e) => e.type)).toEqual(["request.closed", "thread.closed"]);
    expect(evs.at(-2)!.payload).toEqual({ requestId: req.id, requesterId: f.claude.id, to: [f.claude.id, f.shared.id], reason: "cancelled", accepted: [f.pawbot.id] });
  });

  it("lets a Lobby keeper cancel", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    expect((await cancelRequest(db, bus, f.instanceKeeper, req.id)).status).toBe("cancelled");
  });

  it("refuses a cancel by anyone else", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    await expect(cancelRequest(db, bus, f.pawbot.actor, req.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

/**
 * A lock wait is unbounded: whoever holds the Weave row decides how long the next writer waits, and
 * the deadline may pass in the meantime. Every mutation must therefore decide expiry from a clock
 * read taken **inside** the lock — a reader looking at the same row already calls it `expired`.
 *
 * The deadline is pushed with a JS time this test controls rather than a database `now()`: the host
 * clock here can step backwards by about a second, so the margins below are generous and both sides
 * of the comparison come from the same clock.
 */
describe("a deadline crossed while waiting for the Weave lock", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const expiresIn = (requestId: string, ms: number) =>
    db.update(requestsTable).set({ expiresAt: new Date(Date.now() + ms) }).where(eq(requestsTable.id, requestId));
  /** The rejection's code, or what the call answered when it wrongly succeeded. */
  const codeOf = (p: Promise<unknown>) => p.then(() => "resolved" as const, (e: { code?: string }) => e.code ?? "error");

  it("refuses an accept whose wait for the target row crossed the deadline", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const before = (await threadEvents(f, req.threadId)).length;
    const held = await holdWeaveRow(f.target.weave.id);

    await expiresIn(req.id, 400);
    const accepting = codeOf(accept(db, bus, f.claude.actor, req.id, [f.pawbot.id]));
    expect(await settledWithin(accepting, 200)).toBe("waiting");
    await sleep(1200);                                   // the deadline passes while accept waits
    await held.release();

    expect(await accepting).toBe("request_closed");
    expect((await offersOf(req.id)).filter((o) => o.accepted)).toEqual([]);
    expect(await invitationsOf(req.id)).toEqual([]);
    expect((await threadEvents(f, req.threadId)).slice(before)).toEqual([]);
  });

  it("refuses an offer whose wait for the Lobby row crossed the deadline", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    const before = (await threadEvents(f, req.threadId)).length;
    const held = await holdWeaveRow(f.lobbyId);

    await expiresIn(req.id, 400);
    const offering = codeOf(offer(db, bus, f.pawbot.actor, req.id, { note: "pawbot" }));
    await sleep(1200);
    await held.release();

    expect(await offering).toBe("request_closed");
    expect(await offersOf(req.id)).toEqual([]);
    expect((await threadEvents(f, req.threadId)).slice(before)).toEqual([]);
  });

  it("refuses a cancel whose wait for the Lobby row crossed the deadline", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    const before = (await threadEvents(f, req.threadId)).length;
    const held = await holdWeaveRow(f.lobbyId);

    await expiresIn(req.id, 400);
    const cancelling = codeOf(cancelRequest(db, bus, f.claude.actor, req.id));
    await sleep(1200);
    await held.release();

    expect(await cancelling).toBe("request_closed");
    expect((await rowOf(req.id)).status).toBe("open");   // left for the sweeper to close as expired
    expect((await threadEvents(f, req.threadId)).slice(before)).toEqual([]);
  });
});

describe("expiry", () => {
  const later = (req: { expiresAt: string }) => new Date(new Date(req.expiresAt).getTime() + 1000);

  it("reads a crossed deadline as expired while the row still says open", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { timeoutMs: 60_000 }));
    expect((await getRequest(db, f.claude.actor, req.id, later(req))).status).toBe("expired");
    expect((await rowOf(req.id)).status).toBe("open");
  });

  it("leaves a computed-expired request out of the open list", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { timeoutMs: 60_000 }));
    expect(await listRequests(db, f.claude.actor, { status: "open" }, later(req))).toEqual([]);
    expect((await listRequests(db, f.claude.actor, { status: "expired" }, later(req))).map((r) => r.id)).toEqual([req.id]);
  });

  it("closes a crossed request exactly once, addressing its unaccepted offerers", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { wanted: 2, timeoutMs: 60_000 }));
    await offer(db, bus, f.pawbot.actor, req.id, {});          // Shared is eligible but never offers
    const at = later(req);

    expect(await sweepRequests(db, bus, at)).toBe(1);
    const evs = await threadEvents(f, req.threadId);
    expect(evs.slice(-2).map((e) => e.type)).toEqual(["request.closed", "thread.closed"]);
    expect(evs.at(-2)!.payload).toEqual({ requestId: req.id, requesterId: f.claude.id, to: [f.claude.id, f.pawbot.id], reason: "expired", accepted: [] });
    expect(evs.at(-1)!.payload).toEqual({ threadId: req.threadId, requestId: req.id });
    expect((await rowOf(req.id)).status).toBe("expired");

    const after = evs.length;
    expect(await sweepRequests(db, bus, new Date(at.getTime() + 1000))).toBe(0);
    expect((await threadEvents(f, req.threadId)).length).toBe(after);
  });
});

describe("reading requests", () => {
  it("refuses a caller who cannot read the Lobby", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    await expect(getRequest(db, f.paw, req.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns the offers with the request", async () => {
    const f = await setup();
    const req = await twoOffers(f);
    const got = await getRequest(db, f.claude.actor, req.id);
    expect(got.offers.map((o) => o.participantId)).toEqual([f.pawbot.id, f.shared.id]);
    expect(got.targetWeaveTitle).toBe(TARGET_TITLE);
  });

  // The status a caller asks for is the computed one, and the filter now runs in SQL: a row still
  // stored `open` past its deadline has to be selected by the `expired` query and left out of the
  // `open` one, exactly as the in-memory filter used to decide.
  it("lists a crossed but unswept request as expired, never as open", async () => {
    const f = await setup();
    const req = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { timeoutMs: 60_000 }));
    const at = new Date(new Date(req.expiresAt).getTime() + 1000);
    expect((await rowOf(req.id)).status).toBe("open");
    expect((await listRequests(db, f.claude.actor, { status: "expired" }, at)).map((r) => r.id)).toEqual([req.id]);
    expect(await listRequests(db, f.claude.actor, { status: "open" }, at)).toEqual([]);
  });

  it("takes a limit, newest first, and refuses one outside the page bounds", async () => {
    const f = await setup();
    const first = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f));
    const second = await openRequest(db, bus, f.claude.actor, f.targetKeeper, inputFor(f, { title: "Review PR 15" }));
    // Stamped here rather than trusted: `created_at` is whatever the database clock said, and what
    // is under test is that the page is taken from the newest end of that column, not the clock.
    await db.update(requestsTable).set({ createdAt: new Date("2026-09-16T10:00:00Z") }).where(eq(requestsTable.id, first.id));
    await db.update(requestsTable).set({ createdAt: new Date("2026-09-16T11:00:00Z") }).where(eq(requestsTable.id, second.id));
    expect((await listRequests(db, f.claude.actor, {})).map((r) => r.id)).toEqual([second.id, first.id]);
    expect((await listRequests(db, f.claude.actor, { limit: 1 })).map((r) => r.id)).toEqual([second.id]);
    await expect(listRequests(db, f.claude.actor, { limit: 0 })).rejects.toMatchObject({ code: "validation" });
  });
});
