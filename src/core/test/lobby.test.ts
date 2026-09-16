import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { settings, threads, weaves, participants } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { getSettings } from "../src/settings.js";
import { archiveWeave } from "../src/weaves.js";
import { ensureLobby, getLobby, joinLobby } from "../src/lobby/lobby.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const lobbyCount = async (title: string) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(weaves).where(eq(weaves.title, title)))[0]!.n;

describe("ensureLobby", () => {
  it("creates the Lobby with a General thread, no participant and one thread.created", async () => {
    const { weaveId, created } = await ensureLobby(db);
    expect(created).toBe(true);
    const [w] = await db.select().from(weaves).where(eq(weaves.id, weaveId));
    expect(w!.title).toBe("Lobby");
    expect(w!.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ts = await db.select().from(threads).where(eq(threads.weaveId, weaveId));
    expect(ts.map((t) => [t.name, t.isGeneral, t.createdBy])).toEqual([["General", true, "system"]]);
    expect(await db.select().from(participants).where(eq(participants.weaveId, weaveId))).toEqual([]);
    const evs = await readEvents(db, weaveId, {});
    expect(evs.map((e) => e.type)).toEqual(["thread.created"]);
    expect(evs[0]!.actor).toBe("system");
  });

  it("records the pointer so a second call is a lookup", async () => {
    const first = await ensureLobby(db);
    const second = await ensureLobby(db);
    expect(second).toEqual({ weaveId: first.weaveId, created: false });
    expect(await lobbyCount("Lobby")).toBe(1);
  });

  it("takes the title from settings.lobbyTitle", async () => {
    await getSettings(db);                                    // creates the singleton row
    await db.update(settings).set({ lobbyTitle: "Foyer" }).where(eq(settings.id, 1));
    const { weaveId } = await ensureLobby(db);
    expect(await getLobby(db)).toEqual({ weaveId, title: "Foyer" });
  });

  it("creates exactly one Lobby under concurrent bootstrap", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureLobby(db)));
    expect(new Set(results.map((r) => r.weaveId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await lobbyCount("Lobby")).toBe(1);
  });

  it("rolls the whole creation back when it cannot finish", async () => {
    await expect(ensureLobby(db, { afterCreate: async () => { throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(await lobbyCount("Lobby")).toBe(0);
    const [row] = await db.select().from(settings).where(eq(settings.id, 1));
    expect(row!.lobbyWeaveId).toBeNull();
    expect((await ensureLobby(db)).created).toBe(true);
  });
});

describe("getLobby", () => {
  it("returns the Lobby id and its current title", async () => {
    const { weaveId } = await ensureLobby(db);
    await db.update(weaves).set({ title: "Renamed" }).where(eq(weaves.id, weaveId));
    expect(await getLobby(db)).toEqual({ weaveId, title: "Renamed" });
  });

  it("reports weave_not_found before the Lobby exists", async () => {
    await expect(getLobby(db)).rejects.toMatchObject({ code: "weave_not_found" });
  });
});

describe("joinLobby", () => {
  it("joins without a secret", async () => {
    const { weaveId } = await ensureLobby(db);
    const j = await joinLobby(db, bus, { name: "Paw", kind: "human" });
    expect(j.weaveId).toBe(weaveId);
    expect(j.participant.name).toBe("Paw");
    expect(j.participant.capabilities).toBeNull();
  });

  it("requires a name from a caller without an agent key", async () => {
    await ensureLobby(db);
    await expect(joinLobby(db, bus, { kind: "human" })).rejects.toMatchObject({ code: "validation" });
  });

  it("lets an agent key join under its agent name", async () => {
    await ensureLobby(db);
    await seedKeepers(db, [keeperToken("k")]);
    const keeper = await resolveCredential(db, keeperToken("k"));
    const { key } = await addAgent(db, keeper, "ChatGPT");
    const agent = await resolveCredential(db, key);
    const j = await joinLobby(db, bus, { kind: "agent" }, agent);
    expect(j.participant.name).toBe("ChatGPT");
  });

  it("is idempotent for the same agent key", async () => {
    await ensureLobby(db);
    await seedKeepers(db, [keeperToken("k")]);
    const keeper = await resolveCredential(db, keeperToken("k"));
    const { key } = await addAgent(db, keeper, "ChatGPT");
    const agent = await resolveCredential(db, key);
    const first = await joinLobby(db, bus, { kind: "agent" }, agent);
    const again = await joinLobby(db, bus, { kind: "agent" }, agent);
    expect(again.alreadyJoined).toBe(true);
    expect(again.participant.id).toBe(first.participant.id);
  });
});

describe("archiveWeave", () => {
  it("refuses to archive the Lobby", async () => {
    const { weaveId } = await ensureLobby(db);
    await seedKeepers(db, [keeperToken("k")]);
    const keeper = await resolveCredential(db, keeperToken("k"));
    await expect(archiveWeave(db, bus, keeper, weaveId)).rejects.toMatchObject({ code: "forbidden" });
    const [w] = await db.select().from(weaves).where(eq(weaves.id, weaveId));
    expect(w!.archivedAt).toBeNull();
  });
});
