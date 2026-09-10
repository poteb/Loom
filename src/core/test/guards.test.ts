import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { createCore, type Core } from "../src/index.js";
import { withWeaveLock } from "../src/events.js";

afterAll(closeTestDb);
let core: Core;
beforeEach(async () => { core = createCore(await freshDb()); });

const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

describe("keeper authority is re-checked inside the weave lock", () => {
  it("rejects a demoted weave keeper holding a stale Actor", async () => {
    const r = await core.createWeave(input);
    const stale = await core.resolveCredential(r.token);          // snapshot says role=keeper
    const j = await core.joinWeave(r.secret, { name: "M", kind: "human" });
    await core.setRole(stale, r.weave.id, j.participant.id, "keeper");
    const other = await core.resolveCredential(j.token);
    await core.setRole(other, r.weave.id, r.participant.id, "member"); // demote the stale actor
    await expect(core.archiveWeave(stale, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a removed instance keeper holding a stale Actor", async () => {
    const r = await core.createWeave(input);
    const creator = await core.resolveCredential(r.token);
    const thread = await core.createThread(creator, r.weave.id, "Design");
    await core.seedKeepers([keeperToken("k1"), keeperToken("k2")]);
    const stale = await core.resolveCredential(keeperToken("k1"));
    const k2 = await core.resolveCredential(keeperToken("k2"));
    const k1Id = (stale as { keeperId: string }).keeperId;
    await core.removeKeeper(k2, k1Id);
    await expect(core.closeThread(stale, thread.id)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects a demoted weave keeper calling setRole with a stale Actor", async () => {
    const r = await core.createWeave(input);
    const stale = await core.resolveCredential(r.token);
    const j = await core.joinWeave(r.secret, { name: "M", kind: "human" });
    await core.setRole(stale, r.weave.id, j.participant.id, "keeper");
    const other = await core.resolveCredential(j.token);
    await core.setRole(other, r.weave.id, r.participant.id, "member");
    await expect(core.setRole(stale, r.weave.id, j.participant.id, "member")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("malformed uuids do not reach postgres", () => {
  it("getWeave, readEvents, archiveWeave, createThread → weave_not_found", async () => {
    const r = await core.createWeave(input);
    const creator = await core.resolveCredential(r.token);
    await core.seedKeepers([keeperToken("k")]);
    const k = await core.resolveCredential(keeperToken("k"));
    await expect(core.getWeave(k, "not-a-uuid")).rejects.toMatchObject({ code: "weave_not_found" });
    await expect(core.readEvents(k, "not-a-uuid", {})).rejects.toMatchObject({ code: "weave_not_found" });
    await expect(core.archiveWeave(k, "not-a-uuid")).rejects.toMatchObject({ code: "weave_not_found" });
    await expect(core.createThread(creator, "not-a-uuid", "X")).rejects.toMatchObject({ code: "weave_not_found" });
  });

  it("withWeaveLock → weave_not_found", async () => {
    await expect(withWeaveLock(core.db, core.bus, "not-a-uuid", async () => ({ result: 1, events: [] })))
      .rejects.toMatchObject({ code: "weave_not_found" });
  });

  it("getThread → thread_not_found", async () => {
    const r = await core.createWeave(input);
    const creator = await core.resolveCredential(r.token);
    await expect(core.postMessage(creator, "not-a-uuid", "hi")).rejects.toMatchObject({ code: "thread_not_found" });
    await expect(core.getThreadWeaveId("not-a-uuid")).rejects.toMatchObject({ code: "thread_not_found" });
    await expect(core.closeThread(creator, "not-a-uuid")).rejects.toMatchObject({ code: "thread_not_found" });
  });

  it("setRole participantId and removeKeeper id → validation", async () => {
    const r = await core.createWeave(input);
    const creator = await core.resolveCredential(r.token);
    await core.seedKeepers([keeperToken("k")]);
    const k = await core.resolveCredential(keeperToken("k"));
    await expect(core.setRole(creator, r.weave.id, "not-a-uuid", "keeper")).rejects.toMatchObject({ code: "validation" });
    await expect(core.removeKeeper(k, "not-a-uuid")).rejects.toMatchObject({ code: "validation" });
  });
});
