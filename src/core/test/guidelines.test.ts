import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { DEFAULT_INSTANCE_GUIDELINES } from "../src/guidelines-default.js";
import { MAX_GUIDELINES_LENGTH, validateGuidelines, guidelinesFor, getInstanceGuidelines, setWeaveGuidelines } from "../src/guidelines.js";
import { EventBus } from "../src/bus.js";
import { archiveWeave, createWeave, getWeave, joinWeave } from "../src/weaves.js";
import { setRole } from "../src/participants.js";
import { createThread } from "../src/threads.js";
import { threads } from "../src/db/schema.js";
import { addAgent } from "../src/agents.js";
import { readEvents } from "../src/events.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { seedKeepers } from "../src/keepers.js";
import { resolveCredential } from "../src/actors.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("validateGuidelines", () => {
  it("trims and accepts up to the limit", () => {
    expect(validateGuidelines("  hi  ")).toBe("hi");
    expect(validateGuidelines("x".repeat(MAX_GUIDELINES_LENGTH))).toHaveLength(4000);
  });
  it("rejects one character over the limit with validation", () => {
    expect(() => validateGuidelines("x".repeat(4001))).toThrow(expect.objectContaining({ code: "validation" }));
  });
  it("whitespace-only clears", () => {
    expect(validateGuidelines("  \n\t ")).toBe("");
  });
});

describe("guidelinesFor", () => {
  it("composes both layers under fixed headings, joined by a blank line", () => {
    expect(guidelinesFor("be kind", { guidelines: "one PR per Thread" }))
      .toBe("## Loom guidelines\nbe kind\n\n## Guidelines for this Weave\none PR per Thread");
  });
  it("instance only, weave only, neither", () => {
    expect(guidelinesFor("be kind")).toBe("## Loom guidelines\nbe kind");
    expect(guidelinesFor("", { guidelines: "w" })).toBe("## Guidelines for this Weave\nw");
    expect(guidelinesFor("", { guidelines: "" })).toBe("");
  });
});

describe("instance guidelines", () => {
  it("ships a non-empty default under the limit and reads it publicly", async () => {
    expect(DEFAULT_INSTANCE_GUIDELINES.length).toBeGreaterThan(0);
    expect(DEFAULT_INSTANCE_GUIDELINES.length).toBeLessThan(MAX_GUIDELINES_LENGTH);
    expect(await getInstanceGuidelines(db)).toBe(DEFAULT_INSTANCE_GUIDELINES);
    expect((await getSettings(db)).guidelines).toBe(DEFAULT_INSTANCE_GUIDELINES);
  });
  // The assertion above is the real guard -- it compares what a migrated database hands back with
  // the shipped text. This one says why that comparison used to break on a Windows checkout: the
  // migration spelled the default across physical newlines, which git rewrote to CRLF, so the
  // column default carried carriage returns the constant does not have. The literal is an escape
  // string now, and neither side may contain a raw CR.
  it("neither the shipped text nor the migration's default literal carries a carriage return", async () => {
    const sql = await readFile(new URL("../drizzle/0002_workable_doctor_doom.sql", import.meta.url), "utf8");
    const literal = sql.slice(sql.indexOf("E'"), sql.indexOf("' NOT NULL"));
    expect(literal).toContain("- Reply in the Thread");
    expect(literal).not.toContain("\r");
    expect(literal).not.toContain("\n");         // written as \\n, so no line ending can reach the default
    expect(DEFAULT_INSTANCE_GUIDELINES).not.toContain("\r");
  });
  it("a keeper patch sets, rejects 4001 chars, and clears with an empty string", async () => {
    await seedKeepers(db, [keeperToken("k")]);
    const k = await resolveCredential(db, keeperToken("k"));
    expect((await updateSettings(db, k, { guidelines: " reply in thread " })).guidelines).toBe("reply in thread");
    expect(await getInstanceGuidelines(db)).toBe("reply in thread");
    await expect(updateSettings(db, k, { guidelines: "x".repeat(4001) })).rejects.toMatchObject({ code: "validation" });
    expect((await updateSettings(db, k, { guidelines: "" })).guidelines).toBe("");
    expect(await getInstanceGuidelines(db)).toBe("");
  });
});

describe("setWeaveGuidelines", () => {
  let bus: EventBus;
  let w: Awaited<ReturnType<typeof createWeave>>;
  let keeper: Awaited<ReturnType<typeof resolveCredential>>;
  let j: Awaited<ReturnType<typeof joinWeave>>;
  let member: Awaited<ReturnType<typeof resolveCredential>>;
  // createWeave appends three events and the member's join a fourth, so the first guidelines
  // change is seq 5 -- the next seq after the Weave's lastSeq, as for every other appended event.
  beforeEach(async () => {
    bus = new EventBus();
    w = await createWeave(db, bus, { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } });
    keeper = await resolveCredential(db, w.token);
    j = await joinWeave(db, bus, w.secret, { name: "Bot", kind: "agent" });
    member = await resolveCredential(db, j.token);
  });

  // General is the Thread *flagged* General, not the oldest row: a Weave whose other Thread sorts
  // first (the Lobby has one per request, and a host clock that steps backwards is enough) must
  // still log its rules change where every participant reads it.
  it("lands the change on the Thread flagged General, whatever the timestamps say", async () => {
    const other = await createThread(db, bus, keeper, w.weave.id, "PR 14");
    await db.update(threads).set({ createdAt: new Date(new Date(other.createdAt).getTime() + 60_000) })
      .where(eq(threads.id, w.generalThread.id));
    await setWeaveGuidelines(db, bus, keeper, w.weave.id, "one PR per Thread");
    const last = (await readEvents(db, w.weave.id, {})).at(-1)!;
    expect(last.type).toBe("weave.guidelines_changed");
    expect(last.threadId).toBe(w.generalThread.id);
  });

  it("keeper sets; the event lands on General with new and previous text; the Weave carries it", async () => {
    const r = await setWeaveGuidelines(db, bus, keeper, w.weave.id, "  one PR per Thread ");
    expect(r.weave.guidelines).toBe("one PR per Thread");
    expect(r.seq).toBe(5);
    expect(r.weave.lastSeq).toBe(5);
    const [e] = await readEvents(db, w.weave.id, { since: 4 });
    expect(e).toMatchObject({ type: "weave.guidelines_changed", threadId: w.generalThread.id, actor: w.participant.id, payload: { guidelines: "one PR per Thread", previous: "" } });
    expect((await getWeave(db, keeper, w.weave.id)).weave.guidelines).toBe("one PR per Thread");
  });

  it("unchanged text appends nothing and returns seq null", async () => {
    await setWeaveGuidelines(db, bus, keeper, w.weave.id, "same");
    const r = await setWeaveGuidelines(db, bus, keeper, w.weave.id, " same ");
    expect(r.seq).toBeNull();
    expect(r.weave.guidelines).toBe("same");
    expect((await readEvents(db, w.weave.id, {})).at(-1)!.seq).toBe(5);
  });

  it("member forbidden; instance keeper allowed; archived refused; unknown weave not found; 4001 rejected", async () => {
    await expect(setWeaveGuidelines(db, bus, member, w.weave.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    await seedKeepers(db, [keeperToken("ik")]);
    const ik = await resolveCredential(db, keeperToken("ik"));
    expect((await setWeaveGuidelines(db, bus, ik, w.weave.id, "by instance keeper")).seq).toBe(5);
    // An instance keeper is not a participant of this Weave, so the event records the keeper
    // identity (`keeper:<id>`) rather than a participant id — which is what export.ts renders
    // as "Keeper" instead of looking the id up among the participants.
    const byKeeper = (await readEvents(db, w.weave.id, {})).at(-1)!;
    expect(byKeeper.type).toBe("weave.guidelines_changed");
    expect(byKeeper.actor.startsWith("keeper:")).toBe(true);
    await expect(setWeaveGuidelines(db, bus, keeper, w.weave.id, "x".repeat(4001))).rejects.toMatchObject({ code: "validation" });
    // Through the instance keeper, as every other unknown-weave guard is tested (guards.test.ts):
    // a Weave participant's credential fails the authority check first, never reaching the lookup.
    await expect(setWeaveGuidelines(db, bus, ik, "00000000-0000-0000-0000-000000000000", "x")).rejects.toMatchObject({ code: "weave_not_found" });
    await expect(setWeaveGuidelines(db, bus, ik, "not-a-uuid", "x")).rejects.toMatchObject({ code: "weave_not_found" });
    await archiveWeave(db, bus, keeper, w.weave.id);
    await expect(setWeaveGuidelines(db, bus, keeper, w.weave.id, "x")).rejects.toMatchObject({ code: "weave_archived" });
  });

  it("a keeper demoted between the check and the lock is refused", async () => {
    await setRole(db, bus, keeper, w.weave.id, j.participant.id, "keeper");
    const botKeeper = await resolveCredential(db, j.token);
    await expect(setWeaveGuidelines(db, bus, botKeeper, w.weave.id, "x", {
      afterAuth: async () => { await setRole(db, bus, keeper, w.weave.id, j.participant.id, "member"); },
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a fresh join composes its guidelines from the locked Weave, not the pre-lock read", async () => {
    const c = await createWeave(db, bus, { title: "Race", opener: "o", creator: { name: "Paw", kind: "human" } });
    const owner = await resolveCredential(db, c.token);
    // The rules change after joinWeave has read the Weave row and before it takes the lock -- the
    // window a concurrent keeper edit really lands in. The new participant must be told the rules
    // it is actually joining under, not the ones that were current a moment earlier.
    const joined = await joinWeave(db, bus, c.secret, { name: "Bot2", kind: "agent" }, undefined, {
      beforeLock: async () => { await setWeaveGuidelines(db, bus, owner, c.weave.id, "New rules"); },
    });
    expect(joined.weave.guidelines).toBe("New rules");
    expect(joined.guidelines).toContain("New rules");
    expect(joined.guidelines).toBe(guidelinesFor(DEFAULT_INSTANCE_GUIDELINES, { guidelines: "New rules" }));
    // createWeave appends three events, the guidelines change is seq 4, this join's own event seq 5 --
    // and the Weave the join reports is the Weave as of that event, as setWeaveGuidelines reports it too.
    const last = (await readEvents(db, c.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "participant.joined", seq: 5 });
    expect(joined.weave.lastSeq).toBe(last.seq);
  });

  it("a fresh join reads the instance layer inside the lock too", async () => {
    const c = await createWeave(db, bus, { title: "Race3", opener: "o", creator: { name: "Paw", kind: "human" } });
    await seedKeepers(db, [keeperToken("ik4")]);
    const ik = await resolveCredential(db, keeperToken("ik4"));
    // Same window as the Weave layer, one level up: an instance keeper rewrites the house rules
    // after joinWeave's pre-lock reads. Both layers of what the new participant is handed have to
    // be the ones it is actually joining under.
    const joined = await joinWeave(db, bus, c.secret, { name: "Bot3", kind: "agent" }, undefined, {
      beforeLock: async () => { await updateSettings(db, ik, { guidelines: "New instance rules" }); },
    });
    expect(joined.guidelines).toContain("New instance rules");
    expect(joined.guidelines).toBe(guidelinesFor("New instance rules", { guidelines: "" }));
  });

  it("a join that loses the first-join race answers with the rules current at that moment", async () => {
    const c = await createWeave(db, bus, { title: "Race2", opener: "o", creator: { name: "Paw", kind: "human" } });
    const owner = await resolveCredential(db, c.token);
    await seedKeepers(db, [keeperToken("ik2")]);
    const { key } = await addAgent(db, await resolveCredential(db, keeperToken("ik2")), "Twin");
    const agentActor = await resolveCredential(db, key);
    // The window the collision path really opens in: this call finds no participant of its own, so
    // it heads for the insert, and by the time it gets there a concurrent first join by the same
    // agent has won the unique index and a keeper has rewritten the rules. The loser adopts the
    // winner's identity -- and must describe the Weave as it is when it answers, not as the
    // pre-lock read left it.
    const lost = await joinWeave(db, bus, c.secret, { kind: "agent" }, agentActor, {
      beforeLock: async () => {
        await joinWeave(db, bus, c.secret, { kind: "agent" }, agentActor);
        await setWeaveGuidelines(db, bus, owner, c.weave.id, "New rules");
      },
    });
    expect(lost.alreadyJoined).toBe(true);
    expect(lost.weave.guidelines).toBe("New rules");
    expect(lost.guidelines).toBe(guidelinesFor(DEFAULT_INSTANCE_GUIDELINES, { guidelines: "New rules" }));
    // createWeave's three events, the winner's join (4) and the guidelines change (5); this call
    // appends nothing, so the Weave it reports is the Weave as of seq 5.
    const last = (await readEvents(db, c.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "weave.guidelines_changed", seq: 5 });
    expect(lost.weave.lastSeq).toBe(last.seq);
  });

  it("a second join by an agent that already has a participant carries the rules as they stand now", async () => {
    const c = await createWeave(db, bus, { title: "Again", opener: "o", creator: { name: "Paw", kind: "human" } });
    const owner = await resolveCredential(db, c.token);
    await seedKeepers(db, [keeperToken("ik3")]);
    const { key } = await addAgent(db, await resolveCredential(db, keeperToken("ik3")), "Solo");
    const agentActor = await resolveCredential(db, key);
    const first = await joinWeave(db, bus, c.secret, { kind: "agent" }, agentActor);
    expect(first.alreadyJoined).toBeUndefined();
    await setWeaveGuidelines(db, bus, owner, c.weave.id, "Newer rules");
    const again = await joinWeave(db, bus, c.secret, { kind: "agent" }, agentActor);
    expect(again.alreadyJoined).toBe(true);
    expect(again.participant.id).toBe(first.participant.id);
    expect(again.weave.guidelines).toBe("Newer rules");
    expect(again.guidelines).toBe(guidelinesFor(DEFAULT_INSTANCE_GUIDELINES, { guidelines: "Newer rules" }));
    expect(again.weave.lastSeq).toBe((await readEvents(db, c.weave.id, {})).at(-1)!.seq);
  });

  it("create with guidelines stores them without an event; create/join/get carry the combined text", async () => {
    const c = await createWeave(db, bus, { title: "T2", opener: "o", creator: { name: "Paw", kind: "human" }, guidelines: " house rules " });
    expect(c.weave.guidelines).toBe("house rules");
    expect(c.weave.lastSeq).toBe(3);
    expect(c.guidelines).toBe(guidelinesFor(DEFAULT_INSTANCE_GUIDELINES, { guidelines: "house rules" }));
    const jj = await joinWeave(db, bus, c.secret, { name: "Bot", kind: "agent" });
    expect(jj.guidelines).toBe(c.guidelines);
    expect((await getWeave(db, await resolveCredential(db, c.token), c.weave.id)).guidelines).toBe(c.guidelines);
    await expect(createWeave(db, bus, { title: "T3", opener: "o", creator: { name: "Paw", kind: "human" }, guidelines: "x".repeat(4001) })).rejects.toMatchObject({ code: "validation" });
  });
});
