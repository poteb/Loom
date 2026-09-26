import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread, closeThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { markRead, markAllRead, readPositions } from "../src/reads.js";
import { createCore } from "../src/index.js";
import { weaves, readPositions as positionsTable } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); await seedKeepers(db, [keeperToken("k1")]); });

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

/**
 * Paw creates the Weave (1 thread.created, 2 participant.joined, 3 message), Bot joins (4), Paw
 * opens "PR 1" (5) and Bot posts in it twice (6, 7).
 */
async function setup() {
  const r = await createWeave(db, bus, { title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw = await resolveCredential(db, r.token);
  const b = await joinWeave(db, bus, r.secret, { name: "Bot", kind: "agent" });
  const bot = await resolveCredential(db, b.token);
  const t = await createThread(db, bus, paw, r.weave.id, "PR 1");
  await postMessage(db, bus, bot, t.id, "one");
  await postMessage(db, bus, bot, t.id, "two");
  return { r, paw, bot, t, general: r.generalThread.id };
}
const lastSeq = async (weaveId: string) =>
  (await db.select({ s: weaves.lastSeq }).from(weaves).where(eq(weaves.id, weaveId)))[0]!.s;
const idOf = (a: Awaited<ReturnType<typeof resolveCredential>>) => (a.kind === "participant" ? a.participant.id : "");

describe("read positions (spec 2026-09-26 §4)", () => {
  it("markRead stores a position and readPositions returns it", async () => {
    const { r, paw, t } = await setup();
    expect(await markRead(db, paw, t.id, 6)).toEqual({ threadId: t.id, seq: 6 });
    expect(await readPositions(db, paw, r.weave.id)).toEqual({ joinedSeq: 2, threads: { [t.id]: 6 } });
  });

  it("markRead never moves a position back", async () => {
    const { r, paw, bot, t } = await setup();
    for (const text of ["three", "four", "five"]) await postMessage(db, bus, bot, t.id, text);   // 8, 9, 10
    expect(await markRead(db, paw, t.id, 10)).toEqual({ threadId: t.id, seq: 10 });
    expect(await markRead(db, paw, t.id, 5)).toEqual({ threadId: t.id, seq: 10 });
    expect((await readPositions(db, paw, r.weave.id)).threads).toEqual({ [t.id]: 10 });
  });

  it("markRead refuses a seq past the Weave's newest event", async () => {
    const { r, paw, t } = await setup();
    const newest = await lastSeq(r.weave.id);
    await expect(markRead(db, paw, t.id, newest + 1))
      .rejects.toMatchObject({ code: "validation", message: "seq is past the Weave's newest event" });
    expect(await markRead(db, paw, t.id, newest)).toEqual({ threadId: t.id, seq: newest });
  });

  it("markRead refuses a negative or fractional seq", async () => {
    const { paw, t } = await setup();
    for (const bad of [-1, 1.5]) {
      await expect(markRead(db, paw, t.id, bad))
        .rejects.toMatchObject({ code: "validation", message: "seq must be a non-negative integer" });
    }
  });

  it("markRead on an unknown Thread is thread_not_found", async () => {
    const { paw } = await setup();
    await expect(markRead(db, paw, UNKNOWN, 1)).rejects.toMatchObject({ code: "thread_not_found" });
    await expect(markRead(db, paw, "not-a-uuid", 1)).rejects.toMatchObject({ code: "thread_not_found" });
  });

  it("a participant of another Weave, the instance keeper and a raw agent key are forbidden", async () => {
    const { r, t } = await setup();
    const o = await createWeave(db, bus, { title: "Other", opener: "", creator: { name: "Eve", kind: "human" } });
    const other = await resolveCredential(db, o.token);
    const keeper = await resolveCredential(db, keeperToken("k1"));
    const { key } = await addAgent(db, keeper, "Reader");
    const agent = await resolveCredential(db, key);
    // The agent has a participant in this Weave, so what is refused is the key itself, unmapped.
    await joinWeave(db, bus, r.secret, { kind: "agent" }, agent);
    for (const who of [other, keeper, agent]) {
      await expect(markRead(db, who, t.id, 1)).rejects.toMatchObject({ code: "forbidden" });
      await expect(markAllRead(db, who, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(readPositions(db, who, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("markRead, markAllRead and readPositions all work in an archived Weave", async () => {
    const { r, paw, t, general } = await setup();
    await markRead(db, paw, t.id, 6);
    await archiveWeave(db, bus, paw, r.weave.id);                                         // 8
    // A read position is not a change to the Weave's content (Paw, 2026-09-26).
    expect(await markRead(db, paw, t.id, 7)).toEqual({ threadId: t.id, seq: 7 });
    const newest = await lastSeq(r.weave.id);
    expect(await markAllRead(db, paw, r.weave.id)).toEqual({ seq: newest, threads: 2 });
    expect(await readPositions(db, paw, r.weave.id)).toEqual({ joinedSeq: 2, threads: { [t.id]: newest, [general]: newest } });
  });

  it("markRead accepts a closed Thread", async () => {
    const { paw, t } = await setup();
    await closeThread(db, bus, paw, t.id);
    expect(await markRead(db, paw, t.id, 7)).toEqual({ threadId: t.id, seq: 7 });
  });

  it("markAllRead sets every Thread of the Weave, open and closed, to last_seq and never lowers one", async () => {
    const { r, paw, t, general } = await setup();
    const closed = await createThread(db, bus, paw, r.weave.id, "Old");                 // 8
    await closeThread(db, bus, paw, closed.id);                                          // 9
    const newest = await lastSeq(r.weave.id);
    // A position ahead of the sample stands for a mark that landed after markAllRead read last_seq.
    await db.insert(positionsTable).values({ participantId: idOf(paw), threadId: t.id, seq: newest + 5 });
    expect(await markAllRead(db, paw, r.weave.id)).toEqual({ seq: newest, threads: 3 });
    expect((await readPositions(db, paw, r.weave.id)).threads)
      .toEqual({ [general]: newest, [t.id]: newest + 5, [closed.id]: newest });
  });

  it("readPositions gives joinedSeq as the seq of the actor's own participant.joined, and only the actor's own positions", async () => {
    const { r, paw, bot, t } = await setup();
    await markRead(db, paw, t.id, 6);
    expect(await readPositions(db, bot, r.weave.id)).toEqual({ joinedSeq: 4, threads: {} });
    expect((await readPositions(db, paw, r.weave.id)).joinedSeq).toBe(2);
  });

  it("markRead writes no event", async () => {
    const { r, paw, t } = await setup();
    const seqBefore = await lastSeq(r.weave.id);
    const countBefore = (await readEvents(db, r.weave.id, {})).length;
    await markRead(db, paw, t.id, 6);
    await markAllRead(db, paw, r.weave.id);
    expect(await lastSeq(r.weave.id)).toBe(seqBefore);
    expect((await readEvents(db, r.weave.id, {})).length).toBe(countBefore);
  });

  it("positions are per participant", async () => {
    const { r, paw, bot, t } = await setup();
    await markRead(db, paw, t.id, 5);
    await markRead(db, bot, t.id, 7);
    expect((await readPositions(db, paw, r.weave.id)).threads).toEqual({ [t.id]: 5 });
    expect((await readPositions(db, bot, r.weave.id)).threads).toEqual({ [t.id]: 7 });
  });

  it("the facade maps an agent key through the Weave, and answers weave_not_found before that", async () => {
    const { r, t } = await setup();
    const core = createCore(db);
    const keeper = await resolveCredential(db, keeperToken("k1"));
    const { key } = await addAgent(db, keeper, "Reader");
    const agent = await resolveCredential(db, key);
    await joinWeave(db, bus, r.secret, { kind: "agent" }, agent);
    expect(await core.markRead(agent, t.id, 5)).toEqual({ threadId: t.id, seq: 5 });
    expect((await core.readPositions(agent, r.weave.id)).threads).toEqual({ [t.id]: 5 });
    await expect(core.readPositions(agent, UNKNOWN)).rejects.toMatchObject({ code: "weave_not_found" });
    await expect(core.markAllRead(agent, "not-a-uuid")).rejects.toMatchObject({ code: "weave_not_found" });
  });
});
