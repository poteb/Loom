import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { setRole } from "../src/participants.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

describe("setRole", () => {
  it("weave keeper promotes and demotes; event emitted; new keeper can archive", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const p = await setRole(db, bus, me, r.weave.id, j.participant.id, "keeper");
    expect(p.role).toBe("keeper");
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "participant.role_changed", payload: { participantId: j.participant.id, role: "keeper" } });
    const member = await resolveCredential(db, j.token);
    expect((member as { participant: { role: string } }).participant.role).toBe("keeper");
    await setRole(db, bus, member, r.weave.id, r.participant.id, "member");
    await archiveWeave(db, bus, member, r.weave.id);
  });
  it("members cannot; instance keeper can; validation on role/participant; archived rejected", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const member = await resolveCredential(db, j.token);
    await expect(setRole(db, bus, member, r.weave.id, r.participant.id, "member")).rejects.toMatchObject({ code: "forbidden" });
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    await setRole(db, bus, k, r.weave.id, j.participant.id, "keeper");
    await expect(setRole(db, bus, k, r.weave.id, j.participant.id, "boss" as never)).rejects.toMatchObject({ code: "validation" });
    await expect(setRole(db, bus, k, r.weave.id, "00000000-0000-0000-0000-000000000000", "member")).rejects.toMatchObject({ code: "validation" });
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(setRole(db, bus, k, r.weave.id, j.participant.id, "member")).rejects.toMatchObject({ code: "weave_archived" });
  });
});
