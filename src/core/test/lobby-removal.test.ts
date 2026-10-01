import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, readPositions, requestOffers, requests as requestsTable, weaves } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential, stampSeen } from "../src/actors.js";
import { createWeave, getWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { markRead } from "../src/reads.js";
import { inbox } from "../src/inbox.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { updateSettings } from "../src/settings.js";
import { removeParticipant } from "../src/removals.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { findAgents, setCapabilities } from "../src/lobby/profile.js";
import { listListeners } from "../src/lobby/listeners.js";
import { accept, cancelRequest, complete, getRequest, offer, openRequest, sweepOverdue, sweepRequests } from "../src/lobby/requests.js";
import { isRemovable, sweepOfflineListeners } from "../src/lobby/removal.js";
import type { Db } from "../src/db/index.js";
import type { Actor, LoomEvent } from "../src/types.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("isRemovable (spec 2026-09-30 §3.2)", () => {
  const NOW = new Date("2026-09-30T18:00:00.000Z");
  const back = (ms: number) => new Date(NOW.getTime() - ms);
  const PROFILE = { owner: "paw" };
  const L = (lastSeenAt: Date | null, capabilities: unknown = PROFILE, joinedAt: Date = back(30 * DAY)) => ({ capabilities, lastSeenAt, joinedAt });

  it("seen exactly the limit ago is kept; one millisecond more is removable", () => {
    expect([isRemovable(L(back(DAY)), DAY, NOW), isRemovable(L(back(DAY + 1)), DAY, NOW)]).toEqual([false, true]);
  });

  it("never seen counts from joinedAt: exactly the limit after joining is kept, one millisecond more is removable", () => {
    expect([isRemovable(L(null, PROFILE, back(DAY)), DAY, NOW), isRemovable(L(null, PROFILE, back(DAY + 1)), DAY, NOW)]).toEqual([false, true]);
  });

  it("off: a null limit removes nobody", () => {
    // Never seen and joined 30 days ago: removable under any limit, and kept with none.
    expect(isRemovable(L(null), null, NOW)).toBe(false);
  });

  it("no profile is never removable", () => {
    expect([isRemovable(L(null, null), DAY, NOW), isRemovable(L(back(30 * DAY), null), DAY, NOW)]).toEqual([false, false]);
  });

  it("an online Listener is kept past the limit", () => {
    const daily = { owner: "paw", pollIntervalMs: DAY };
    expect([
      isRemovable(L(back(2 * HOUR), daily), HOUR, NOW),
      isRemovable(L(back(172_800_001), daily), HOUR, NOW),
      isRemovable(L(back(172_800_000), daily), HOUR, NOW),
    ]).toEqual([false, true, false]);
  });
});

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

/**
 * The Lobby's reader (its own secret), a requester **with no profile** (so it is no Listener and is
 * never removed), a target Weave with a Thread, and `ask`, which opens a request wanting two that
 * every Listener of this file is eligible for (they serve anyone; the requester's owner is "").
 */
async function world() {
  const lobby = await ensureLobby(db);
  const reader = await resolveCredential(db, lobby.secret);
  const target = await createWeave(db, bus, { title: "Session", opener: "hi", creator: { name: "Paw", kind: "human" } });
  const keeper = await resolveCredential(db, target.token);
  const thread = await createThread(db, bus, keeper, target.weave.id, "PR 14");
  const asker = await joinLobby(db, bus, { name: "Asker", kind: "human" });
  const requester = await resolveCredential(db, asker.token);
  const general = (await getWeave(db, reader, lobby.weaveId)).threads.find((t) => t.isGeneral)!;
  const ask = (title: string) => openRequest(db, bus, requester, keeper, {
    title, requirements: {}, wanted: 2, targetWeaveId: target.weave.id, targetThreadId: thread.id, url: null,
  });
  return { lobbyId: lobby.weaveId, reader, requester, requesterId: asker.participant.id, generalId: general.id, ask };
}
type World = Awaited<ReturnType<typeof world>>;

/** A Listener serving anyone. Its check-in is then set by `seenAt`, against the `now` the test passes. */
async function listener(name: string, profile: Record<string, unknown> = {}) {
  const j = await joinLobby(db, bus, { name, kind: "agent" });
  const actor = await resolveCredential(db, j.token);
  await setCapabilities(db, bus, actor, { owner: `${name}-owner`, serves: "anyone", ...profile });
  return { id: j.participant.id, token: j.token, actor };
}

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);
const seenAt = (id: string, at: Date | null) => db.update(participants).set({ lastSeenAt: at }).where(eq(participants.id, id));
const joinedAt = (id: string, at: Date) => db.update(participants).set({ joinedAt: at }).where(eq(participants.id, id));
const row = async (id: string) => (await db.select().from(participants).where(eq(participants.id, id)))[0]!;
const log = (w: World) => readEvents(db, w.lobbyId, {});
const lastSeq = async (w: World) => (await log(w)).at(-1)!.seq;
const after = async (w: World, seq: number) => (await log(w)).filter((e) => e.seq > seq);
const ofType = (events: LoomEvent[], type: string) => events.filter((e) => e.type === type);
const keeper = async (): Promise<Actor> => { await seedKeepers(db, [keeperToken("k")]); return resolveCredential(db, keeperToken("k")); };

describe("sweepOfflineListeners against Postgres (spec 2026-09-30 §5, §6)", () => {
  it("the boundary: seen exactly the limit before now is kept, 1 ms earlier is removed, one pass returns 1 and writes one listener.removed", async () => {
    const w = await world();
    const kept = await listener("Kept");
    const gone = await listener("Gone");
    const now = new Date();
    await seenAt(kept.id, ago(now, DAY));
    await seenAt(gone.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect([(await row(kept.id)).capabilities !== null, (await row(gone.id)).capabilities]).toEqual([true, null]);
    expect(ofType(await log(w), "listener.removed").map((e) => e.payload.participantId)).toEqual([gone.id]);
  });

  it("a never-seen Listener is removed a limit after it joined, not before", async () => {
    const w = await world();
    const late = await listener("Late");
    const early = await listener("Early");
    const now = new Date();
    for (const l of [late, early]) await seenAt(l.id, null);
    await joinedAt(late.id, ago(now, DAY));
    await joinedAt(early.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect([(await row(late.id)).capabilities !== null, (await row(early.id)).capabilities]).toEqual([true, null]);
    expect(ofType(await log(w), "listener.removed").map((e) => [e.payload.participantId, e.payload.lastSeenAt])).toEqual([[early.id, null]]);
  });

  it("off: with the setting null a pass returns 0 and writes nothing, however old the Listeners are; after setting 3600000 the next pass removes them", async () => {
    const w = await world();
    const k = await keeper();
    await updateSettings(db, k, { removeOfflineListenersAfterMs: null });
    const old = await listener("Old");
    const never = await listener("Never");
    const now = new Date();
    await seenAt(old.id, ago(now, 30 * DAY));
    await seenAt(never.id, null);
    await joinedAt(never.id, ago(now, 30 * DAY));
    const before = await log(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(0);
    expect(await log(w)).toEqual(before);
    await updateSettings(db, k, { removeOfflineListenersAfterMs: 3_600_000 });
    expect(await sweepOfflineListeners(db, bus, now)).toBe(2);
  });

  it("a participant with no profile is left alone and nothing is written", async () => {
    const w = await world();
    const bare = await joinLobby(db, bus, { name: "Bare", kind: "agent" });
    const now = new Date();
    await seenAt(bare.participant.id, ago(now, 30 * DAY));
    await seenAt(w.requesterId, null);
    await joinedAt(w.requesterId, ago(now, 30 * DAY));
    const before = await log(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(0);
    expect(await log(w)).toEqual(before);
  });

  it("a removal clears the profile and keeps the participant: row, name, token, lastSeenAt, seen_history, messages and read positions", async () => {
    const w = await world();
    const l = await listener("Historian");
    const said = await postMessage(db, bus, l.actor, w.generalId, "hello");
    await markRead(db, l.actor, w.generalId, said.seq);
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const before = await row(l.id);
    const positions = () => db.select().from(readPositions).where(eq(readPositions.participantId, l.id));
    const positionsBefore = await positions();
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect(await row(l.id)).toEqual({ ...before, capabilities: null });
    expect(await positions()).toEqual(positionsBefore);
    expect((await log(w)).find((e) => e.seq === said.seq)).toEqual(said);
    expect((await getWeave(db, w.reader, w.lobbyId)).participants.map((p) => p.id)).toContain(l.id);
  });

  it("listener.removed: payload, actor, Thread and order", async () => {
    const w = await world();
    const l = await listener("Payload", { tools: ["github"], pollIntervalMs: 300_000 });
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const now = new Date();
    const seen = ago(now, DAY + 1);
    await seenAt(l.id, seen);
    const stored = (await row(l.id)).capabilities;
    const from = await lastSeq(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const fresh = await after(w, from);
    expect(fresh.map((e) => [e.seq, e.type, e.threadId, e.actor])).toEqual([
      [from + 1, "listener.removed", w.generalId, "system"],
      [from + 2, "request.offer_withdrawn", r.threadId, "system"],
    ]);
    expect(fresh[0]!.payload).toEqual({ participantId: l.id, reason: "offline", lastSeenAt: seen.toISOString(), afterMs: DAY, previous: stored, withdrawn: [r.id] });
  });

  it("open offers are withdrawn: an open request inside its window and a working one; a closed one and an open one past expiresAt are left alone", async () => {
    const w = await world();
    const l = await listener("Offerer");
    const helper = await listener("Helper");
    const inWindow = await w.ask("Open");
    const working = await w.ask("Working");
    const closed = await w.ask("Closed");
    const lapsed = await w.ask("Lapsed");
    for (const r of [inWindow, working, closed, lapsed]) await offer(db, bus, l.actor, r.id, {});
    // Offer order is created_at; the database clock can step backwards (HANDBOOK §5), so it is pinned.
    const pin = (requestId: string, at: string) => db.update(requestOffers).set({ createdAt: new Date(at) })
      .where(and(eq(requestOffers.requestId, requestId), eq(requestOffers.participantId, l.id)));
    await pin(inWindow.id, "2026-09-30T10:00:00.000Z");
    await pin(working.id, "2026-09-30T10:00:01.000Z");
    await offer(db, bus, helper.actor, working.id, {});
    await accept(db, bus, w.requester, working.id, [helper.id], { deadlineMs: HOUR });
    await cancelRequest(db, bus, w.requester, closed.id);
    await db.update(requestsTable).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(requestsTable.id, lapsed.id));
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const untouched = async () => ({
      offers: await db.select().from(requestOffers).where(inArray(requestOffers.requestId, [closed.id, lapsed.id])).orderBy(asc(requestOffers.requestId)),
      requests: await db.select().from(requestsTable).where(inArray(requestsTable.id, [closed.id, lapsed.id])).orderBy(asc(requestsTable.id)),
    });
    const before = await untouched();
    const from = await lastSeq(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const fresh = await after(w, from);
    expect(fresh.map((e) => [e.type, e.threadId, e.actor, e.type === "listener.removed" ? e.payload.withdrawn : e.payload])).toEqual([
      ["listener.removed", w.generalId, "system", [inWindow.id, working.id]],
      ["request.offer_withdrawn", inWindow.threadId, "system", { requestId: inWindow.id, participantId: l.id, reason: "offline", to: w.requesterId }],
      ["request.offer_withdrawn", working.threadId, "system", { requestId: working.id, participantId: l.id, reason: "offline", to: w.requesterId }],
    ]);
    const version = async (id: string) => (await db.select().from(requestsTable).where(eq(requestsTable.id, id)))[0]!.lastEventSeq;
    expect([await version(inWindow.id), await version(working.id)]).toEqual([fresh[1]!.seq, fresh[2]!.seq]);
    expect(await db.select().from(requestOffers)
      .where(and(eq(requestOffers.participantId, l.id), inArray(requestOffers.requestId, [inWindow.id, working.id])))).toEqual([]);
    expect(await untouched()).toEqual(before);
  });

  it("accepted work is untouched: an active, a completed and a removed acceptance stay, the request stays working, overdue still fires, getRequest shows offline, and complete still succeeds", async () => {
    const w = await world();
    const l = await listener("Worker");
    const active = await w.ask("Active");
    const done = await w.ask("Done");
    const dropped = await w.ask("Dropped");
    for (const r of [active, done, dropped]) {
      await offer(db, bus, l.actor, r.id, {});
      await accept(db, bus, w.requester, r.id, [l.id], { deadlineMs: HOUR });
    }
    await complete(db, bus, l.actor, done.id, { note: "done" });
    await removeParticipant(db, bus, w.requester, dropped.threadId, l.id);
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const mine = () => db.select().from(requestOffers).where(eq(requestOffers.participantId, l.id)).orderBy(asc(requestOffers.requestId));
    const before = await mine();
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect(await mine()).toEqual(before);
    expect((await getRequest(db, w.reader, active.id, now)).status).toBe("working");
    const dueAt = before.find((o) => o.requestId === active.id)!.dueAt!;
    expect(await sweepOverdue(db, bus, new Date(dueAt.getTime() + 1))).toBe(1);
    expect(ofType(await readEvents(db, w.lobbyId, { threadId: active.threadId }), "request.overdue").map((e) => e.payload.participantId)).toEqual([l.id]);
    expect((await getRequest(db, w.reader, active.id, now)).acceptances).toEqual([expect.objectContaining({ participantId: l.id, listenerStatus: "offline" })]);
    await expect(complete(db, bus, l.actor, active.id, { note: "late" })).resolves.toMatchObject({ status: "completed" });
  });

  it("the inbox: listener.removed reaches only the removed Listener, request.offer_withdrawn only the requester", async () => {
    const w = await world();
    const l = await listener("Removed");
    const coOfferer = await listener("CoOfferer");
    const bystander = await listener("Bystander");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    await offer(db, bus, coOfferer.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const since = await lastSeq(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const types = async (actor: Actor) => (await inbox(db, actor, w.lobbyId, { since })).map((i) => i.type);
    expect(await types(l.actor)).toEqual(["listener.removed"]);
    expect(await types(w.requester)).toEqual(["request.offer_withdrawn"]);
    expect(await types(coOfferer.actor)).toEqual([]);
    expect(await types(bystander.actor)).toEqual([]);
  });

  it("a daily poller seen 25 hours ago is a candidate and kept: the pass returns 0, writes nothing, and its profile and offers are unchanged", async () => {
    const w = await world();
    const l = await listener("Daily", { pollIntervalMs: DAY });
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, 25 * HOUR));
    const state = async () => ({ row: await row(l.id), offers: await db.select().from(requestOffers).where(eq(requestOffers.participantId, l.id)), log: await log(w) });
    const before = await state();
    const candidates: string[] = [];
    expect(await sweepOfflineListeners(db, bus, now, { beforeLock: async (id) => { candidates.push(id); } })).toBe(0);
    expect(candidates).toEqual([l.id]);
    expect(await state()).toEqual(before);
  });

  it("joined_at with microseconds: 500 microseconds inside the limit is kept, 500 microseconds past it is removed", async () => {
    await world();
    const inside = await listener("Inside");
    const past = await listener("Past");
    const now = new Date();
    const cutoff = ago(now, DAY).toISOString();
    for (const l of [inside, past]) await seenAt(l.id, null);
    await db.execute(sql`update participants set joined_at = ${cutoff}::timestamptz + interval '500 microseconds' where id = ${inside.id}`);
    await db.execute(sql`update participants set joined_at = ${cutoff}::timestamptz - interval '500 microseconds' where id = ${past.id}`);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect([(await row(inside.id)).capabilities !== null, (await row(past.id)).capabilities]).toEqual([true, null]);
  });

  it("accept naming a withdrawn offer is refused, and getRequest lists it no more", async () => {
    const w = await world();
    const l = await listener("Withdrawn");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    await expect(accept(db, bus, w.requester, r.id, [l.id], { deadlineMs: HOUR }))
      .rejects.toMatchObject({ code: "validation", message: "That participant has not offered on this request" });
    expect((await getRequest(db, w.reader, r.id)).offers.map((o) => o.participantId)).not.toContain(l.id);
  });

  it("a withdrawn offerer is not told when the request later closes", async () => {
    const w = await world();
    const l = await listener("Gone");
    const other = await listener("Stays");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    await offer(db, bus, other.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect(await sweepRequests(db, bus, new Date(Date.parse(r.expiresAt) + 1))).toBe(1);
    const closed = ofType(await readEvents(db, w.lobbyId, { threadId: r.threadId }), "request.closed");
    expect(closed.map((e) => e.payload.to)).toEqual([[w.requesterId, other.id]]);
  });

  it("no removal event carries a secret or a token", async () => {
    const w = await world();
    const { key } = await addAgent(db, await keeper(), "ChatGPT", "paw");
    const joined = await joinLobby(db, bus, { kind: "agent" }, await resolveCredential(db, key));
    const keyed = await resolveCredential(db, joined.token);
    await setCapabilities(db, bus, keyed, { serves: "anyone" });          // the owner comes from the key
    for (const title of ["Review PR 14", "Review PR 15"]) await offer(db, bus, keyed, (await w.ask(title)).id, {});
    const now = new Date();
    await seenAt(joined.participant.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const secrets = [
      key,
      ...(await db.select({ s: weaves.secret }).from(weaves)).map((x) => x.s),
      ...(await db.select({ t: participants.token }).from(participants)).map((p) => p.t),
    ];
    const events = await log(w);
    expect(events.map((e) => e.type).filter((t) => t === "listener.removed" || t === "request.offer_withdrawn"))
      .toEqual(["listener.removed", "request.offer_withdrawn", "request.offer_withdrawn"]);
    for (const e of events) for (const s of secrets) expect(JSON.stringify(e.payload)).not.toContain(s);
  });

  it("concurrent sweeps write one event per removal", async () => {
    const w = await world();
    const ls = [await listener("One"), await listener("Two"), await listener("Three")];
    for (const title of ["Review PR 14", "Review PR 15"]) await offer(db, bus, ls[0]!.actor, (await w.ask(title)).id, {});
    const now = new Date();
    for (const l of ls) await seenAt(l.id, ago(now, DAY + 1));
    const [a, b] = await Promise.all([sweepOfflineListeners(db, bus, now), sweepOfflineListeners(db, bus, now)]);
    expect(a! + b!).toBe(3);
    const events = await log(w);
    expect([ofType(events, "listener.removed").length, ofType(events, "request.offer_withdrawn").length]).toEqual([3, 2]);
  });

  it("a check-in racing the pass wins: stamped after the candidates are read and before the lock, the Listener is kept and nothing is written", async () => {
    const w = await world();
    const l = await listener("Racer");
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const before = await log(w);
    const removed = await sweepOfflineListeners(db, bus, now, {
      beforeLock: async (id) => { await stampSeen(db, eq(participants.id, id), new Date(now.getTime() + 1)); },
    });
    expect(removed).toBe(0);
    expect((await row(l.id)).capabilities).not.toBeNull();
    expect(await log(w)).toEqual(before);
  });

  it("the directory, the counts and find_agents drop a removed Listener", async () => {
    const w = await world();
    const stays = await listener("Stays");
    const goes = await listener("Goes");
    const now = new Date();
    await seenAt(stays.id, ago(now, 2 * HOUR));        // offline, and inside the limit
    await seenAt(goes.id, ago(now, DAY + 1));
    const page = () => listListeners(db, w.reader, {}, now);
    const found = async () => (await findAgents(db, w.reader, {}, now)).map((a) => a.participant.id);
    const before = await page();
    const foundBefore = await found();
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const afterPage = await page();
    expect([afterPage.total, afterPage.matched, afterPage.statusCounts.offline])
      .toEqual([before.total - 1, before.matched - 1, before.statusCounts.offline - 1]);
    expect(foundBefore).toContain(goes.id);
    expect(await found()).toEqual(foundBefore.filter((id) => id !== goes.id));
  });

  it("a request opened after the removal does not address it", async () => {
    const w = await world();
    const gone = await listener("Gone");
    const here = await listener("Here");
    const now = new Date();
    await seenAt(gone.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect((await w.ask("Review PR 14")).eligible).toEqual([here.id]);
  });

  it("a returning Listener rejoins by setting its profile: listed, found, a participant.capabilities_changed, a new offer, and kept by the next pass", async () => {
    const w = await world();
    const l = await listener("Returner");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const back = await resolveCredential(db, l.token, now);            // its first call after the removal stamps it
    await setCapabilities(db, bus, back, { owner: "Returner-owner", serves: "anyone" });
    expect((await log(w)).at(-1)).toMatchObject({ type: "participant.capabilities_changed", payload: { participantId: l.id } });
    expect((await listListeners(db, w.reader, {}, now)).listeners.map((x) => x.participant.id)).toContain(l.id);
    expect((await findAgents(db, w.reader, {}, now)).map((a) => a.participant.id)).toContain(l.id);
    await offer(db, bus, back, r.id, {});
    expect(ofType(await readEvents(db, w.lobbyId, { threadId: r.threadId }), "request.offered").map((e) => e.payload.participantId)).toEqual([l.id, l.id]);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(0);
  });

  it("set_capabilities(null) by the Listener itself writes only participant.capabilities_changed: its offers stand, and no listener.removed is written then or by a later pass", async () => {
    const w = await world();
    const l = await listener("Leaver");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const from = await lastSeq(w);
    await setCapabilities(db, bus, l.actor, null);
    const now = new Date();
    await seenAt(l.id, ago(now, 30 * DAY));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(0);
    expect((await after(w, from)).map((e) => e.type)).toEqual(["participant.capabilities_changed"]);
    expect(await db.select({ requestId: requestOffers.requestId }).from(requestOffers).where(eq(requestOffers.participantId, l.id))).toEqual([{ requestId: r.id }]);
  });
});
