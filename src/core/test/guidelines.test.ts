import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { DEFAULT_INSTANCE_GUIDELINES } from "../src/guidelines-default.js";
import { MAX_GUIDELINES_LENGTH, validateGuidelines, guidelinesFor, getInstanceGuidelines, setWeaveGuidelines } from "../src/guidelines.js";
import { EventBus } from "../src/bus.js";
import { archiveWeave, createWeave, getWeave, joinWeave } from "../src/weaves.js";
import { setRole } from "../src/participants.js";
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
