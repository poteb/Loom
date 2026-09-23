import { LoomClientError } from "@loom/client";
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
  return { id: "p2", weaveId: WEAVE_ID, name, kind: "agent", role: "member", joinedAt: "", agentId: null, capabilities: null, lastSeenAt: null };
}

function weaveInfo(): WeaveInfo {
  return {
    weave: { id: WEAVE_ID, title: "Design review", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
    threads: [
      { id: "t1", weaveId: WEAVE_ID, name: "Side", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null, url: null },
      { id: "g1", weaveId: WEAVE_ID, name: "General", isGeneral: true, createdBy: "p1", createdAt: "", closedAt: null, url: null },
    ],
    participants: [],
    guidelines: "",
  };
}

/** Fake LoomClient recording the order of the calls join_weave makes, so a test can assert that the
 * read-only metadata lookups happen *before* the irreversible join. */
function makeFakeClient(over: {
  getWeave?: () => Promise<WeaveInfo>; lookupWeave?: () => Promise<string>; getLobby?: () => Promise<{ weaveId: string; title: string }>;
} = {}) {
  const calls: string[] = [];
  const joinWeave = vi.fn(async (): Promise<JoinResult> => {
    calls.push("joinWeave");
    return { weaveId: WEAVE_ID, weave: weaveInfo().weave, generalThreadId: "g1", participant: participant("Claude"), token: TOKEN, guidelines: "" };
  });
  // Some other Weave is the Lobby by default, so an ordinary join is not mistaken for one.
  const joinLobby = vi.fn(async (): Promise<JoinResult> => {
    calls.push("joinLobby");
    return { weaveId: WEAVE_ID, weave: weaveInfo().weave, generalThreadId: "g1", participant: participant("Claude"), token: TOKEN, guidelines: "" };
  });
  const fake = {
    withToken: () => fake,
    lookupWeave: vi.fn(async () => { calls.push("lookupWeave"); return over.lookupWeave ? await over.lookupWeave() : WEAVE_ID; }),
    getWeave: vi.fn(async () => { calls.push("getWeave"); return over.getWeave ? await over.getWeave() : weaveInfo(); }),
    // Deliberately not recorded in `calls`: those assertions are about the join sequence itself.
    getLobby: vi.fn(async () => (over.getLobby ? await over.getLobby() : { weaveId: "lobby-elsewhere", title: "Lobby" })),
    joinWeave, joinLobby,
  };
  return { client: fake as unknown as LoomClient, calls, joinWeave, joinLobby };
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
    await state.upsertWeave(WEAVE_ID, stored);
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

  it("carries the Weave's current combined guidelines on the reused identity", async () => {
    const state = makeState();
    await state.upsertWeave(WEAVE_ID, { title: "Design review", token: "stored-token", participantId: "p9", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 7 });
    const combined = "## Loom guidelines\nbe terse\n\n## Guidelines for this Weave\none finding per message";
    const { client } = makeFakeClient({
      getWeave: async () => ({ ...weaveInfo(), participants: [{ ...participant("Claude"), id: "p9" }], guidelines: combined }),
    });
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });

    const r = await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" }) as { alreadyJoined?: boolean; guidelines: string };

    // reuseStored builds its own join response; the rules an agent must read cannot go missing on
    // the very path a restored session takes.
    expect(r).toMatchObject({ alreadyJoined: true, guidelines: combined });
  });

  it("matches the stored name the way the server does: case-insensitively and trimmed", async () => {
    const state = makeState();
    await state.upsertWeave(WEAVE_ID, { title: "Design review", token: "stored-token", participantId: "p9", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 7 });
    const { client, joinWeave } = makeFakeClient({ getWeave: async () => ({ ...weaveInfo(), participants: [{ ...participant("Claude"), id: "p9" }] }) });
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });
    const r = await backend.joinWeave(SECRET, { name: " claude ", kind: "agent" }) as { alreadyJoined?: boolean; token: string };
    expect(joinWeave).not.toHaveBeenCalled();
    expect(r).toMatchObject({ alreadyJoined: true, token: "stored-token" });
  });

  it("joins afresh when the stored identity no longer works (participant gone or token rejected)", async () => {
    const state = makeState();
    await state.upsertWeave(WEAVE_ID, { title: "Design review", token: "dead-token", participantId: "p9", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 7 });
    const { client, joinWeave } = makeFakeClient(); // getWeave() default: participants: [] -> p9 is gone
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });

    const r = await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" }) as { token: string };
    expect(joinWeave).toHaveBeenCalledTimes(1);
    expect(r.token).toBe(TOKEN);
    expect(state.get().weaves[WEAVE_ID]!.token).toBe(TOKEN);
  });

  it("does not treat a transient error while validating the stored identity as proof it is dead", async () => {
    const state = makeState();
    await state.upsertWeave(WEAVE_ID, { title: "Design review", token: "stored-token", participantId: "p9", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 7 });
    let calls = 0;
    const { client, joinWeave } = makeFakeClient({ getWeave: async () => { if (++calls === 1) throw new LoomClientError("network", "socket hang up"); return weaveInfo(); } });
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });

    await expect(backend.joinWeave(SECRET, { name: "Claude", kind: "agent" })).rejects.toMatchObject({ code: "network" });
    expect(joinWeave).not.toHaveBeenCalled(); // a fresh join here would burn the name and fail with name_taken
  });

  it("falls through to a fresh join when the stored token is definitively rejected", async () => {
    const state = makeState();
    await state.upsertWeave(WEAVE_ID, { title: "Design review", token: "dead-token", participantId: "p9", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 7 });
    let calls = 0;
    const { client, joinWeave } = makeFakeClient({ getWeave: async () => { if (++calls === 1) throw new LoomClientError("invalid_token", "nope"); return weaveInfo(); } });
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });
    const r = await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" }) as { token: string };
    expect(joinWeave).toHaveBeenCalledTimes(1);
    expect(r.token).toBe(TOKEN);
  });

  it("recovers from name_taken when another process stored the identity in the meantime", async () => {
    const state = makeState();
    const { client, joinWeave, calls } = makeFakeClient({
      getWeave: async () => ({ ...weaveInfo(), participants: [{ ...participant("Claude"), id: "p9" }] }),
    });
    // The server-side join loses the race: by the time it answers, a sibling process has joined
    // under this name and persisted the identity to the shared state file.
    joinWeave.mockImplementationOnce(async () => {
      calls.push("joinWeave");
      const sibling = new ChannelState(state.dir, "other-session");
      await sibling.upsertWeave(WEAVE_ID, { title: "Design review", token: "sibling-token", participantId: "p9", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 0 });
      throw new LoomClientError("name_taken", "Claude is taken");
    });
    const onJoined = vi.fn();
    const backend = new ClientToolBackend(client, state, { onJoined });

    const r = await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" }) as { token: string; alreadyJoined?: boolean };
    expect(r).toMatchObject({ token: "sibling-token", alreadyJoined: true });
    expect(onJoined).toHaveBeenCalledTimes(1);
  });

  it("still reports name_taken when the name belongs to someone else entirely", async () => {
    const state = makeState();
    const { client, joinWeave } = makeFakeClient();
    joinWeave.mockImplementationOnce(async () => { throw new LoomClientError("name_taken", "Claude is taken"); });
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });
    await expect(backend.joinWeave(SECRET, { name: "Claude", kind: "agent" })).rejects.toMatchObject({ code: "name_taken" });
  });

  it("does not persist the Weave secret — the participant token is the stored credential", async () => {
    const state = makeState();
    const { client } = makeFakeClient();
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });
    await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" });
    expect(JSON.stringify(state.get())).not.toContain(SECRET);
  });
});

/**
 * The Lobby is recognised on every join path, not only through `join_lobby`. The flag is what makes
 * `leave_weave` clear the profile before it drops the credential (spec 5), so an identity that
 * reached the Lobby by secret must carry it too.
 */
describe("ClientToolBackend and the Lobby", () => {
  const asClaude = async () => ({ ...weaveInfo(), participants: [{ ...participant("Claude"), id: "p2" }] });
  const storedClaude = { title: "Design review", token: "stored-token", participantId: "p2", participantName: "Claude", generalThreadId: "g1", wake: "all" as const, lastSeq: 7 };

  it("marks a Weave joined by its secret as the Lobby when it is the Lobby", async () => {
    const state = makeState();
    const { client } = makeFakeClient({ getLobby: async () => ({ weaveId: WEAVE_ID, title: "Lobby" }) });
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });

    await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" });

    expect(state.get().weaves[WEAVE_ID]).toMatchObject({ token: TOKEN, isLobby: true });
  });

  it("still joins by secret when the Lobby pointer cannot be read", async () => {
    const state = makeState();
    const { client } = makeFakeClient({ getLobby: async () => { throw new LoomClientError("network", "fetch failed"); } });
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });

    const r = await backend.joinWeave(SECRET, { name: "Claude", kind: "agent" }) as { token: string };

    expect(r.token).toBe(TOKEN);                     // the join stands…
    expect(state.get().weaves[WEAVE_ID]!.isLobby).toBeUndefined();   // …simply unflagged
  });

  it("upgrades a stored entry that lacks the flag when join_lobby reuses it", async () => {
    const state = makeState();
    await state.upsertWeave(WEAVE_ID, storedClaude);   // joined by secret, before anything knew it was the Lobby
    const { client, joinLobby } = makeFakeClient({ getWeave: asClaude, getLobby: async () => ({ weaveId: WEAVE_ID, title: "Lobby" }) });
    const backend = new ClientToolBackend(client, state, { onJoined: vi.fn() });

    const r = await backend.joinLobby({ name: "Claude", kind: "agent" }) as { alreadyJoined?: boolean; token: string };

    expect(joinLobby).not.toHaveBeenCalled();        // the reuse branch, which used to return unflagged
    expect(r).toMatchObject({ alreadyJoined: true, token: "stored-token" });
    expect(state.get().weaves[WEAVE_ID]).toMatchObject({ token: "stored-token", lastSeq: 7, isLobby: true });
  });
});
