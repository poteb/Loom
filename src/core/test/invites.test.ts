import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread, closeThread } from "../src/threads.js";
import { inviteParticipant } from "../src/invites.js";
import { removeParticipant } from "../src/removals.js";
import { postMessage } from "../src/messages.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { setRole } from "../src/participants.js";
import { seedKeepers } from "../src/keepers.js";
import { participants } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); await seedKeepers(db, [keeperToken("k1")]); });
const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

async function setup() {
  const r = await createWeave(db, bus, input);
  const owner = await resolveCredential(db, r.token);                       // Weave keeper
  const c = await joinWeave(db, bus, r.secret, { name: "Creator", kind: "human" });
  const creator = await resolveCredential(db, c.token);
  const m = await joinWeave(db, bus, r.secret, { name: "Member", kind: "human" });
  const member = await resolveCredential(db, m.token);
  const g = await joinWeave(db, bus, r.secret, { name: "Guest", kind: "agent" });
  const guest = await resolveCredential(db, g.token);
  const t = await createThread(db, bus, creator, r.weave.id, "PR 1", "https://e.com/pr/1");
  return { r, owner, creator, member, guest, t, memberId: m.participant.id, guestId: g.participant.id };
}
const idOf = (a: Awaited<ReturnType<typeof resolveCredential>>) => (a.kind === "participant" ? a.participant.id : "");

describe("inviteParticipant", () => {
  it("thread creator invites; event carries invitee and inviter; invite is idempotent", async () => {
    const { r, creator, t, guestId } = await setup();
    const first = await inviteParticipant(db, bus, creator, t.id, guestId);
    expect(first.created).toBe(true);
    const ev = (await readEvents(db, r.weave.id, {})).find((e) => e.seq === first.seq)!;
    expect(ev).toMatchObject({ type: "thread.invited", threadId: t.id, payload: { threadId: t.id, participantId: guestId } });
    expect(ev.payload.invitedBy).toBe(ev.actor);
    const again = await inviteParticipant(db, bus, creator, t.id, guestId);
    expect(again).toEqual({ seq: first.seq, created: false });
    expect((await readEvents(db, r.weave.id, {})).filter((e) => e.type === "thread.invited")).toHaveLength(1);
  });
  it("Weave keeper and instance keeper invite; plain member cannot", async () => {
    const { owner, member, t, guestId, memberId } = await setup();
    await expect(inviteParticipant(db, bus, member, t.id, guestId)).rejects.toMatchObject({ code: "forbidden" });
    expect((await inviteParticipant(db, bus, owner, t.id, guestId)).created).toBe(true);
    const instance = await resolveCredential(db, keeperToken("k1"));
    const byInstance = await inviteParticipant(db, bus, instance, t.id, memberId);
    expect(byInstance.created).toBe(true);
    const ev = (await readEvents(db, t.weaveId, {})).find((e) => e.seq === byInstance.seq)!;
    expect(String(ev.payload.invitedBy)).toMatch(/^keeper:/);
  });
  it("a member promoted to keeper may invite", async () => {
    const { r, owner, t, guestId, memberId } = await setup();
    await setRole(db, bus, owner, r.weave.id, memberId, "keeper");
    const [row] = await db.select().from(participants).where(eq(participants.id, memberId));
    const promoted = await resolveCredential(db, row!.token);   // re-resolve: an Actor carries the role captured at resolution
    expect((await inviteParticipant(db, bus, promoted, t.id, guestId)).created).toBe(true);
  });
  it("rejects self-invite, non-participants, closed threads, archived weaves and bad ids", async () => {
    const { r, owner, creator, t, guestId } = await setup();
    const creatorId = creator.kind === "participant" ? creator.participant.id : "";
    await expect(inviteParticipant(db, bus, creator, t.id, creatorId)).rejects.toMatchObject({ code: "validation" });
    await expect(inviteParticipant(db, bus, creator, t.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "validation" });
    await expect(inviteParticipant(db, bus, creator, t.id, "nope")).rejects.toMatchObject({ code: "validation" });
    await expect(inviteParticipant(db, bus, creator, "00000000-0000-4000-8000-000000000000", guestId)).rejects.toMatchObject({ code: "thread_not_found" });
    const other = await createWeave(db, bus, input);
    const stranger = await resolveCredential(db, other.token);
    await expect(inviteParticipant(db, bus, stranger, t.id, guestId)).rejects.toMatchObject({ code: "forbidden" });
    await closeThread(db, bus, owner, t.id);
    await expect(inviteParticipant(db, bus, creator, t.id, guestId)).rejects.toMatchObject({ code: "thread_closed" });
    await archiveWeave(db, bus, owner, r.weave.id);
    await expect(inviteParticipant(db, bus, owner, r.generalThread.id, guestId)).rejects.toMatchObject({ code: "weave_archived" });
  });
  it("a keeper removed from a Thread by its creator may invite itself back", async () => {
    const { owner, creator, t } = await setup();
    const ownerId = idOf(owner);
    await removeParticipant(db, bus, creator, t.id, ownerId);
    const back = await inviteParticipant(db, bus, owner, t.id, ownerId);
    expect(back.created).toBe(true);
    const ev = (await readEvents(db, t.weaveId, {})).find((e) => e.seq === back.seq)!;
    expect(ev).toMatchObject({ type: "thread.invited", threadId: t.id, actor: ownerId,
      payload: { threadId: t.id, participantId: ownerId, invitedBy: ownerId } });
    expect((await postMessage(db, bus, owner, t.id, "back")).type).toBe("message");
  });
  it("a keeper's second self-invite after readmission returns the first seq, created false", async () => {
    const { owner, creator, t } = await setup();
    const ownerId = idOf(owner);
    await removeParticipant(db, bus, creator, t.id, ownerId);
    const first = await inviteParticipant(db, bus, owner, t.id, ownerId);
    const again = await inviteParticipant(db, bus, owner, t.id, ownerId);
    expect(again).toEqual({ seq: first.seq, created: false });
  });
  it("a keeper never removed from the Thread cannot invite itself", async () => {
    const { owner, t } = await setup();
    await expect(inviteParticipant(db, bus, owner, t.id, idOf(owner)))
      .rejects.toMatchObject({ code: "validation", message: "You cannot invite yourself" });
  });
  it("a removed Thread creator who is not a keeper cannot invite itself", async () => {
    const { owner, creator, t } = await setup();
    await removeParticipant(db, bus, owner, t.id, idOf(creator));
    await expect(inviteParticipant(db, bus, creator, t.id, idOf(creator)))
      .rejects.toMatchObject({ code: "validation", message: "You cannot invite yourself" });
  });
  it("a keeper demoted after its removal cannot readmit itself", async () => {
    const { r, owner, creator, t } = await setup();
    const ownerId = idOf(owner);
    await removeParticipant(db, bus, creator, t.id, ownerId);
    const instance = await resolveCredential(db, keeperToken("k1"));
    await setRole(db, bus, instance, r.weave.id, ownerId, "member");
    const demoted = await resolveCredential(db, r.token);   // loaded afresh, as every request does
    await expect(inviteParticipant(db, bus, demoted, t.id, ownerId))
      .rejects.toMatchObject({ code: "validation", message: "You cannot invite yourself" });
  });
  it("a keeper demoted between resolving and inviting cannot readmit itself", async () => {
    const { r, owner, creator, t } = await setup();   // owner resolved while still a keeper
    const ownerId = idOf(owner);
    await removeParticipant(db, bus, creator, t.id, ownerId);
    const instance = await resolveCredential(db, keeperToken("k1"));
    await setRole(db, bus, instance, r.weave.id, ownerId, "member");
    // The stale Actor still carries role keeper, so only the in-lock re-check can refuse it, and it
    // answers as a freshly loaded Actor would: the self-invite rule.
    await expect(inviteParticipant(db, bus, owner, t.id, ownerId))
      .rejects.toMatchObject({ code: "validation", message: "You cannot invite yourself" });
  });
  it("a keeper's self-readmission into a closed Thread is thread_closed", async () => {
    const { owner, creator, t } = await setup();
    const ownerId = idOf(owner);
    await removeParticipant(db, bus, creator, t.id, ownerId);
    await closeThread(db, bus, owner, t.id);
    await expect(inviteParticipant(db, bus, owner, t.id, ownerId)).rejects.toMatchObject({ code: "thread_closed" });
  });
  it("a keeper never removed from a closed Thread still gets validation for a self-invite", async () => {
    const { owner, t } = await setup();
    await closeThread(db, bus, owner, t.id);
    await expect(inviteParticipant(db, bus, owner, t.id, idOf(owner)))
      .rejects.toMatchObject({ code: "validation", message: "You cannot invite yourself" });
  });
});
