import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { addAgent, listAgents, revokeAgent, hashKey } from "../src/agents.js";
import { resolveCredential, resolveInWeave } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { createWeave } from "../src/weaves.js";
import { EventBus } from "../src/bus.js";
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
