import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, requestOffers, requests as requestsTable } from "../src/db/schema.js";
import { resolveCredential } from "../src/actors.js";
import { createWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities, findAgents } from "../src/lobby/profile.js";
import { accept, getRequest, offer, openRequest } from "../src/lobby/requests.js";
import { listListeners } from "../src/lobby/listeners.js";
import { cadenceOf, isOnline, listenerStatus, workFor, DEFAULT_POLL_INTERVAL_MS, type ListenerStatus } from "../src/lobby/status.js";
import { randomUUID } from "node:crypto";
import type { Listener, ListenersPage, ListenersQuery } from "../src/lobby/listeners-input.js";
import type { Profile } from "../src/lobby/matching.js";
import type { Db, Queryable } from "../src/db/index.js";
import type { Actor } from "../src/types.js";

describe("cadenceOf (spec 2026-09-27 §4.4)", () => {
  const T = Date.parse("2026-09-27T10:00:00.000Z");
  /** Check-ins at T and then after each gap in turn, oldest first, as `seen_history` stores them. */
  const history = (gaps: number[]): Date[] =>
    gaps.reduce<Date[]>((out, g) => [...out, new Date(out.at(-1)!.getTime() + g)], [new Date(T)]);

  it("fewer than two check-ins gives null gaps", () => {
    expect([cadenceOf(null), cadenceOf([]), cadenceOf([new Date(T)])]).toEqual([
      { typicalGapMs: null, longestGapMs: null, samples: 0 },
      { typicalGapMs: null, longestGapMs: null, samples: 0 },
      { typicalGapMs: null, longestGapMs: null, samples: 1 },
    ]);
  });

  it("twenty check-ins give nineteen gaps", () => {
    // 11 000 to 29 000 ms in steps of 1 000, shuffled (7 is coprime with 19): the median must be sorted for.
    const gaps = Array.from({ length: 19 }, (_, i) => 11_000 + ((i * 7) % 19) * 1_000);
    expect(cadenceOf(history(gaps))).toEqual({ typicalGapMs: 20_000, longestGapMs: 29_000, samples: 20 });
  });

  it("an even number of gaps takes the floor of the mean of the two middle ones", () => {
    // Sorted 11 000, 20 001, 20 004, 40 000: the mean of the middle two is 20 002.5.
    expect(cadenceOf(history([40_000, 20_001, 11_000, 20_004]))).toEqual({ typicalGapMs: 20_002, longestGapMs: 40_000, samples: 5 });
  });
});

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

/** The one clock every status read in this file uses; every listener's last check-in is set against it. */
const NOW = new Date("2026-09-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
/** A profile, cast because the cases include a value `validateProfile` would refuse (a non-numeric `pollIntervalMs`). */
const P = (over: Record<string, unknown> = {}): Profile => ({ owner: "paw", ...over }) as Profile;

describe("listenerStatus (spec 2026-09-27 §4.2)", () => {
  it("never seen is offline", () => {
    expect([listenerStatus(null, null, false, NOW), listenerStatus(P({ pollIntervalMs: 300_000 }), null, true, NOW)])
      .toEqual(["offline", "offline"]);
  });

  it("exactly twice the declared interval is online; one millisecond more is offline", () => {
    const p = P({ pollIntervalMs: 300_000 });
    expect([listenerStatus(p, ago(600_000), false, NOW), listenerStatus(p, ago(600_001), false, NOW)]).toEqual(["idle", "offline"]);
  });

  it("the 15 minute default: seen 30 min ago is online, 30 min and 1 ms ago is offline", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(900_000);
    for (const p of [null, P(), P({ pollIntervalMs: "5 min" })]) {
      expect({ p, got: [listenerStatus(p, ago(1_800_000), false, NOW), listenerStatus(p, ago(1_800_001), false, NOW)] })
        .toEqual({ p, got: ["idle", "offline"] });
    }
  });

  it("offline wins over working", () => {
    expect(listenerStatus(P({ pollIntervalMs: 300_000 }), ago(600_001), true, NOW)).toBe("offline");
  });

  it("online with work is working; online without is idle", () => {
    const p = P({ pollIntervalMs: 300_000 });
    expect([listenerStatus(p, ago(60_000), true, NOW), listenerStatus(p, ago(60_000), false, NOW)]).toEqual(["working", "idle"]);
  });

  it("isOnline agrees with listenerStatus across the boundary fixture: online exactly when the status is not offline (spec 2026-09-30 §3.2)", () => {
    const profiles = [null, P(), P({ pollIntervalMs: "5 min" }), P({ pollIntervalMs: 300_000 })];
    const seen = [null, ago(60_000), ago(600_000), ago(600_001), ago(1_800_000), ago(1_800_001)];
    for (const p of profiles) for (const s of seen) for (const work of [false, true]) {
      expect({ p, s, work, online: isOnline(p, s, NOW) }).toEqual({ p, s, work, online: listenerStatus(p, s, work, NOW) !== "offline" });
    }
  });
});

/**
 * The Lobby's reader (its own secret), a requester **with no profile** (so it is no listener, and
 * the listeners each test makes are the whole population), and a target Weave with a Thread.
 */
async function world() {
  const lobby = await ensureLobby(db);
  const reader = await resolveCredential(db, lobby.secret);
  const target = await createWeave(db, bus, { title: "Session", opener: "hi", creator: { name: "Paw", kind: "human" } });
  const keeper = await resolveCredential(db, target.token);
  const thread = await createThread(db, bus, keeper, target.weave.id, "PR 14");
  const asker = await joinLobby(db, bus, { name: "Asker", kind: "human" });
  const requester = await resolveCredential(db, asker.token);
  return { reader, target, keeper, thread, requester };
}
type World = Awaited<ReturnType<typeof world>>;

/** A listener serving anyone (the requester's owner is ""). Its last check-in is set by `seenAt`. */
async function listener(name: string, profile: Record<string, unknown> = {}) {
  const j = await joinLobby(db, bus, { name, kind: "agent" });
  const actor = await resolveCredential(db, j.token);
  await setCapabilities(db, bus, actor, { owner: `${name}-owner`, serves: "anyone", ...profile });
  return { id: j.participant.id, actor };
}
type L = Awaited<ReturnType<typeof listener>>;

/** A request every listener is eligible for: `taking` offer and are accepted with an hour, `offeringOnly` only offer. */
async function work(w: World, title: string, taking: L[], offeringOnly: L[] = []) {
  const r = await openRequest(db, bus, w.requester, w.keeper, {
    title, requirements: {}, wanted: Math.max(1, taking.length),
    targetWeaveId: w.target.weave.id, targetThreadId: w.thread.id, url: null,
  });
  for (const l of [...taking, ...offeringOnly]) await offer(db, bus, l.actor, r.id, {});
  if (taking.length > 0) await accept(db, bus, w.requester, r.id, taking.map((l) => l.id), { deadlineMs: 3_600_000 });
  return r;
}

/** Sets the last check-in, and a history that ends at it (spec §4.1: as right after a stamp that appended). */
const seenAt = (l: { id: string }, at: Date | null) =>
  db.update(participants).set({ lastSeenAt: at, seenHistory: at === null ? null : [at] }).where(eq(participants.id, l.id));
const setOffer = (requestId: string, l: { id: string }, change: Partial<typeof requestOffers.$inferInsert>) =>
  db.update(requestOffers).set(change).where(and(eq(requestOffers.requestId, requestId), eq(requestOffers.participantId, l.id)));
const setRequest = (requestId: string, change: Partial<typeof requestsTable.$inferInsert>) =>
  db.update(requestsTable).set(change).where(eq(requestsTable.id, requestId));
const rowOf = (page: ListenersPage, l: { id: string }) => page.listeners.find((x) => x.participant.id === l.id)!;

/**
 * The plan of the status counts query exactly as `listListeners` sends it: the read runs through a
 * handle that records every `execute`, the one carrying `count(*) FILTER` is picked out, and `run`
 * (the pool, or a transaction with planner settings of its own) explains it.
 */
async function countsPlan(run: Queryable, reader: Actor): Promise<string> {
  const seen: SQL[] = [];
  const recording = new Proxy(db, {
    get(target, key) {
      if (key === "execute") return (q: SQL) => { seen.push(q); return target.execute(q); };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await listListeners(recording, reader, { limit: 0, facets: false }, NOW);
  const counts = seen.filter((q) => new PgDialect().sqlToQuery(q).sql.includes("count(*) FILTER"));
  expect(counts).toHaveLength(1);
  const rows = await run.execute<Record<string, string>>(sql`EXPLAIN ${counts[0]!}`);
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}

describe("status and current work against Postgres (spec 2026-09-27 §4.2, §4.3)", () => {
  it("working needs an accepted, not removed, not completed acceptance on a request stored working", async () => {
    const w = await world();
    const unaccepted = await listener("unaccepted"), removed = await listener("removed"), completed = await listener("completed");
    const overdue = await listener("overdue"), legacy = await listener("legacy"), closed = await listener("closed");
    const shared = await work(w, "Shared", [removed, completed, overdue], [unaccepted]);
    await setOffer(shared.id, removed, { removedAt: NOW });
    await setOffer(shared.id, completed, { completedAt: NOW });
    await setOffer(shared.id, overdue, { dueAt: ago(1) });            // overdue is still an active work item
    const old = await work(w, "Legacy", [legacy]);
    await setRequest(old.id, { status: "open" });                     // stored open never makes anyone working
    const gone = await work(w, "Closed", [closed]);
    await setRequest(gone.id, { status: "cancelled", closedAt: NOW });
    const all = [unaccepted, removed, completed, overdue, legacy, closed];
    for (const l of all) await seenAt(l, ago(60_000));
    const page = await listListeners(db, w.reader, {}, NOW);
    expect(all.map((l) => rowOf(page, l).status)).toEqual(["idle", "idle", "idle", "working", "idle", "idle"]);
    expect((await listListeners(db, w.reader, { status: ["working"] }, NOW)).listeners.map((l) => l.participant.id)).toEqual([overdue.id]);
  });

  it("currentWork is the soonest due active item, with more counting the others", async () => {
    const w = await world();
    const busy = await listener("busy");
    const later = await work(w, "Later", [busy]);
    const tieA = await work(w, "Tie A", [busy]);
    const tieB = await work(w, "Tie B", [busy]);
    const tieC = await work(w, "Tie C", [busy]);
    const done = await work(w, "Done", [busy]);
    const due = new Date("2026-09-27T13:00:00.000Z");
    await setOffer(later.id, busy, { dueAt: new Date("2026-09-27T14:00:00.000Z") });
    for (const r of [tieA, tieB, tieC]) await setOffer(r.id, busy, { dueAt: due });
    // The three-way tie on due_at is broken by the request's created_at, pinned so the winner is
    // neither the first inserted (heap order) nor the smallest id (the last key): of B and C, the
    // one with the larger id. Postgres compares uuids bytewise, as JavaScript compares the
    // lowercase hex. Without the created_at key the answer is tieA or the smallest id, never this.
    const [winner, other] = tieB.id > tieC.id ? [tieB, tieC] : [tieC, tieB];
    await setRequest(winner.id, { createdAt: new Date("2026-09-27T08:00:00.000Z") });
    await setRequest(tieA.id, { createdAt: new Date("2026-09-27T09:00:00.000Z") });
    await setRequest(other.id, { createdAt: new Date("2026-09-27T10:00:00.000Z") });
    // Due soonest of all, but completed: not an active item, so neither current nor counted.
    await setOffer(done.id, busy, { dueAt: new Date("2026-09-27T12:30:00.000Z"), completedAt: NOW });
    await seenAt(busy, ago(60_000));
    const [row] = (await listListeners(db, w.reader, {}, NOW)).listeners;
    expect(row!.currentWork).toEqual({ requestId: winner.id, title: winner === tieB ? "Tie B" : "Tie C", threadId: winner.threadId, more: 3 });
  });

  it("currentWork carries the request's title and its Lobby Thread, and nothing of the target Weave", async () => {
    const w = await world();
    const busy = await listener("busy");
    const r = await work(w, "Review PR 14", [busy]);
    await seenAt(busy, ago(60_000));
    const current = (await listListeners(db, w.reader, {}, NOW)).listeners[0]!.currentWork!;
    expect(current).toEqual({ requestId: r.id, title: "Review PR 14", threadId: r.threadId, more: 0 });
    expect(Object.keys(current).sort()).toEqual(["more", "requestId", "threadId", "title"]);
    const text = JSON.stringify(current);
    expect([text.includes(w.target.weave.id), text.includes(w.thread.id), text.includes("Session")]).toEqual([false, false, false]);
  });

  it("an offline listener keeps its currentWork", async () => {
    const w = await world();
    const busy = await listener("busy");
    const r = await work(w, "Review PR 14", [busy]);
    await seenAt(busy, ago(2 * DEFAULT_POLL_INTERVAL_MS + 1));
    const [row] = (await listListeners(db, w.reader, {}, NOW)).listeners;
    expect([row!.status, row!.currentWork?.requestId]).toEqual(["offline", r.id]);
  });

  // Whole-branch review F4: `findAgents` hands `workFor` every matching listener, unbounded. One
  // bind parameter per id fails past the protocol's 65,535; one array parameter does not.
  it("workFor takes 70,000 ids in one query and finds the one that holds work", async () => {
    const w = await world();
    const busy = await listener("busy");
    const r = await work(w, "Review PR 14", [busy]);
    const ids = [...Array.from({ length: 70_000 }, () => randomUUID()), busy.id];
    const found = await workFor(db, ids);
    expect([[...found.keys()], found.get(busy.id)?.map((i) => i.requestId)]).toEqual([[busy.id], [r.id]]);
  });
});

describe("the status filter and the counts (spec 2026-09-27 §4.6)", () => {
  it("the status filter and the counts agree with the TypeScript rule", async () => {
    const w = await world();
    const DECLARED = 300_000;
    const cases: { name: string; profile: Record<string, unknown>; seen: Date | null }[] = [
      { name: "never", profile: { pollIntervalMs: DECLARED }, seen: null },
      { name: "at-twice", profile: { pollIntervalMs: DECLARED }, seen: ago(2 * DECLARED) },
      { name: "past-twice", profile: { pollIntervalMs: DECLARED }, seen: ago(2 * DECLARED + 1) },
      { name: "default-at", profile: {}, seen: ago(2 * DEFAULT_POLL_INTERVAL_MS) },
      { name: "default-past", profile: {}, seen: ago(2 * DEFAULT_POLL_INTERVAL_MS + 1) },
    ];
    const made = new Map<string, L>();
    let i = 0;
    for (const c of cases) {
      for (const suffix of ["free", "busy"]) {
        // Every third one lists a tool, so the tools filter crosses both statuses and both work states.
        made.set(`${c.name}-${suffix}`, await listener(`${c.name}-${suffix}`, { ...c.profile, ...(i++ % 3 === 0 ? { tools: ["shell"] } : {}) }));
      }
    }
    const storedOpen = await listener("stored-open");
    const busyOnes = [...made].filter(([name]) => name.endsWith("-busy")).map(([, l]) => l);
    await work(w, "Busy", busyOnes);
    const legacy = await work(w, "Legacy", [storedOpen]);
    await setRequest(legacy.id, { status: "open" });
    for (const c of cases) for (const suffix of ["free", "busy"]) await seenAt(made.get(`${c.name}-${suffix}`)!, c.seen);
    await seenAt(storedOpen, ago(60_000));
    // Who holds active work is what the fixture made, known here independently of `workFor`.
    const holding = new Set(busyOnes.map((l) => l.id));
    const want = (l: Listener): ListenerStatus => listenerStatus(l.capabilities,
      l.participant.lastSeenAt === null ? null : new Date(l.participant.lastSeenAt), holding.has(l.participant.id), NOW);

    // The rule, pinned by hand once, on the unfiltered read.
    const all = await listListeners(db, w.reader, { limit: 1000 }, NOW);
    expect(Object.fromEntries(all.listeners.map((l) => [l.participant.name, l.status]))).toEqual({
      "at-twice-busy": "working", "at-twice-free": "idle", "default-at-busy": "working", "default-at-free": "idle",
      "default-past-busy": "offline", "default-past-free": "offline", "never-busy": "offline", "never-free": "offline",
      "past-twice-busy": "offline", "past-twice-free": "offline", "stored-open": "idle",
    });

    const filters: ListenerStatus[][] = [[], ["working"], ["idle"], ["offline"], ["working", "idle"],
      ["working", "offline"], ["idle", "offline"], ["working", "idle", "offline"]];
    const extras: ListenersQuery[] = [{}, { q: "busy" }, { tools: ["shell"] }];
    for (const extra of extras) {
      const base = await listListeners(db, w.reader, { ...extra, limit: 1000 }, NOW);
      const counts = { working: 0, idle: 0, offline: 0 };
      for (const l of base.listeners) counts[want(l)]++;
      for (const status of filters) {
        const page = await listListeners(db, w.reader, { ...extra, status, limit: 1000 }, NOW);
        const expected = base.listeners.filter((l) => status.length === 0 || status.includes(want(l)));
        expect({ extra, status, names: page.listeners.map((l) => l.participant.name),
          statuses: page.listeners.map((l) => l.status), matched: page.matched, counts: page.statusCounts })
          .toEqual({ extra, status, names: expected.map((l) => l.participant.name),
            statuses: expected.map(want), matched: expected.length, counts });
      }
    }
  });

  it("a stored non-numeric pollIntervalMs (string, object, null) reads as the default in SQL too", async () => {
    const w = await world();
    const values: [string, unknown][] = [["string", "5 min"], ["object", { ms: 300_000 }], ["null", null]];
    const made: { name: string; value: unknown; seen: Date }[] = [];
    for (const [kind, value] of values) {
      for (const [side, seen] of [["at", ago(2 * DEFAULT_POLL_INTERVAL_MS)], ["past", ago(2 * DEFAULT_POLL_INTERVAL_MS + 1)]] as const) {
        const name = `${kind}-${side}`;
        const l = await listener(name);
        // Written past validateProfile, which refuses these: a legacy row or a direct write.
        const [row] = await db.select({ c: participants.capabilities }).from(participants).where(eq(participants.id, l.id));
        await db.update(participants).set({ capabilities: { ...(row!.c as object), pollIntervalMs: value } }).where(eq(participants.id, l.id));
        await seenAt(l, seen);
        made.push({ name, value, seen });
      }
    }
    const rule = Object.fromEntries(made.map(({ name, value, seen }) => [name, listenerStatus(P({ pollIntervalMs: value }), seen, false, NOW)]));
    expect(rule).toEqual({ "string-at": "idle", "string-past": "offline", "object-at": "idle", "object-past": "offline", "null-at": "idle", "null-past": "offline" });
    const page = await listListeners(db, w.reader, { limit: 1000 }, NOW);
    expect([Object.fromEntries(page.listeners.map((l) => [l.participant.name, l.status])), page.statusCounts])
      .toEqual([rule, { working: 0, idle: 3, offline: 3 }]);
    const idle = await listListeners(db, w.reader, { status: ["idle"], limit: 1000 }, NOW);
    expect(idle.listeners.map((l) => l.participant.name).sort()).toEqual(["null-at", "object-at", "string-at"]);
  });

  it("statusCounts ignores the status filter and honours every other; the four facets honour it", async () => {
    const w = await world();
    const ada = await listener("ada", { tools: ["shell"], runtime: "node", models: [{ model: "opus-5", effort: "high" }] });
    const bo = await listener("bo", { tools: ["shell"], runtime: "deno", models: [{ model: "opus-5", effort: "high" }] });
    const cy = await listener("cy", { tools: ["git"], runtime: "node", models: [{ model: "sonnet-5", effort: "low" }] });
    await seenAt(ada, ago(60_000));
    await seenAt(bo, null);
    await seenAt(cy, null);
    const page = await listListeners(db, w.reader, { status: ["offline"], runtime: "node" }, NOW);
    expect(page.listeners.map((l) => l.participant.name)).toEqual(["cy"]);
    // Over runtime node, the status filter left out: ada idle, cy offline.
    expect(page.statusCounts).toEqual({ working: 0, idle: 1, offline: 1 });
    // Each facet over the other filters, the status filter included: the offline ones are bo and cy.
    expect(page.facets!.runtimes.values).toEqual([{ value: "deno", count: 1 }, { value: "node", count: 1 }]);
    expect(page.facets!.tools.values).toEqual([{ value: "git", count: 1 }]);
    expect(page.facets!.models.values.map((m) => [m.model, m.count])).toEqual([["sonnet-5", 1]]);
    expect(page.facets!.serves.values).toEqual([{ value: "anyone", count: 1 }, { value: "owner", count: 0 }, { value: "list", count: 0 }]);
  });

  it("statusCounts is present with facets false and with limit 0", async () => {
    const w = await world();
    await seenAt(await listener("ada"), ago(60_000));
    await seenAt(await listener("bo"), null);
    for (const q of [{ facets: false }, { limit: 0 }, { limit: 0, facets: false }] as ListenersQuery[]) {
      expect({ q, counts: (await listListeners(db, w.reader, q, NOW)).statusCounts })
        .toEqual({ q, counts: { working: 0, idle: 1, offline: 1 } });
    }
  });

  // A plan-shape guard, never a duration. The counts read each row's status three times over, one
  // `count(*) FILTER` per word; an inlined CTE copies the status CASE, and its work EXISTS, into each
  // of them, and on a real Lobby each copy became a per-row scan of `request_offers` (the
  // whole-branch review measured 1.1 s at 5,000 listeners). Materialised, the CASE runs once per row
  // and the plan holds exactly one work sub-plan. The count of sub-plans does not depend on the data,
  // so a small fixture is enough.
  it("the status counts compute each listener's status once: one work sub-plan, not one per word", async () => {
    const w = await world();
    const ada = await listener("ada");
    await work(w, "Busy", [ada]);
    await seenAt(ada, ago(60_000));
    const plan = await countsPlan(db, w.reader);
    expect(new Set([...plan.matchAll(/SubPlan (\d+)/g)].map((m) => m[1])).size).toBe(1);
  });

  // The partial index exists for the work lookup inside the status (spec §10, amended 2026-09-27):
  // with sequential scans priced out, the counts' work sub-plan must be able to reach it. It fails
  // if the index is dropped, or if the work predicate stops implying the index's `WHERE`.
  it("the status counts' work lookup can use request_offers_active_participant_idx", async () => {
    const w = await world();
    const ada = await listener("ada");
    const busy = await work(w, "Busy", [ada]);
    await seenAt(ada, ago(60_000));
    // 3,000 offers that were never accepted, by participants that are no listeners, so the primary
    // key (which Postgres can also scan by its second column) is the larger index by far, as it is
    // on a real Lobby, where the table keeps every offer ever made.
    await db.execute(sql`
      with p as (insert into participants (id, weave_id, name, kind, token)
                 select gen_random_uuid(), ${w.target.weave.id}, 'o' || g, 'agent', 'plan-test-offerer-' || g
                 from generate_series(1, 3000) g returning id)
      insert into request_offers (request_id, participant_id) select ${busy.id}, id from p`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`analyze request_offers`);
      await tx.execute(sql`set local enable_seqscan = off`);
      expect(await countsPlan(tx, w.reader)).toContain("request_offers_active_participant_idx");
    });
  });

  it("a status filter of [] is no filter; an unknown word, a non-array and four entries are validation", async () => {
    const w = await world();
    await seenAt(await listener("ada"), null);
    const none = await listListeners(db, w.reader, { status: [] }, NOW);
    expect([none.listeners.map((l) => l.participant.name), none.matched, none.total]).toEqual([["ada"], 1, 1]);
    // Duplicates mean the same as one.
    expect((await listListeners(db, w.reader, { status: ["offline", "offline"] }, NOW)).matched).toBe(1);
    for (const bad of [["busy"], "idle", ["idle", "idle", "offline", "working"], null, [1]]) {
      await expect(listListeners(db, w.reader, { status: bad } as unknown as ListenersQuery, NOW))
        .rejects.toMatchObject({ code: "validation", message: "status must be a list of working, idle or offline" });
    }
  });
});

describe("findAgents (spec 2026-09-27 §4.7)", () => {
  it("findAgents results carry status, currentWork and cadence", async () => {
    const w = await world();
    const busy = await listener("busy", { pollIntervalMs: 300_000 });
    const r = await work(w, "Review PR 14", [busy]);
    const history = [ago(900_000), ago(600_000), ago(300_000)];
    await db.update(participants).set({ lastSeenAt: history.at(-1)!, seenHistory: history }).where(eq(participants.id, busy.id));
    const [found] = await findAgents(db, w.reader, {}, NOW);
    expect(found).toMatchObject({
      status: "working",
      currentWork: { requestId: r.id, title: "Review PR 14", threadId: r.threadId, more: 0 },
      cadence: { typicalGapMs: 300_000, longestGapMs: 300_000, samples: 3 },
    });
  });
});

describe("a request's acceptances (spec 2026-09-27 §4.5)", () => {
  it("getRequest acceptances carry listenerStatus, including an offline one and one that completed this request while working on another", async () => {
    const w = await world();
    const gone = await listener("gone"), doubled = await listener("doubled"), fresh = await listener("fresh");
    const finished = await listener("finished");
    const r = await work(w, "Review PR 14", [gone, doubled, fresh, finished]);
    await work(w, "Review PR 15", [doubled]);
    await setOffer(r.id, doubled, { completedAt: NOW });              // done here, still working on PR 15
    await setOffer(r.id, finished, { completedAt: NOW });             // done here, and holds no other work
    await seenAt(gone, ago(2 * DEFAULT_POLL_INTERVAL_MS + 1));
    await seenAt(doubled, ago(60_000));
    await seenAt(fresh, ago(60_000));
    await seenAt(finished, ago(60_000));
    const req = await getRequest(db, w.reader, r.id, NOW);
    expect(req.acceptances.map((a) => [a.participantId, a.listenerStatus]))
      .toEqual([[gone.id, "offline"], [doubled.id, "working"], [fresh.id, "working"], [finished.id, "idle"]]);
  });
});
