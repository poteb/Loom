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
    expect(await historyOf(r.participant.id)).toEqual([T0]);
    await resolveCredential(db, r.token, at(10_001));
    const history = await historyOf(r.participant.id);
    expect([history, history!.at(-1)]).toEqual([[T0, at(10_001)], await seenOf(r.participant.id)]);
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
    for (let i = 0; i < 25; i++) await resolveCredential(db, r.token, at(i * 10_001));
    expect(await historyOf(r.participant.id)).toEqual(Array.from({ length: 20 }, (_, k) => at((k + 5) * 10_001)));
    expect(await seenOf(r.participant.id)).toEqual(at(24 * 10_001));
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
