import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { inviteParticipant } from "../src/invites.js";
import { postMessage } from "../src/messages.js";
import { inbox } from "../src/inbox.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { createCore } from "../src/index.js";
import { keeperToken } from "./helpers.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

describe("inbox", () => {
  it("returns only invites to me and messages mentioning me, in seq order, never my own events", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const paw = await resolveCredential(db, r.token);
    const b = await joinWeave(db, bus, r.secret, { name: "Bot", kind: "agent" });
    const bot = await resolveCredential(db, b.token);
    const o = await joinWeave(db, bus, r.secret, { name: "Other", kind: "agent" });
    const t = await createThread(db, bus, paw, r.weave.id, "PR 1", "https://e.com/1");
    const inv = await inviteParticipant(db, bus, paw, t.id, b.participant.id);
    await inviteParticipant(db, bus, paw, t.id, o.participant.id);                 // someone else's invite
    const m1 = await postMessage(db, bus, paw, t.id, "@Bot please review");
    await postMessage(db, bus, paw, t.id, "@Other you too");                       // not for me
    await postMessage(db, bus, bot, t.id, "@Paw on it");                           // my own message (mentions Paw, not me)
    await postMessage(db, bus, bot, t.id, "@Bot noted");                           // my own message mentioning me: only the actor filter excludes it
    const m2 = await postMessage(db, bus, paw, r.generalThread.id, "ping @Bot again");
    const mine = await inbox(db, bot, r.weave.id, {});
    expect(mine.map((e) => [e.type, e.seq])).toEqual([["thread.invited", inv.seq], ["message", m1.seq], ["message", m2.seq]]);
    const later = await inbox(db, bot, r.weave.id, { since: m1.seq });
    expect(later.map((e) => e.seq)).toEqual([m2.seq]);
    // No `since`: the most recent addressed events, not the oldest page (a remote agent with no
    // cursor wants what it just missed).
    const one = await inbox(db, bot, r.weave.id, { limit: 1 });
    expect(one.map((e) => e.seq)).toEqual([m2.seq]);
    const two = await inbox(db, bot, r.weave.id, { limit: 2 });
    expect(two.map((e) => e.seq)).toEqual([m1.seq, m2.seq]);   // newest two, still ascending
  });
  it("needs a participant credential of that Weave", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "", creator: { name: "Paw", kind: "human" } });
    const bySecret = await resolveCredential(db, r.secret);
    await expect(inbox(db, bySecret, r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
    const other = await createWeave(db, bus, { title: "O", opener: "", creator: { name: "Q", kind: "human" } });
    await expect(inbox(db, await resolveCredential(db, other.token), r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
  it("clamps limit, rejects malformed ids and keepers", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const paw = await resolveCredential(db, r.token);
    const b = await joinWeave(db, bus, r.secret, { name: "Bot", kind: "agent" });
    const bot = await resolveCredential(db, b.token);
    const t = await createThread(db, bus, paw, r.weave.id, "PR 1", null);
    const inv = await inviteParticipant(db, bus, paw, t.id, b.participant.id);
    const m1 = await postMessage(db, bus, paw, t.id, "@Bot please review");
    const m2 = await postMessage(db, bus, paw, t.id, "@Bot again");
    expect((await inbox(db, bot, r.weave.id, { limit: 0 })).map((e) => e.seq)).toEqual([m2.seq]);   // clamped to 1: the newest
    expect((await inbox(db, bot, r.weave.id, { limit: 5000 })).map((e) => e.seq)).toEqual([inv.seq, m1.seq, m2.seq]);
    await expect(inbox(db, bot, "nope", {})).rejects.toMatchObject({ code: "weave_not_found" });
    await seedKeepers(db, [keeperToken("k1")]);
    const keeper = await resolveCredential(db, keeperToken("k1"));
    await expect(inbox(db, keeper, r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
  it("facade maps an agent key to its participant", async () => {
    const core = createCore(db);
    await core.seedKeepers([keeperToken("k1")]);
    const keeper = await core.resolveCredential(keeperToken("k1"));
    const r = await core.createWeave({ title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const paw = await core.resolveCredential(r.token);
    const { key } = await core.addAgent(keeper, "Bot");
    const agent = await core.resolveCredential(key);
    await core.joinWeave(r.secret, { name: "Bot", kind: "agent" }, agent);
    const m = await core.postMessage(paw, r.generalThread.id, "@Bot hi");
    expect((await core.inbox(agent, r.weave.id, {})).map((e) => e.seq)).toEqual([m.seq]);
    const other = await core.createWeave({ title: "O", opener: "", creator: { name: "Q", kind: "human" } });
    await expect(core.inbox(agent, other.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});
