import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { inviteParticipant } from "../src/invites.js";
import { postMessage } from "../src/messages.js";
import { inbox } from "../src/inbox.js";
import { resolveCredential } from "../src/actors.js";
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
    const m2 = await postMessage(db, bus, paw, r.generalThread.id, "ping @Bot again");
    const mine = await inbox(db, bot, r.weave.id, {});
    expect(mine.map((e) => [e.type, e.seq])).toEqual([["thread.invited", inv.seq], ["message", m1.seq], ["message", m2.seq]]);
    const later = await inbox(db, bot, r.weave.id, { since: m1.seq });
    expect(later.map((e) => e.seq)).toEqual([m2.seq]);
    const one = await inbox(db, bot, r.weave.id, { limit: 1 });
    expect(one.map((e) => e.seq)).toEqual([inv.seq]);
  });
  it("needs a participant credential of that Weave", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "", creator: { name: "Paw", kind: "human" } });
    const bySecret = await resolveCredential(db, r.secret);
    await expect(inbox(db, bySecret, r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
    const other = await createWeave(db, bus, { title: "O", opener: "", creator: { name: "Q", kind: "human" } });
    await expect(inbox(db, await resolveCredential(db, other.token), r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});
