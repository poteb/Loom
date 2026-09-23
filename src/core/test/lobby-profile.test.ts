import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { LoomError } from "../src/errors.js";
import { participants, weaves } from "../src/db/schema.js";
import { createWeave } from "../src/weaves.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { validateProfile, setCapabilities, findAgents, getMyLobbyParticipant } from "../src/lobby/profile.js";
import { createCore, type Core } from "../src/index.js";
import type { Db } from "../src/db/index.js";
import type { Profile } from "../src/lobby/matching.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

/** The code a call rejects with, or undefined when it is accepted. */
const codeOf = (fn: () => void): string | undefined => {
  try { fn(); return undefined; } catch (e) { return (e as LoomError).code; }
};

const chatgpt: Profile = {
  models: [{ model: "gpt-5.6-sol", effort: "high" }],
  tools: ["github"],
  runtime: "codex",
  spawnsSubagents: true,
  owner: "bob",
  serves: "owner",
};

describe("validateProfile", () => {
  it("reads null as no profile", () => {
    expect(validateProfile(null)).toBeNull();
  });

  it("reads the empty object as no profile", () => {
    expect(validateProfile({})).toBeNull();
  });

  it("passes a full profile through, trimmed", () => {
    expect(validateProfile({
      models: [{ model: "  gpt-5.6-sol ", effort: " high " }],
      tools: [" github "], runtime: " codex ", spawnsSubagents: true, owner: " bob ", serves: "owner",
    })).toEqual(chatgpt);
  });

  it("requires owner when any other key is present", () => {
    expect(codeOf(() => validateProfile({ runtime: "codex" }))).toBe("validation");
    expect(codeOf(() => validateProfile({ runtime: "codex", owner: "bob" }))).toBeUndefined();
  });

  it("accepts owner on its own", () => {
    expect(validateProfile({ owner: "bob" })).toEqual({ owner: "bob" });
  });

  it("accepts 0 to 20 models and rejects 21", () => {
    const model = (i: number) => ({ model: `model-${i}`, effort: "high" });
    expect(codeOf(() => validateProfile({ owner: "bob", models: [] }))).toBeUndefined();
    expect(codeOf(() => validateProfile({ owner: "bob", models: Array.from({ length: 20 }, (_, i) => model(i)) }))).toBeUndefined();
    expect(codeOf(() => validateProfile({ owner: "bob", models: Array.from({ length: 21 }, (_, i) => model(i)) }))).toBe("validation");
  });

  it("rejects a model name outside 1-100 characters", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", models: [{ model: "  ", effort: "high" }] }))).toBe("validation");
    expect(codeOf(() => validateProfile({ owner: "bob", models: [{ model: "m".repeat(101), effort: "high" }] }))).toBe("validation");
  });

  it("rejects an effort outside 1-32 characters", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", models: [{ model: "m", effort: "e".repeat(33) }] }))).toBe("validation");
  });

  it("requires an effort on every model", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", models: [{ model: "m" }] }))).toBe("validation");
  });

  it("accepts up to 50 tools and rejects 51", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", tools: Array.from({ length: 50 }, (_, i) => `t${i}`) }))).toBeUndefined();
    expect(codeOf(() => validateProfile({ owner: "bob", tools: Array.from({ length: 51 }, (_, i) => `t${i}`) }))).toBe("validation");
  });

  it("rejects a tool outside 1-64 characters", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", tools: ["  "] }))).toBe("validation");
    expect(codeOf(() => validateProfile({ owner: "bob", tools: ["t".repeat(65)] }))).toBe("validation");
  });

  it("rejects a runtime outside 1-64 characters", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", runtime: "  " }))).toBe("validation");
    expect(codeOf(() => validateProfile({ owner: "bob", runtime: "r".repeat(65) }))).toBe("validation");
  });

  it("rejects a non-boolean spawnsSubagents", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", spawnsSubagents: "yes" }))).toBe("validation");
  });

  it("rejects an owner outside 1-64 characters", () => {
    expect(codeOf(() => validateProfile({ owner: "  " }))).toBe("validation");
    expect(codeOf(() => validateProfile({ owner: "o".repeat(65) }))).toBe("validation");
  });

  it("accepts each shape of serves and rejects anything else", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", serves: "owner" }))).toBeUndefined();
    expect(codeOf(() => validateProfile({ owner: "bob", serves: "anyone" }))).toBeUndefined();
    expect(codeOf(() => validateProfile({ owner: "bob", serves: ["paw"] }))).toBeUndefined();
    expect(codeOf(() => validateProfile({ owner: "bob", serves: "everyone" }))).toBe("validation");
  });

  it("rejects a serves list outside 1-20 owners", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", serves: [] }))).toBe("validation");
    expect(codeOf(() => validateProfile({ owner: "bob", serves: Array.from({ length: 21 }, (_, i) => `o${i}`) }))).toBe("validation");
  });

  it("keeps an unknown key as given", () => {
    expect(validateProfile({ owner: "bob", region: "eu", limits: { rpm: 10 } }))
      .toEqual({ owner: "bob", region: "eu", limits: { rpm: 10 } });
  });

  it("rejects a profile longer than 4000 characters serialised", () => {
    // `{"owner":"bob","pad":""}` is 24 characters, so the padding decides the total exactly.
    const pad = (n: number) => ({ owner: "bob", pad: "x".repeat(n) });
    expect(JSON.stringify(validateProfile(pad(4000 - 24)))).toHaveLength(4000);
    expect(codeOf(() => validateProfile(pad(4001 - 24)))).toBe("validation");
  });

  it("pollIntervalMs is bounded", () => {
    expect(codeOf(() => validateProfile({ owner: "bob", pollIntervalMs: 59_999 }))).toBe("validation");
    expect(codeOf(() => validateProfile({ owner: "bob", pollIntervalMs: 86_400_001 }))).toBe("validation");
    expect(codeOf(() => validateProfile({ owner: "bob", pollIntervalMs: 1.5 }))).toBe("validation");
    expect(validateProfile({ owner: "bob", pollIntervalMs: 60_000 })).toEqual({ owner: "bob", pollIntervalMs: 60_000 });
    expect(validateProfile({ owner: "bob", pollIntervalMs: 86_400_000 })).toEqual({ owner: "bob", pollIntervalMs: 86_400_000 });
  });
});

/** The Lobby, an agent joined to it, and that agent's participant actor. */
async function lobbyWith(name: string, profile: Profile | null = null) {
  const { weaveId } = await ensureLobby(db);
  const j = await joinLobby(db, bus, { name, kind: "agent" });
  const actor = await resolveCredential(db, j.token);
  if (profile) await setCapabilities(db, bus, actor, profile);
  return { lobbyId: weaveId, join: j, actor };
}

describe("setCapabilities", () => {
  it("stores the profile on the caller's own Lobby participant", async () => {
    const { actor } = await lobbyWith("ChatGPT");
    const p = await setCapabilities(db, bus, actor, chatgpt);
    expect(p.capabilities).toEqual(chatgpt);
  });

  it("appends participant.capabilities_changed on the Lobby's General thread", async () => {
    const { lobbyId, join, actor } = await lobbyWith("ChatGPT");
    await setCapabilities(db, bus, actor, chatgpt);
    const evs = await readEvents(db, lobbyId, {});
    const last = evs.at(-1)!;
    expect(last.type).toBe("participant.capabilities_changed");
    expect(last.threadId).toBe(join.generalThreadId);
    expect(last.actor).toBe(join.participant.id);
    expect(last.payload).toEqual({ participantId: join.participant.id, capabilities: chatgpt });
  });

  it("clears the profile when given null", async () => {
    const { actor } = await lobbyWith("ChatGPT", chatgpt);
    const cleared = await setCapabilities(db, bus, actor, null);
    expect(cleared.capabilities).toBeNull();
  });

  it("refuses a participant of another Weave", async () => {
    await ensureLobby(db);
    const other = await createWeave(db, bus, { title: "Elsewhere", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const outsider = await resolveCredential(db, other.token);
    await expect(setCapabilities(db, bus, outsider, chatgpt)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects an invalid profile without touching the row", async () => {
    const { actor } = await lobbyWith("ChatGPT", chatgpt);
    await expect(setCapabilities(db, bus, actor, { runtime: "codex" })).rejects.toMatchObject({ code: "validation" });
    const [found] = await findAgents(db, actor, {});
    expect(found!.capabilities).toEqual(chatgpt);
  });
});

describe("getMyLobbyParticipant", () => {
  it("returns the caller's own participant with its profile", async () => {
    const { join, actor } = await lobbyWith("ChatGPT", chatgpt);
    const me = await getMyLobbyParticipant(db, actor);
    expect(me).toEqual({ ...join.participant, capabilities: chatgpt, lastSeenAt: expect.any(String) });
  });

  // The Actor carries the participant as it was when the credential resolved; a profile another
  // client set a second ago is on the row and not on that copy.
  it("reads the row rather than the actor's copy", async () => {
    const { join, actor } = await lobbyWith("ChatGPT", chatgpt);
    const secondClient = await resolveCredential(db, join.token);
    await setCapabilities(db, bus, secondClient, { owner: "ada" });
    expect((await getMyLobbyParticipant(db, actor)).capabilities).toEqual({ owner: "ada" });
  });

  it("answers null for a participant that has set no profile", async () => {
    const { actor } = await lobbyWith("Lurker");
    expect((await getMyLobbyParticipant(db, actor)).capabilities).toBeNull();
  });

  it("refuses the Lobby secret: a secret owns no participant row", async () => {
    const { lobbyId } = await lobbyWith("ChatGPT", chatgpt);
    const [w] = await db.select({ secret: weaves.secret }).from(weaves).where(eq(weaves.id, lobbyId));
    const reader = await resolveCredential(db, w!.secret);
    await expect(getMyLobbyParticipant(db, reader)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses an instance keeper: a keeper owns no profile", async () => {
    await lobbyWith("ChatGPT", chatgpt);
    await seedKeepers(db, [keeperToken("k")]);
    const keeper = await resolveCredential(db, keeperToken("k"));
    await expect(getMyLobbyParticipant(db, keeper)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a credential of another Weave", async () => {
    await lobbyWith("ChatGPT", chatgpt);
    const other = await createWeave(db, bus, { title: "Elsewhere", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const outsider = await resolveCredential(db, other.token);
    await expect(getMyLobbyParticipant(db, outsider)).rejects.toMatchObject({ code: "forbidden" });
  });

  // The credential resolved, so the actor is a participant — but the identity it names is gone.
  it("is invalid_token when the participant row has been deleted", async () => {
    const { join, actor } = await lobbyWith("ChatGPT", chatgpt);
    await db.delete(participants).where(eq(participants.id, join.participant.id));
    await expect(getMyLobbyParticipant(db, actor)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("works on the facade with an agent key that has joined", async () => {
    const core: Core = createCore(db);
    await core.seedKeepers([keeperToken("k")]);
    const { key } = await core.addAgent(await core.resolveCredential(keeperToken("k")), "ChatGPT");
    const agent = await core.resolveCredential(key);
    await core.ensureLobby();
    const joined = await core.joinLobby({ kind: "agent" }, agent);
    await core.setCapabilities(agent, chatgpt);
    const me = await core.getMyLobbyParticipant(agent);
    expect(me).toEqual({ ...joined.participant, capabilities: chatgpt, lastSeenAt: expect.any(String) });
  });

  it("refuses an agent key that has not joined the Lobby", async () => {
    const core: Core = createCore(db);
    await core.seedKeepers([keeperToken("k")]);
    const { key } = await core.addAgent(await core.resolveCredential(keeperToken("k")), "Stranger");
    await core.ensureLobby();
    await expect(core.getMyLobbyParticipant(await core.resolveCredential(key))).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("findAgents", () => {
  it("returns the Lobby participants that match, with their profiles", async () => {
    const { actor } = await lobbyWith("ChatGPT", chatgpt);
    const claude = await joinLobby(db, bus, { name: "Claude", kind: "agent" });
    await setCapabilities(db, bus, await resolveCredential(db, claude.token),
      { models: [{ model: "claude-fable-5-1", effort: "high" }], owner: "paw" });
    const found = await findAgents(db, actor, { models: [{ model: "gpt-5.6-sol" }] });
    expect(found.map((f) => f.participant.name)).toEqual(["ChatGPT"]);
    expect(found[0]!.capabilities).toEqual(chatgpt);
  });

  it("restricts to agents whose serves admits the owner filter", async () => {
    const { actor } = await lobbyWith("ChatGPT", chatgpt);           // serves: "owner", owner: "bob"
    const shared = await joinLobby(db, bus, { name: "Shared", kind: "agent" });
    await setCapabilities(db, bus, await resolveCredential(db, shared.token), { owner: "ops", serves: "anyone" });
    expect((await findAgents(db, actor, { owner: "paw" })).map((f) => f.participant.name)).toEqual(["Shared"]);
    expect((await findAgents(db, actor, { owner: "bob" })).map((f) => f.participant.name)).toEqual(["ChatGPT", "Shared"]);
  });

  it("excludes participants without a profile", async () => {
    const { actor } = await lobbyWith("ChatGPT", chatgpt);
    await joinLobby(db, bus, { name: "Lurker", kind: "human" });
    expect((await findAgents(db, actor, {})).map((f) => f.participant.name)).toEqual(["ChatGPT"]);
  });

  it("is readable with the Lobby secret", async () => {
    const { lobbyId } = await lobbyWith("ChatGPT", chatgpt);
    const [w] = await db.select({ secret: weaves.secret }).from(weaves).where(eq(weaves.id, lobbyId));
    const reader = await resolveCredential(db, w!.secret);
    expect((await findAgents(db, reader, {})).map((f) => f.participant.name)).toEqual(["ChatGPT"]);
  });

  it("refuses a credential of another Weave", async () => {
    await lobbyWith("ChatGPT", chatgpt);
    const other = await createWeave(db, bus, { title: "Elsewhere", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const outsider = await resolveCredential(db, other.token);
    await expect(findAgents(db, outsider, {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a filter with an unknown key", async () => {
    const { actor } = await lobbyWith("ChatGPT", chatgpt);
    await expect(findAgents(db, actor, { anyOf: [] } as never)).rejects.toMatchObject({ code: "validation" });
  });

  it("findAgents applies the liveness term when the filter asks maxResponseMs", async () => {
    const { actor } = await lobbyWith("Fresh", { ...chatgpt, pollIntervalMs: 300_000 });
    const stale = await joinLobby(db, bus, { name: "Stale", kind: "agent" });
    await setCapabilities(db, bus, await resolveCredential(db, stale.token), { ...chatgpt, pollIntervalMs: 300_000 });
    // Twenty minutes is more than twice a five-minute cadence: this one has stopped polling.
    await db.update(participants).set({ lastSeenAt: new Date(Date.now() - 20 * 60_000) }).where(eq(participants.id, stale.participant.id));
    expect((await findAgents(db, actor, { maxResponseMs: 600_000 })).map((f) => f.participant.name)).toEqual(["Fresh"]);
    expect((await findAgents(db, actor, {})).map((f) => f.participant.name)).toEqual(["Fresh", "Stale"]);
  });
});

describe("the registration flow on one agent key", () => {
  it("joins, sets a profile and finds agents with the same key", async () => {
    const core: Core = createCore(db);
    await core.seedKeepers([keeperToken("k")]);
    const keeper = await core.resolveCredential(keeperToken("k"));
    const { key } = await core.addAgent(keeper, "ChatGPT");
    const agent = await core.resolveCredential(key);
    await core.ensureLobby();

    const joined = await core.joinLobby({ kind: "agent" }, agent);
    expect(joined.participant.name).toBe("ChatGPT");
    const me = await core.setCapabilities(agent, chatgpt);
    expect(me.capabilities).toEqual(chatgpt);
    const found = await core.findAgents(agent, { tools: ["github"] });
    expect(found).toHaveLength(1);
    expect(found[0]!.participant.id).toBe(joined.participant.id);
    expect(found[0]!.capabilities).toEqual(chatgpt);
  });
});
