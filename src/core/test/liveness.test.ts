import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, weaves } from "../src/db/schema.js";
import { resolveCredential, resolveInWeave } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { createWeave, joinWeave, getWeave } from "../src/weaves.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities, findAgents } from "../src/lobby/profile.js";
import type { Db } from "../src/db/index.js";
import { createCore } from "../src/index.js";
import { cadenceOf } from "../src/lobby/status.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); await seedKeepers(db, [keeperToken("k")]); });

const T0 = new Date("2026-09-23T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const keeper = () => resolveCredential(db, keeperToken("k"));
const seenOf = async (participantId: string): Promise<Date | null> =>
  (await db.select({ at: participants.lastSeenAt }).from(participants).where(eq(participants.id, participantId)))[0]!.at;
const historyOf = async (participantId: string): Promise<Date[] | null> =>
  (await db.select({ h: participants.seenHistory }).from(participants).where(eq(participants.id, participantId)))[0]!.h;
const newWeave = () => createWeave(db, bus, { title: "T", opener: "", creator: { name: "Paw", kind: "human" } });

describe("liveness", () => {
  it("an agent key stamps its Lobby participant", async () => {
    await ensureLobby(db);
    const { key } = await addAgent(db, await keeper(), "ChatGPT");
    // Resolved once, before either join: a resolve after the Lobby join would already stamp it with
    // the real clock, and the throttle would then keep T0 out.
    const agent = await resolveCredential(db, key);
    const inLobby = await joinLobby(db, bus, { kind: "agent" }, agent);
    const elsewhere = await newWeave();
    const inWeave = await joinWeave(db, bus, elsewhere.secret, { kind: "agent" }, agent);
    expect(await seenOf(inLobby.participant.id)).toBeNull();
    await resolveCredential(db, key, T0);
    expect(await seenOf(inLobby.participant.id)).toEqual(T0);
    // The key alone says nothing about another Weave: resolveInWeave is what stamps there.
    expect(await seenOf(inWeave.participant.id)).toBeNull();
  });

  it("resolveInWeave stamps the agent's participant in that Weave", async () => {
    const r = await newWeave();
    const { key } = await addAgent(db, await keeper(), "Bot");
    const agent = await resolveCredential(db, key);
    const j = await joinWeave(db, bus, r.secret, { kind: "agent" }, agent);
    expect(await seenOf(j.participant.id)).toBeNull();
    await resolveInWeave(db, agent, r.weave.id);
    expect(await seenOf(j.participant.id)).not.toBeNull();
  });

  it("a participant token stamps that participant", async () => {
    const r = await newWeave();
    expect(await seenOf(r.participant.id)).toBeNull();
    await resolveCredential(db, r.token, T0);
    expect(await seenOf(r.participant.id)).toEqual(T0);
  });

  it("a Weave secret and an instance keeper token stamp nothing", async () => {
    const r = await newWeave();
    await resolveCredential(db, r.secret, T0);
    await resolveCredential(db, keeperToken("k"), T0);
    const rows = await db.select({ at: participants.lastSeenAt }).from(participants);
    expect(rows.map((p) => p.at)).toEqual([null]);
  });

  it("a stamp appends no event", async () => {
    const r = await newWeave();
    const lastSeq = async () => (await db.select({ n: weaves.lastSeq }).from(weaves).where(eq(weaves.id, r.weave.id)))[0]!.n;
    const before = await lastSeq();
    // Eleven seconds apart, so every one of the hundred really writes.
    for (let i = 0; i < 100; i++) await resolveCredential(db, r.token, at(i * 11_000));
    expect(await seenOf(r.participant.id)).toEqual(at(99 * 11_000));
    expect(await lastSeq()).toBe(before);
  });

  it("two resolves within 10 seconds write once", async () => {
    const r = await newWeave();
    await resolveCredential(db, r.token, T0);
    await resolveCredential(db, r.token, at(9_999));
    expect(await seenOf(r.participant.id)).toEqual(T0);
    await resolveCredential(db, r.token, at(10_001));
    expect(await seenOf(r.participant.id)).toEqual(at(10_001));
  });

  it("a resolve exactly 10 000 ms after the last stamp does not write", async () => {
    const r = await newWeave();
    await resolveCredential(db, r.token, T0);
    await resolveCredential(db, r.token, at(10_000));
    expect(await seenOf(r.participant.id)).toEqual(T0);
  });

  it("lastSeenAt is on PublicParticipant: getWeave and findAgents return it", async () => {
    const { weaveId: lobbyId } = await ensureLobby(db);
    const j = await joinLobby(db, bus, { name: "Listener", kind: "agent" });
    const actor = await resolveCredential(db, j.token, T0);
    await setCapabilities(db, bus, actor, { owner: "paw" });
    const info = await getWeave(db, actor, lobbyId);
    expect(info.participants.find((p) => p.id === j.participant.id)!.lastSeenAt).toBe(T0.toISOString());
    const [found] = await findAgents(db, actor, {});
    expect(found!.participant.lastSeenAt).toBe(T0.toISOString());
  });
});

describe("the check-in history (spec 2026-09-27 §4.1)", () => {
  it("a check-in appends to seen_history in the same write as last_seen_at, and a throttled stamp appends nothing", async () => {
    const r = await newWeave();
    expect(await historyOf(r.participant.id)).toBeNull();
    await resolveCredential(db, r.token, T0);
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([T0, [T0]]);
    await resolveCredential(db, r.token, at(9_999));
    await resolveCredential(db, r.token, at(10_000));
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([T0, [T0]]);
    await resolveCredential(db, r.token, at(60_000));
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([at(60_000), [T0, at(60_000)]]);
  });

  it("stamps less than 60 s after the last check-in move last_seen_at and append nothing: one poll run counts once", async () => {
    const r = await newWeave();
    await resolveCredential(db, r.token, T0);
    for (const ms of [10_001, 25_000, 40_000, 59_999]) await resolveCredential(db, r.token, at(ms));
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([at(59_999), [T0]]);
  });

  it("a stamp exactly 60 000 ms after the last check-in appends, and so does any later one", async () => {
    const r = await newWeave();
    await resolveCredential(db, r.token, T0);
    // A stamp between them moves last_seen_at only; the 60 s are counted from the history's last entry.
    await resolveCredential(db, r.token, at(30_000));
    await resolveCredential(db, r.token, at(60_000));
    expect(await historyOf(r.participant.id)).toEqual([T0, at(60_000)]);
    await resolveCredential(db, r.token, at(119_999));
    expect(await historyOf(r.participant.id)).toEqual([T0, at(60_000)]);
    await resolveCredential(db, r.token, at(185_000));
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([at(185_000), [T0, at(60_000), at(185_000)]]);
  });

  it("the throttle still comes first: a stamp it skips appends nothing, even 60 s after the last check-in", async () => {
    const r = await newWeave();
    await resolveCredential(db, r.token, T0);
    await resolveCredential(db, r.token, at(55_000));
    await resolveCredential(db, r.token, at(62_000));
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([at(55_000), [T0]]);
    await resolveCredential(db, r.token, at(65_001));
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([at(65_001), [T0, at(65_001)]]);
  });

  it("runs of two or three calls every five minutes give a cadence of about five minutes", async () => {
    const r = await newWeave();
    // Smoke test 9's pattern: each poll run reads the Lobby inbox and then a Weave's, seconds apart
    // (4 s is throttled, 11 s and 12 s stamp). Runs start 300 000 ms apart, plus up to 4 s of jitter.
    const starts = Array.from({ length: 8 }, (_, k) => k * 300_000 + (k % 3) * 2_000);
    for (const [k, s] of starts.entries()) {
      for (const offset of k % 2 === 0 ? [0, 4_000, 12_000] : [0, 11_000]) await resolveCredential(db, r.token, at(s + offset));
    }
    expect(await historyOf(r.participant.id)).toEqual(starts.map(at));
    expect(await seenOf(r.participant.id)).toEqual(at(starts.at(-1)! + 11_000));
    // Gaps of 302 000 ms five times and 296 000 twice: the median and the longest are both 302 000.
    expect(cadenceOf(await historyOf(r.participant.id))).toEqual({ typicalGapMs: 302_000, longestGapMs: 302_000, samples: 8 });
  });

  it("a row checked in before the history existed starts it with the next check-in, nothing backfilled", async () => {
    const r = await newWeave();
    // The post-deploy state: last_seen_at from before migration 0007, seen_history still null.
    await db.update(participants).set({ lastSeenAt: T0 }).where(eq(participants.id, r.participant.id));
    expect(await historyOf(r.participant.id)).toBeNull();
    await resolveCredential(db, r.token, at(20_000));
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([at(20_000), [at(20_000)]]);
  });

  it("seen_history keeps the last 20, oldest first", async () => {
    const r = await newWeave();
    // 60 000 ms apart, the least gap that appends, so every one of the 25 is a check-in.
    for (let i = 0; i < 25; i++) await resolveCredential(db, r.token, at(i * 60_000));
    expect(await historyOf(r.participant.id)).toEqual(Array.from({ length: 20 }, (_, k) => at((k + 5) * 60_000)));
    expect(await seenOf(r.participant.id)).toEqual(at(24 * 60_000));
  });

  it("an agent-key call in another Weave checks in the agent's Lobby participant", async () => {
    await ensureLobby(db);
    const { key } = await addAgent(db, await keeper(), "ChatGPT");
    // Resolved before either join, so nothing is stamped until the call under test.
    const agent = await resolveCredential(db, key);
    const inLobby = await joinLobby(db, bus, { kind: "agent" }, agent);
    const elsewhere = await newWeave();
    const inWeave = await joinWeave(db, bus, elsewhere.secret, { kind: "agent" }, agent);
    const calling = await resolveCredential(db, key, T0);
    await createCore(db).readEvents(calling, elsewhere.weave.id, {});
    expect([await seenOf(inLobby.participant.id), await historyOf(inLobby.participant.id)]).toEqual([T0, [T0]]);
    // The call really reached the other Weave: resolveInWeave stamped the participant there too.
    expect(await historyOf(inWeave.participant.id)).toHaveLength(1);
  });

  it("a participant token of another Weave does not check in the Lobby participant", async () => {
    await ensureLobby(db);
    const { key } = await addAgent(db, await keeper(), "ChatGPT");
    const agent = await resolveCredential(db, key);
    const inLobby = await joinLobby(db, bus, { kind: "agent" }, agent);
    const elsewhere = await newWeave();
    // Joined with the key, so this participant row carries the agent's agent_id (spec §4.1's choice).
    const inWeave = await joinWeave(db, bus, elsewhere.secret, { kind: "agent" }, agent);
    await resolveCredential(db, inWeave.token, T0);
    expect([await seenOf(inLobby.participant.id), await historyOf(inLobby.participant.id)]).toEqual([null, null]);
    expect(await historyOf(inWeave.participant.id)).toEqual([T0]);
  });

  it("PublicParticipant carries no seen history", async () => {
    const { weaveId: lobbyId } = await ensureLobby(db);
    const j = await joinLobby(db, bus, { name: "Listener", kind: "agent" });
    const actor = await resolveCredential(db, j.token, T0);
    await setCapabilities(db, bus, actor, { owner: "paw" });
    const mine = (await getWeave(db, actor, lobbyId)).participants.find((p) => p.id === j.participant.id)!;
    expect(Object.keys(mine).sort()).toEqual(["agentId", "capabilities", "id", "joinedAt", "kind", "lastSeenAt", "name", "role", "weaveId"]);
  });
});
