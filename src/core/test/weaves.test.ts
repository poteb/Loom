import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { threads } from "../src/db/schema.js";
import { createThread } from "../src/threads.js";
import { createWeave, getWeave, joinWeave, archiveWeave, listWeaves, lookupWeaveIdBySecret } from "../src/weaves.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { updateSettings } from "../src/settings.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const input = { title: "PR #42", opener: "Review https://github.com/x/y/pull/42", creator: { name: "Claude", kind: "agent" as const } };

describe("createWeave", () => {
  it("creates weave, General, creator as keeper, and three events", async () => {
    const r = await createWeave(db, bus, input);
    expect(r.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.participant.role).toBe("keeper");
    expect(r.generalThread.isGeneral).toBe(true);
    expect(r.generalThread.name).toBe("General");
    const evs = await readEvents(db, r.weave.id, {});
    expect(evs.map((e) => e.type)).toEqual(["thread.created", "participant.joined", "message"]);
    // Same payload shape as any other thread.created, so a reader never has to special-case General.
    expect(evs[0]!.payload).toEqual({ threadId: r.generalThread.id, name: "General", url: null });
    expect(evs[2]!.payload).toEqual({ text: input.opener, mentions: [] });
    expect(evs[2]!.actor).toBe(r.participant.id);
    expect(r.weave.lastSeq).toBe(3);
    const me = await resolveCredential(db, r.token);
    expect(me.kind).toBe("participant");
  });
  // A blank opener is not a message. `postMessage` refuses text that is empty once trimmed
  // ("Message text is empty", messages.ts), so appending one here would be the only way a message
  // no participant could ever have posted gets into a log — and it is what the web form's optional
  // first message produced: a header with nothing under it.
  it.each([["an empty", ""], ["a whitespace-only", " \t\n "]])
    ("%s opener is not appended: the Weave is born with two events", async (_label, opener) => {
    const r = await createWeave(db, bus, { ...input, opener });
    const evs = await readEvents(db, r.weave.id, {});
    expect(evs.map((e) => e.type)).toEqual(["thread.created", "participant.joined"]);
    expect(evs.map((e) => e.seq)).toEqual([1, 2]);
    expect(r.weave.lastSeq).toBe(2);
  });
  // Blankness is decided on the trimmed text; what is stored is the text as given, which is what
  // `postMessage` does with a message that passes the same check.
  it("stores a non-blank opener exactly as given, untrimmed", async () => {
    const r = await createWeave(db, bus, { ...input, opener: "  hello  " });
    const evs = await readEvents(db, r.weave.id, {});
    expect(evs).toHaveLength(3);
    expect(evs[2]!.payload).toEqual({ text: "  hello  ", mentions: [] });
    expect(r.weave.lastSeq).toBe(3);
  });
  it("still refuses an opener longer than maxMessageLength", async () => {
    await expect(createWeave(db, bus, { ...input, opener: "x".repeat(20_001) }))
      .rejects.toMatchObject({ code: "message_too_long" });
  });
  it("respects openWeaveCreation=false", async () => {
    await seedKeepers(db, [keeperToken("k")]);
    const k = await resolveCredential(db, keeperToken("k"));
    await updateSettings(db, k, { openWeaveCreation: false });
    await expect(createWeave(db, bus, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createWeave(db, bus, input, k)).resolves.toBeTruthy();
  });
  it("validates title and name", async () => {
    await expect(createWeave(db, bus, { ...input, title: " " })).rejects.toMatchObject({ code: "validation" });
    await expect(createWeave(db, bus, { ...input, creator: { name: "a b", kind: "human" } })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("joinWeave", () => {
  it("adds a member and emits participant.joined", async () => {
    const r = await createWeave(db, bus, input);
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    expect(j.weaveId).toBe(r.weave.id);
    expect(j.participant.role).toBe("member");
    const evs = await readEvents(db, r.weave.id, { since: 3 });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe("participant.joined");
    expect(evs[0]!.payload).toMatchObject({ participantId: j.participant.id, name: "ChatGPT", kind: "agent", role: "member" });
  });
  // The Lobby is full of Threads nobody would call General — one per request — and a Weave's
  // General Thread is the one flagged as such, not the oldest row in it. Timestamps are not an
  // ordering anyone controls: a host clock that steps backwards is enough to put a later Thread
  // first, and the caller is then handed a request Thread as its "General" one.
  it("returns the Thread flagged General even when another Thread's timestamp is older", async () => {
    const r = await createWeave(db, bus, input);
    const other = await createThread(db, bus, await resolveCredential(db, r.token), r.weave.id, "PR 14");
    await db.update(threads).set({ createdAt: new Date(new Date(other.createdAt).getTime() - 60_000) })
      .where(eq(threads.id, r.generalThread.id));
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    expect(j.generalThreadId).toBe(r.generalThread.id);
    await db.update(threads).set({ createdAt: new Date(new Date(other.createdAt).getTime() + 60_000) })
      .where(eq(threads.id, r.generalThread.id));
    const later = await joinWeave(db, bus, r.secret, { name: "Gemini", kind: "agent" });
    expect(later.generalThreadId).toBe(r.generalThread.id);
  });

  it("rejects duplicate names case-insensitively", async () => {
    const r = await createWeave(db, bus, input);
    await expect(joinWeave(db, bus, r.secret, { name: "claude", kind: "human" })).rejects.toMatchObject({ code: "name_taken" });
  });
  it("rejects bad secret and archived weave", async () => {
    await expect(joinWeave(db, bus, "nope", { name: "X", kind: "human" })).rejects.toMatchObject({ code: "weave_not_found" });
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(joinWeave(db, bus, r.secret, { name: "X", kind: "human" })).rejects.toMatchObject({ code: "weave_archived" });
  });
});

describe("getWeave", () => {
  it("works with participant token, secret, and keeper; hides tokens", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const bySecret = await resolveCredential(db, r.secret);
    await seedKeepers(db, [keeperToken("k")]);
    const k = await resolveCredential(db, keeperToken("k"));
    for (const a of [me, bySecret, k]) {
      const info = await getWeave(db, a, r.weave.id);
      expect(info.weave.title).toBe("PR #42");
      expect(info.threads).toHaveLength(1);
      expect(info.participants).toHaveLength(1);
      expect(JSON.stringify(info)).not.toContain(r.token);
    }
  });
  it("refuses a credential from another weave", async () => {
    const a = await createWeave(db, bus, input);
    const b = await createWeave(db, bus, input);
    const meA = await resolveCredential(db, a.token);
    await expect(getWeave(db, meA, b.weave.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("lookupWeaveIdBySecret", () => {
  it("resolves a created weave's secret to its id; unknown secret is weave_not_found", async () => {
    const r = await createWeave(db, bus, input);
    await expect(lookupWeaveIdBySecret(db, r.secret)).resolves.toBe(r.weave.id);
    await expect(lookupWeaveIdBySecret(db, "nope")).rejects.toMatchObject({ code: "weave_not_found" });
  });
});

describe("archiveWeave / listWeaves", () => {
  // The same rule as `joinWeave` above, for the event this one appends.
  it("logs the archive on the Thread flagged General, whatever the timestamps say", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const other = await createThread(db, bus, me, r.weave.id, "PR 14");
    await db.update(threads).set({ createdAt: new Date(new Date(other.createdAt).getTime() + 60_000) })
      .where(eq(threads.id, r.generalThread.id));
    await archiveWeave(db, bus, me, r.weave.id);
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last.type).toBe("weave.archived");
    expect(last.threadId).toBe(r.generalThread.id);
  });

  it("keeper role archives; member cannot; archive is idempotent-rejecting", async () => {
    const r = await createWeave(db, bus, input);
    const j = await joinWeave(db, bus, r.secret, { name: "Member", kind: "human" });
    const member = await resolveCredential(db, j.token);
    await expect(archiveWeave(db, bus, member, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
    const me = await resolveCredential(db, r.token);
    await archiveWeave(db, bus, me, r.weave.id);
    const info = await getWeave(db, me, r.weave.id);
    expect(info.weave.archivedAt).not.toBeNull();
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last.type).toBe("weave.archived");
    await expect(archiveWeave(db, bus, me, r.weave.id)).rejects.toMatchObject({ code: "weave_archived" });
  });
  it("instance keeper archives without joining and lists all weaves", async () => {
    const r = await createWeave(db, bus, input);
    await seedKeepers(db, [keeperToken("k")]);
    const k = await resolveCredential(db, keeperToken("k"));
    await archiveWeave(db, bus, k, r.weave.id);
    const all = await listWeaves(db, k);
    expect(all).toHaveLength(1);
    expect(all[0]!.archivedAt).not.toBeNull();
    const me = await resolveCredential(db, r.token);
    await expect(listWeaves(db, me)).rejects.toMatchObject({ code: "forbidden" });
  });
});
