import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, requestOffers, requests as requestsTable } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { createWeave, joinWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { setRole } from "../src/participants.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities } from "../src/lobby/profile.js";
import { accept, complete, offer, openRequest, sweepOverdue } from "../src/lobby/requests.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const MODEL = { model: "gpt-5.6-sol", effort: "high" };
const HOUR = 3_600_000;

/** A requester, two listeners it admits, and a request wanting both, each accepted with an hour. */
async function working() {
  const { weaveId: lobbyId } = await ensureLobby(db);
  const target = await createWeave(db, bus, { title: "Session", opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw = await resolveCredential(db, target.token);
  const thread = await createThread(db, bus, paw, target.weave.id, "PR 14", "https://e.com/pr/14");
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
  const request = await openRequest(db, bus, claude.actor, targetKeeper, {
    title: "Review PR 14", requirements: { models: [MODEL] }, wanted: 2,
    targetWeaveId: target.weave.id, targetThreadId: thread.id, url: null,
  });
  await offer(db, bus, pawbot.actor, request.id, {});
  await offer(db, bus, shared.actor, request.id, {});
  await accept(db, bus, claude.actor, request.id, [pawbot.id, shared.id], { deadlineMs: HOUR });
  const dueAt = (await db.select().from(requestOffers).where(eq(requestOffers.requestId, request.id)))[0]!.dueAt!;
  return { lobbyId, claude, pawbot, shared, request, dueAt };
}
type Working = Awaited<ReturnType<typeof working>>;

const overdues = async (f: Working) =>
  (await readEvents(db, f.lobbyId, { threadId: f.request.threadId })).filter((e) => e.type === "request.overdue");
const past = (f: Working, ms = 1) => new Date(f.dueAt.getTime() + ms);
const offerRow = async (f: Working, participantId: string) =>
  (await db.select().from(requestOffers).where(and(eq(requestOffers.requestId, f.request.id), eq(requestOffers.participantId, participantId))))[0]!;

describe("sweepOverdue", () => {
  it("sweepOverdue emits one request.overdue per overdue active acceptance, addressed to the requester, in the request Thread, with dueAt and lastSeenAt", async () => {
    const f = await working();
    const seen = new Date("2026-09-23T08:00:00.000Z");
    await db.update(participants).set({ lastSeenAt: seen }).where(eq(participants.id, f.shared.id));
    expect(await sweepOverdue(db, bus, past(f))).toBe(2);
    const evs = await overdues(f);
    expect(evs.map((e) => [e.actor, e.threadId])).toEqual([["system", f.request.threadId], ["system", f.request.threadId]]);
    expect(evs.map((e) => e.payload)).toEqual(expect.arrayContaining([
      { requestId: f.request.id, participantId: f.pawbot.id, dueAt: f.dueAt.toISOString(), lastSeenAt: expect.any(String), to: f.claude.id },
      { requestId: f.request.id, participantId: f.shared.id, dueAt: f.dueAt.toISOString(), lastSeenAt: seen.toISOString(), to: f.claude.id },
    ]));
    expect((await offerRow(f, f.pawbot.id)).overdueAt).toEqual(past(f));
  });

  it("a second sweep emits nothing for the same acceptance", async () => {
    const f = await working();
    expect(await sweepOverdue(db, bus, past(f))).toBe(2);
    expect(await sweepOverdue(db, bus, past(f, 60_000))).toBe(0);
    expect(await overdues(f)).toHaveLength(2);
  });

  it("two concurrent sweeps emit once", async () => {
    const f = await working();
    const [a, b] = await Promise.all([sweepOverdue(db, bus, past(f)), sweepOverdue(db, bus, past(f))]);
    expect(a + b).toBe(2);
    expect((await overdues(f)).map((e) => e.payload.participantId).sort()).toEqual([f.pawbot.id, f.shared.id].sort());
  });

  it("completed and removed acceptances are never overdue", async () => {
    const f = await working();
    await complete(db, bus, f.pawbot.actor, f.request.id);
    await db.update(requestOffers).set({ removedAt: new Date() })
      .where(and(eq(requestOffers.requestId, f.request.id), eq(requestOffers.participantId, f.shared.id)));
    expect(await sweepOverdue(db, bus, past(f))).toBe(0);
    expect(await overdues(f)).toEqual([]);
  });

  it("an acceptance with no due_at (made before 0005) is never overdue", async () => {
    const f = await working();
    await db.update(requestOffers).set({ dueAt: null }).where(eq(requestOffers.requestId, f.request.id));
    expect(await sweepOverdue(db, bus, new Date(Date.now() + 30 * 24 * HOUR))).toBe(0);
  });

  it("the request stays working after an overdue", async () => {
    const f = await working();
    await sweepOverdue(db, bus, past(f));
    const [row] = await db.select().from(requestsTable).where(eq(requestsTable.id, f.request.id));
    expect(row!.status).toBe("working");
    expect(row!.closedAt).toBeNull();
  });

  it("an overdue advances lastEventSeq", async () => {
    const f = await working();
    await sweepOverdue(db, bus, past(f));
    const [row] = await db.select().from(requestsTable).where(eq(requestsTable.id, f.request.id));
    expect(row!.lastEventSeq).toBe(Math.max(...(await overdues(f)).map((e) => e.seq)));
  });

  it("a revived acceptance can be overdue again", async () => {
    const f = await working();
    await sweepOverdue(db, bus, past(f));
    await db.update(requestOffers).set({ removedAt: new Date() })
      .where(and(eq(requestOffers.requestId, f.request.id), eq(requestOffers.participantId, f.pawbot.id)));
    await accept(db, bus, f.claude.actor, f.request.id, [f.pawbot.id], { deadlineMs: HOUR });
    const revived = await offerRow(f, f.pawbot.id);
    expect(revived.overdueAt).toBeNull();
    expect(await sweepOverdue(db, bus, new Date(revived.dueAt!.getTime() + 1))).toBe(1);
    expect((await overdues(f)).filter((e) => e.payload.participantId === f.pawbot.id)).toHaveLength(2);
  });

  it("sweepOverdue at exactly dueAt emits, and 1 ms before it does not", async () => {
    const f = await working();
    expect(await sweepOverdue(db, bus, new Date(f.dueAt.getTime() - 1))).toBe(0);
    expect(await sweepOverdue(db, bus, f.dueAt)).toBe(2);
  });
});
