import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread, closeThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { updateSettings } from "../src/settings.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

describe("postMessage", () => {
  it("posts with resolved mentions and publishes", async () => {
    const r = await createWeave(db, bus, input);
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    const me = await resolveCredential(db, r.token);
    const seen: number[] = [];
    bus.subscribe(r.weave.id, (e) => seen.push(e.seq));
    const ev = await postMessage(db, bus, me, r.generalThread.id, "hey @chatgpt look");
    expect(ev.type).toBe("message");
    expect(ev.actor).toBe(r.participant.id);
    expect(ev.payload).toEqual({ text: "hey @chatgpt look", mentions: [j.participant.id] });
    expect(seen).toEqual([ev.seq]);
  });
  it("rejects empty, too long, secret-only, wrong weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await expect(postMessage(db, bus, me, r.generalThread.id, "   ")).rejects.toMatchObject({ code: "validation" });
    await seedKeepers(db, [keeperToken("k")]);
    const k = await resolveCredential(db, keeperToken("k"));
    await updateSettings(db, k, { maxMessageLength: 5 });
    await expect(postMessage(db, bus, me, r.generalThread.id, "123456")).rejects.toMatchObject({ code: "message_too_long" });
    const bySecret = await resolveCredential(db, r.secret);
    await expect(postMessage(db, bus, bySecret, r.generalThread.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    const other = await createWeave(db, bus, input);
    await expect(postMessage(db, bus, me, other.generalThread.id, "x")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("instance keepers cannot post (they are not participants)", async () => {
    const r = await createWeave(db, bus, input);
    await seedKeepers(db, [keeperToken("k")]);
    const k = await resolveCredential(db, keeperToken("k"));
    await expect(postMessage(db, bus, k, r.generalThread.id, "x")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects closed thread and archived weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const t = await createThread(db, bus, me, r.weave.id, "X");
    await closeThread(db, bus, me, t.id);
    await expect(postMessage(db, bus, me, t.id, "x")).rejects.toMatchObject({ code: "thread_closed" });
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(postMessage(db, bus, me, r.generalThread.id, "x")).rejects.toMatchObject({ code: "weave_archived" });
  });
});
