import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave, getWeave } from "../src/weaves.js";
import { createThread, closeThread } from "../src/threads.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

describe("createThread", () => {
  it("any participant can create; event emitted in the new thread", async () => {
    const r = await createWeave(db, bus, input);
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const member = await resolveCredential(db, j.token);
    const t = await createThread(db, bus, member, r.weave.id, "Tests");
    expect(t.name).toBe("Tests");
    expect(t.isGeneral).toBe(false);
    expect(t.createdBy).toBe(j.participant.id);
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "thread.created", threadId: t.id, payload: { threadId: t.id, name: "Tests" } });
    expect((await getWeave(db, member, r.weave.id)).threads).toHaveLength(2);
  });
  it("secret-only and cross-weave credentials cannot create; validates name", async () => {
    const r = await createWeave(db, bus, input);
    const bySecret = await resolveCredential(db, r.secret);
    await expect(createThread(db, bus, bySecret, r.weave.id, "X")).rejects.toMatchObject({ code: "forbidden" });
    const me = await resolveCredential(db, r.token);
    await expect(createThread(db, bus, me, r.weave.id, "  ")).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(db, bus, me, r.weave.id, "x".repeat(101))).rejects.toMatchObject({ code: "validation" });
  });
  it("refused on archived weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(createThread(db, bus, me, r.weave.id, "X")).rejects.toMatchObject({ code: "weave_archived" });
  });
});

describe("closeThread", () => {
  it("weave keeper closes; member cannot; General cannot be closed; double close rejected", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const member = await resolveCredential(db, j.token);
    const t = await createThread(db, bus, me, r.weave.id, "Tests");
    await expect(closeThread(db, bus, member, t.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(closeThread(db, bus, me, r.generalThread.id)).rejects.toMatchObject({ code: "validation" });
    await closeThread(db, bus, me, t.id);
    const info = await getWeave(db, me, r.weave.id);
    expect(info.threads.find((x) => x.id === t.id)!.closedAt).not.toBeNull();
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "thread.closed", threadId: t.id });
    await expect(closeThread(db, bus, me, t.id)).rejects.toMatchObject({ code: "thread_closed" });
  });
  it("instance keeper can close any thread; unknown thread is 404", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const t = await createThread(db, bus, me, r.weave.id, "Tests");
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    await closeThread(db, bus, k, t.id);
    await expect(closeThread(db, bus, k, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ code: "thread_not_found" });
  });
});
