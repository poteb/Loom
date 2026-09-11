import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JoinResult, LoomClient, Participant, WeaveInfo } from "@loom/client";
import { ChannelState } from "../src/state.js";
import { ClientToolBackend } from "../src/backend.js";

const WEAVE_ID = "w1";
const SECRET = "s".repeat(43);
const TOKEN = "t".repeat(43);

function makeState(): ChannelState {
  return new ChannelState(mkdtempSync(path.join(tmpdir(), "loom-ch-")));
}

function participant(name: string): Participant {
  return { id: "p2", weaveId: WEAVE_ID, name, kind: "agent", role: "member", joinedAt: "" };
}

function weaveInfo(): WeaveInfo {
  return {
    weave: { id: WEAVE_ID, title: "Design review", createdAt: "", archivedAt: null, lastSeq: 0 },
    threads: [
      { id: "t1", weaveId: WEAVE_ID, name: "Side", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null },
      { id: "g1", weaveId: WEAVE_ID, name: "General", isGeneral: true, createdBy: "p1", createdAt: "", closedAt: null },
    ],
    participants: [],
  };
}

/** Fake LoomClient recording the order of the calls join_weave makes, so a test can assert that the
 * read-only metadata lookups happen *before* the irreversible join. */
function makeFakeClient(over: { getWeave?: () => Promise<WeaveInfo>; lookupWeave?: () => Promise<string> } = {}) {
  const calls: string[] = [];
  const joinWeave = vi.fn(async (): Promise<JoinResult> => {
    calls.push("joinWeave");
    return { weaveId: WEAVE_ID, weave: weaveInfo().weave, generalThreadId: "g1", participant: participant("Claude"), token: TOKEN };
  });
  const fake = {
    withToken: () => fake,
    lookupWeave: vi.fn(async () => { calls.push("lookupWeave"); return over.lookupWeave ? await over.lookupWeave() : WEAVE_ID; }),
    getWeave: vi.fn(async () => { calls.push("getWeave"); return over.getWeave ? await over.getWeave() : weaveInfo(); }),
    joinWeave,
  };
  return { client: fake as unknown as LoomClient, calls, joinWeave };
}

describe("ClientToolBackend.joinWeave", () => {
  it("reads the Weave metadata with the secret before joining, and persists the token immediately after", async () => {
    const state = makeState();
    const onJoined = vi.fn();
    const { client, calls, joinWeave } = makeFakeClient();
    const backend = new ClientToolBackend(client, state, { onJoined });

    const r = await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" });

    expect(r.token).toBe(TOKEN);
    // The irreversible step runs last: a failure in either metadata call must not burn a join.
    expect(calls.indexOf("joinWeave")).toBe(calls.length - 1);
    expect(calls).toContain("lookupWeave");
    expect(calls).toContain("getWeave");
    expect(joinWeave).toHaveBeenCalledTimes(1);
    expect(state.get().weaves[WEAVE_ID]).toEqual({
      title: "Design review", token: TOKEN, participantId: "p2", participantName: "Claude",
      generalThreadId: "g1", wake: "all", lastSeq: 0,
    });
    expect(onJoined).toHaveBeenCalledWith(WEAVE_ID, state.get().weaves[WEAVE_ID]);
  });

  it("never joins when the pre-join metadata call fails, so the secret can be retried without name_taken", async () => {
    const state = makeState();
    const onJoined = vi.fn();
    const { client, joinWeave } = makeFakeClient({ getWeave: async () => { throw new Error("metadata boom"); } });
    const backend = new ClientToolBackend(client, state, { onJoined });

    await expect(backend.joinWeave(SECRET, { name: "Claude", kind: "agent" })).rejects.toThrow("metadata boom");
    expect(joinWeave).not.toHaveBeenCalled();
    expect(state.get().weaves).toEqual({});
    expect(onJoined).not.toHaveBeenCalled();
  });

  it("returns the stored identity instead of joining again when already joined under that name", async () => {
    const state = makeState();
    const stored = { title: "Design review", token: "stored-token", participantId: "p9", participantName: "Claude", generalThreadId: "g1", wake: "all" as const, lastSeq: 7 };
    state.upsertWeave(WEAVE_ID, stored);
    const onJoined = vi.fn();
    const { client, joinWeave, calls } = makeFakeClient({
      getWeave: async () => ({ ...weaveInfo(), participants: [{ ...participant("Claude"), id: "p9" }] }),
    });
    const backend = new ClientToolBackend(client, state, { onJoined });

    const r = await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" }) as { weaveId: string; token: string; generalThreadId: string; participant: { id: string; name: string }; alreadyJoined?: boolean };

    expect(joinWeave).not.toHaveBeenCalled();
    expect(calls).toEqual(["lookupWeave", "getWeave"]);
    expect(r).toMatchObject({ weaveId: WEAVE_ID, token: "stored-token", generalThreadId: "g1", participant: { id: "p9", name: "Claude" }, alreadyJoined: true });
    expect(state.get().weaves[WEAVE_ID]).toEqual(stored); // cursor and wake untouched
    expect(onJoined).toHaveBeenCalledWith(WEAVE_ID, stored); // re-arms the stream
  });

  it("joins afresh when the stored identity no longer works (participant gone or token rejected)", async () => {
    const state = makeState();
    state.upsertWeave(WEAVE_ID, { title: "Design review", token: "dead-token", participantId: "p9", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 7 });
    const { client, joinWeave } = makeFakeClient(); // getWeave() default: participants: [] -> p9 is gone
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });

    const r = await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" }) as { token: string };
    expect(joinWeave).toHaveBeenCalledTimes(1);
    expect(r.token).toBe(TOKEN);
    expect(state.get().weaves[WEAVE_ID]!.token).toBe(TOKEN);
  });

  it("does not persist the Weave secret — the participant token is the stored credential", async () => {
    const state = makeState();
    const { client } = makeFakeClient();
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });
    await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" });
    expect(JSON.stringify(state.get())).not.toContain(SECRET);
  });
});
