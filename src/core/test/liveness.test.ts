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

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); await seedKeepers(db, [keeperToken("k")]); });

const T0 = new Date("2026-09-23T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const keeper = () => resolveCredential(db, keeperToken("k"));
const seenOf = async (participantId: string): Promise<Date | null> =>
  (await db.select({ at: participants.lastSeenAt }).from(participants).where(eq(participants.id, participantId)))[0]!.at;
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
