import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { createCore, LoomError, type Core } from "../src/index.js";

afterAll(closeTestDb);
let core: Core;
beforeEach(async () => { core = createCore(await freshDb()); });

describe("createCore", () => {
  it("wires the full create → join → post → read → archive flow", async () => {
    const r = await core.createWeave({ title: "T", opener: "start", creator: { name: "Claude", kind: "agent" } });
    const j = await core.joinWeave(r.secret, { name: "ChatGPT", kind: "agent" });
    const gpt = await core.resolveCredential(j.token);
    const seen: number[] = [];
    core.bus.subscribe(r.weave.id, (e) => seen.push(e.seq));
    await core.postMessage(gpt, r.generalThread.id, "hello @Claude");
    const evs = await core.readEvents(gpt, r.weave.id, { since: 0 });
    expect(evs.map((e) => e.type)).toEqual(["thread.created", "participant.joined", "message", "participant.joined", "message"]);
    expect(seen).toEqual([5]);
    expect(await core.getThreadWeaveId(r.generalThread.id)).toBe(r.weave.id);
    const me = await core.resolveCredential(r.token);
    await core.archiveWeave(me, r.weave.id);
    await expect(core.postMessage(gpt, r.generalThread.id, "late")).rejects.toBeInstanceOf(LoomError);
  });
  it("readEvents enforces read access", async () => {
    const a = await core.createWeave({ title: "A", opener: "a", creator: { name: "X", kind: "human" } });
    const b = await core.createWeave({ title: "B", opener: "b", creator: { name: "Y", kind: "human" } });
    const meA = await core.resolveCredential(a.token);
    await expect(core.readEvents(meA, b.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});
