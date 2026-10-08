import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { exportWeave } from "../src/export.js";
import { resolveCredential } from "../src/actors.js";
import { setWeaveGuidelines } from "../src/guidelines.js";
import { inviteParticipant } from "../src/invites.js";
import { removeParticipant } from "../src/removals.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities } from "../src/lobby/profile.js";
import { offer, openRequest } from "../src/lobby/requests.js";
import { sweepOfflineListeners } from "../src/lobby/removal.js";
import { inviteToWeave, withdrawInvitation } from "../src/lobby/invitations.js";
import { participants } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "PR 42", opener: "Look at this", creator: { name: "Claude", kind: "agent" as const } };

describe("exportWeave", () => {
  it("json contains everything, md is grouped by thread, secret can export archived weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    const gpt = await resolveCredential(db, j.token);
    const t = await createThread(db, bus, me, r.weave.id, "Design");
    await postMessage(db, bus, gpt, t.id, "I disagree @Claude");
    await archiveWeave(db, bus, me, r.weave.id);

    const bySecret = await resolveCredential(db, r.secret);
    const json = JSON.parse(await exportWeave(db, bySecret, r.weave.id, "json"));
    expect(json.weave.title).toBe("PR 42");
    expect(json.threads).toHaveLength(2);
    expect(json.participants).toHaveLength(2);
    expect(json.events.at(-1).type).toBe("weave.archived");
    expect(JSON.stringify(json)).not.toContain(r.token);

    const md = await exportWeave(db, bySecret, r.weave.id, "md");
    expect(md).toContain("# PR 42");
    expect(md.indexOf("## General")).toBeLessThan(md.indexOf("## Design"));
    expect(md).toContain("**ChatGPT**");
    expect(md).toContain("I disagree @Claude");
    expect(md).toContain("_system: ChatGPT joined_");
    expect(md).toContain("_system: Weave archived_");
  });
  it("reads metadata and events from one snapshot: a Thread created mid-export appears in neither", async () => {
    // Metadata and the event pages used to be separate statements against the pool, so a Thread
    // created between them landed in the events but not in the Thread list (and, in Markdown,
    // vanished entirely because the rendering iterates the stale Thread list), with a lastSeq that
    // described older state than the events beside it.
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const out = await exportWeave(db, me, r.weave.id, "json", {
      afterMetadata: async () => {
        const late = await createThread(db, bus, me, r.weave.id, "Late");
        await postMessage(db, bus, me, late.id, "committed mid-export");
      },
    });
    const json = JSON.parse(out);
    expect(json.threads.map((t: { name: string }) => t.name)).toEqual(["General"]);
    expect(json.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
    expect(json.weave.lastSeq).toBe(json.events.at(-1).seq);
    expect(out).not.toContain("committed mid-export");
    // The Weave really did move on; the export simply described one consistent point in time.
    expect((await exportWeave(db, me, r.weave.id, "json")).includes("committed mid-export")).toBe(true);
  });

  it("renders the current guidelines in the metadata and every change with the text that applied", async () => {
    // The transcript has to show which rules applied when, so each change keeps its full text
    // rather than collapsing to a one-line system entry; the metadata shows only what is current.
    const r = await createWeave(db, bus, { ...input, creator: { name: "Paw", kind: "human" as const } });
    const me = await resolveCredential(db, r.token);
    await setWeaveGuidelines(db, bus, me, r.weave.id, "A");
    await setWeaveGuidelines(db, bus, me, r.weave.id, "B");

    const set = await exportWeave(db, me, r.weave.id, "md");
    expect(set).toContain("- Guidelines:\n  > B");
    expect(set).toContain("_system: Guidelines changed by Paw_");
    expect(JSON.parse(await exportWeave(db, me, r.weave.id, "json")).weave.guidelines).toBe("B");

    await setWeaveGuidelines(db, bus, me, r.weave.id, "");
    const md = await exportWeave(db, me, r.weave.id, "md");
    expect(md).not.toContain("- Guidelines:");
    const order = ["Guidelines changed by Paw", "> A", "Guidelines changed by Paw", "> B", "Guidelines cleared by Paw"];
    let at = -1;
    for (const needle of order) {
      const next = md.indexOf(needle, at + 1);
      expect(next, needle).toBeGreaterThan(at);
      at = next;
    }
    expect(JSON.parse(await exportWeave(db, me, r.weave.id, "json")).weave.guidelines).toBe("");
  });

  it("renders a thread.removed as a system line naming who was removed and by whom", async () => {
    const r = await createWeave(db, bus, { ...input, creator: { name: "Paw", kind: "human" as const } });
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    const t = await createThread(db, bus, me, r.weave.id, "Design");
    await inviteParticipant(db, bus, me, t.id, j.participant.id);
    await removeParticipant(db, bus, me, t.id, j.participant.id);
    const md = await exportWeave(db, me, r.weave.id, "md");
    expect(md).toContain("_system: ChatGPT removed from the Thread by Paw_");
    expect(md).not.toContain("_system: thread.removed_");
  });

  // External review round 1, S2: the offline sweep's two events in the web's words, not their type.
  it("renders listener.removed (last seen, or never) and request.offer_withdrawn as system lines in the web's words", async () => {
    const lobby = await ensureLobby(db);
    const reader = await resolveCredential(db, lobby.secret);
    const target = await createWeave(db, bus, { title: "Session", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const keeper = await resolveCredential(db, target.token);
    const thread = await createThread(db, bus, keeper, target.weave.id, "PR 14");
    const requester = await resolveCredential(db, (await joinLobby(db, bus, { name: "Asker", kind: "human" })).token);
    const bot = async (name: string) => {
      const j = await joinLobby(db, bus, { name, kind: "agent" });
      const actor = await resolveCredential(db, j.token);
      await setCapabilities(db, bus, actor, { owner: `${name}-owner`, serves: "anyone" });
      return { id: j.participant.id, actor };
    };
    const seenOne = await bot("Seen");
    const neverSeen = await bot("Never");
    const r = await openRequest(db, bus, requester, keeper, {
      title: "Review PR 14", requirements: {}, wanted: 1, targetWeaveId: target.weave.id, targetThreadId: thread.id, url: null,
    });
    await offer(db, bus, seenOne.actor, r.id, {});
    const now = new Date();
    const seen = new Date(now.getTime() - 2 * 86_400_000);
    await db.update(participants).set({ lastSeenAt: seen }).where(eq(participants.id, seenOne.id));
    await db.update(participants).set({ lastSeenAt: null, joinedAt: seen }).where(eq(participants.id, neverSeen.id));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(2);
    const md = await exportWeave(db, reader, lobby.weaveId, "md");
    expect(md).toContain(`_system: Seen was removed from the Listeners by Loom (last seen ${seen.toISOString()})_`);
    expect(md).toContain("_system: Never was removed from the Listeners by Loom (last seen never)_");
    expect(md).toContain("_system: Seen's offer was withdrawn by Loom (offline)_");
    expect(md).not.toContain("_system: listener.removed_");
    expect(md).not.toContain("_system: request.offer_withdrawn_");
  });

  it("renders weave.invitation_withdrawn as a system line in the web's words (spec 2026-10-08 §8.3)", async () => {
    const lobby = await ensureLobby(db);
    const reader = await resolveCredential(db, lobby.secret);
    const target = await createWeave(db, bus, { title: "Loom development", opener: "hi", creator: { name: "Claude-Code", kind: "agent" } });
    const keeper = await resolveCredential(db, target.token);
    const thread = await createThread(db, bus, keeper, target.weave.id, "PR 14");
    const invitee = await joinLobby(db, bus, { name: "Claude-Work", kind: "agent" });
    const { invitationId } = await inviteToWeave(db, bus, keeper, invitee.participant.id, target.weave.id, thread.id);
    await withdrawInvitation(db, bus, keeper, target.weave.id, invitationId);
    const md = await exportWeave(db, reader, lobby.weaveId, "md");
    expect(md).toContain('_system: invitation to "Loom development" for Claude-Work withdrawn by Claude-Code_');
    expect(md).not.toContain("_system: weave.invitation_withdrawn_");
  });

  it("rejects bad format and foreign credential", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await expect(exportWeave(db, me, r.weave.id, "xml" as never)).rejects.toMatchObject({ code: "validation" });
    const other = await createWeave(db, bus, input);
    await expect(exportWeave(db, me, other.weave.id, "md")).rejects.toMatchObject({ code: "forbidden" });
  });
});
