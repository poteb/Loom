import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { addAgent, listAgents, revokeAgent, hashKey } from "../src/agents.js";
import {
  resolveCredential, resolveInWeave, participantForAgent,
  actorId, assertCanRead, assertParticipantOf, assertIsKeeperOf, assertStillKeeperOf,
} from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { createWeave, joinWeave, getWeave } from "../src/weaves.js";
import { readEvents } from "../src/events.js";
import { createCore } from "../src/index.js";
import { EventBus } from "../src/bus.js";
import { participants } from "../src/db/schema.js";
import { newId, newSecret } from "../src/ids.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db;
beforeEach(async () => { db = await freshDb(); await seedKeepers(db, [keeperToken("k1")]); });
const keeper = () => resolveCredential(db, keeperToken("k1"));

describe("agents", () => {
  it("instance keeper mints a key shown once; only its hash is stored; the key resolves to an agent actor", async () => {
    const { agent, key } = await addAgent(db, await keeper(), "ChatGPT");
    expect(key).toHaveLength(43);
    expect(agent).toMatchObject({ name: "ChatGPT", revokedAt: null });
    const listed = await listAgents(db, await keeper());
    expect(listed).toEqual([agent]);
    expect(JSON.stringify(listed)).not.toContain(key);
    const actor = await resolveCredential(db, key);
    expect(actor).toEqual({ kind: "agent", agent });
    expect(hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("non-keepers cannot mint, list or revoke", async () => {
    const r = await createWeave(db, new EventBus(), { title: "T", opener: "", creator: { name: "P", kind: "human" } });
    const p = await resolveCredential(db, r.token);
    await expect(addAgent(db, p, "X")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listAgents(db, p)).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeAgent(db, p, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("validates the name like a participant name", async () => {
    await expect(addAgent(db, await keeper(), "bad name!")).rejects.toMatchObject({ code: "validation" });
    await expect(addAgent(db, await keeper(), "")).rejects.toMatchObject({ code: "validation" });
  });
  it("a revoked key no longer resolves; the agent stays listed with revokedAt; revoking twice or an unknown id is a validation error", async () => {
    const { agent, key } = await addAgent(db, await keeper(), "Bot");
    await revokeAgent(db, await keeper(), agent.id);
    await expect(resolveCredential(db, key)).rejects.toMatchObject({ code: "invalid_token" });
    const [listed] = await listAgents(db, await keeper());
    expect(listed!.revokedAt).not.toBeNull();
    await expect(revokeAgent(db, await keeper(), agent.id)).rejects.toMatchObject({ code: "validation" });
    await expect(revokeAgent(db, await keeper(), "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "validation" });
  });
  it("resolveInWeave: an agent without a participant in the Weave is forbidden; other actors pass through", async () => {
    const r = await createWeave(db, new EventBus(), { title: "T", opener: "", creator: { name: "P", kind: "human" } });
    const { key } = await addAgent(db, await keeper(), "Bot");
    const agent = await resolveCredential(db, key);
    await expect(resolveInWeave(db, agent, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
    const p = await resolveCredential(db, r.token);
    expect(await resolveInWeave(db, p, r.weave.id)).toBe(p);
  });
});

describe("agent actor guards and mapping", () => {
  const newWeave = () => createWeave(db, new EventBus(), { title: "T", opener: "", creator: { name: "P", kind: "human" } });
  const newAgentActor = async () => {
    const { agent, key } = await addAgent(db, await keeper(), "Bot");
    return { agent, actor: await resolveCredential(db, key) };
  };

  it("a raw agent actor is rejected by every assert helper and by actorId", async () => {
    const r = await newWeave();
    const { actor } = await newAgentActor();
    expect(() => actorId(actor)).toThrow("Join the Weave first");
    expect(() => actorId(actor)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => assertCanRead(actor, r.weave.id)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => assertParticipantOf(actor, r.weave.id)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => assertIsKeeperOf(actor, r.weave.id)).toThrow(expect.objectContaining({ code: "forbidden" }));
    await expect(db.transaction((tx) => assertStillKeeperOf(tx, actor, r.weave.id)))
      .rejects.toMatchObject({ code: "forbidden", message: "Join the Weave first" });
  });

  it("resolveInWeave passes keeper and weave-secret actors through unchanged", async () => {
    const r = await newWeave();
    const k = await keeper();
    expect(await resolveInWeave(db, k, r.weave.id)).toBe(k);
    const s = await resolveCredential(db, r.secret);
    expect(s.kind).toBe("secret");
    expect(await resolveInWeave(db, s, r.weave.id)).toBe(s);
  });

  it("an agent that owns a participant resolves to it; participantForAgent finds it only in that Weave", async () => {
    const r = await newWeave();
    const other = await newWeave();
    const { agent, actor } = await newAgentActor();
    const participantId = newId();
    await db.insert(participants).values({
      id: participantId, weaveId: r.weave.id, name: "Bot", kind: "agent", role: "member",
      token: newSecret(), agentId: agent.id,
    });

    const found = await participantForAgent(db, agent.id, r.weave.id);
    expect(found).toMatchObject({ id: participantId, weaveId: r.weave.id, name: "Bot", kind: "agent", role: "member", agentId: agent.id });
    expect(await participantForAgent(db, agent.id, other.weave.id)).toBeUndefined();

    const resolved = await resolveInWeave(db, actor, r.weave.id);
    expect(resolved).toEqual({ kind: "participant", participant: found });
    expect(resolved.kind === "participant" && resolved.participant.id).toBe(participantId);
  });
});

describe("agents inside Weaves", () => {
  it("join links the participant to the agent; a second join returns the same identity without an event", async () => {
    const r = await createWeave(db, new EventBus(), { title: "T", opener: "", creator: { name: "P", kind: "human" } });
    const { key } = await addAgent(db, await keeper(), "ChatGPT");
    const agent = await resolveCredential(db, key);
    const bus = new EventBus();
    const j1 = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" }, agent);
    expect(j1.participant).toMatchObject({ name: "ChatGPT", kind: "agent", agentId: (agent as { agent: { id: string } }).agent.id });
    const before = (await readEvents(db, r.weave.id, {})).length;
    const j2 = await joinWeave(db, bus, r.secret, { name: "Whatever", kind: "agent" }, agent);
    expect(j2).toMatchObject({ alreadyJoined: true, participant: { id: j1.participant.id }, token: j1.token });
    expect((await readEvents(db, r.weave.id, {})).length).toBe(before);
    const info = await getWeave(db, await resolveCredential(db, r.token), r.weave.id);
    expect(info.participants.filter((p) => p.agentId !== null)).toHaveLength(1);
  });
  it("through the facade an agent key acts as its participant: read, post, create thread — and cannot act where it has not joined", async () => {
    const core = createCore(db);
    const r = await core.createWeave({ title: "T", opener: "", creator: { name: "P", kind: "human" } });
    const other = await core.createWeave({ title: "Other", opener: "", creator: { name: "Q", kind: "human" } });
    const { key } = await core.addAgent(await keeper(), "Bot");
    const agent = await core.resolveCredential(key);
    await expect(core.readEvents(agent, r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
    await core.joinWeave(r.secret, { name: "Bot", kind: "agent" }, agent);
    expect((await core.readEvents(agent, r.weave.id, {})).length).toBeGreaterThan(0);
    const msg = await core.postMessage(agent, r.generalThread.id, "hello from the key");
    expect(msg.type).toBe("message");
    const t = await core.createThread(agent, r.weave.id, "By bot", "https://e.com");
    expect(t.url).toBe("https://e.com");
    await expect(core.readEvents(agent, other.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(core.readSettings(agent)).rejects.toMatchObject({ code: "forbidden" });  // never an instance keeper
  });
  it("create_weave with an agent key links the creator (Weave keeper) so the key alone can read and write; restricted creation still refuses it", async () => {
    const core = createCore(db);
    const { key } = await core.addAgent(await keeper(), "Bot");
    const agent = await core.resolveCredential(key);
    const r = await core.createWeave({ title: "Mine", opener: "start", creator: { name: "Bot", kind: "agent" } }, agent);
    expect(r.participant).toMatchObject({ role: "keeper", agentId: (agent as { agent: { id: string } }).agent.id });
    await core.postMessage(agent, r.generalThread.id, "written with the key only");
    expect((await core.getWeave(agent, r.weave.id)).weave.title).toBe("Mine");
    await core.updateSettings(await keeper(), { openWeaveCreation: false });
    await expect(core.createWeave({ title: "Nope", opener: "", creator: { name: "Bot", kind: "agent" } }, agent)).rejects.toMatchObject({ code: "forbidden" });
    const byKeeper = await core.createWeave({ title: "Ok", opener: "", creator: { name: "K", kind: "human" } }, await keeper());
    expect(byKeeper.participant.agentId).toBeNull();
  });
});
