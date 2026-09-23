import type { LoomToolBackend } from "@loom/mcp-tools";
import { LoomToolError } from "@loom/mcp-tools";
import type { ChannelState } from "./state.js";

const STORED = "stored";

/** Wraps a backend so credential "stored" resolves to the saved token for the target Weave (by weaveId, or by threadId via the joined Weaves' known threads). */
export function withStoredCredential(inner: LoomToolBackend, state: ChannelState, threadOwner: (threadId: string) => string | undefined): LoomToolBackend {
  const byWeave = (credential: string, weaveId: string) => {
    if (credential !== STORED) return credential;
    const w = state.get().weaves[weaveId];
    if (!w) throw new LoomToolError("no_weave", `Not joined to Weave ${weaveId}; pass an explicit credential`);
    return w.token;
  };
  const byThread = (credential: string, threadId: string) => {
    if (credential !== STORED) return credential;
    const weaveId = threadOwner(threadId);
    if (!weaveId) throw new LoomToolError("no_weave", "Unknown thread for the stored credential; pass weaveId-based tools first or an explicit credential");
    return byWeave(STORED, weaveId);
  };
  /** What `"stored"` means for a Lobby tool: the token this machine holds in the Lobby. The Lobby
   * is one Weave per instance, so none of those tools names one to resolve against. */
  const byLobby = (credential: string) => {
    if (credential !== STORED) return credential;
    const lobby = state.lobbyEntry();
    if (!lobby) throw new LoomToolError("no_weave", "Not joined to the Lobby; call join_lobby first, or pass an explicit credential");
    return lobby.weave.token;
  };
  const keeperOnly = (credential: string) => {
    if (credential === STORED) throw new LoomToolError("validation", "Keeper tools need an explicit keeper token");
    return credential;
  };
  // Wrapped as `async` so a synchronous LoomToolError from byWeave/byThread/keeperOnly becomes a rejected
  // promise (caught by mcp-tools' toToolResult and formatted as { code, message } JSON) rather than an
  // exception thrown out of the tool handler before that catch is even installed.
  return {
    createWeave: (input, credential) => inner.createWeave(input, credential === STORED ? undefined : credential),
    joinWeave: (s, who, cred, opts) => inner.joinWeave(s, who, cred, opts),
    lookupWeave: (s) => inner.lookupWeave(s),
    getWeave: async (c, w) => inner.getWeave(byWeave(c, w), w),
    readEvents: async (c, w, o) => inner.readEvents(byWeave(c, w), w, o),
    inbox: async (c, w, o) => inner.inbox(byWeave(c, w), w, o),
    postMessage: async (c, t, text) => inner.postMessage(byThread(c, t), t, text),
    createThread: async (c, w, n, u) => inner.createThread(byWeave(c, w), w, n, u),
    setThreadUrl: async (c, t, u) => inner.setThreadUrl(byThread(c, t), t, u),
    inviteParticipant: async (c, t, p) => inner.inviteParticipant(byThread(c, t), t, p),
    closeThread: async (c, t) => inner.closeThread(byThread(c, t), t),
    archiveWeave: async (c, w) => inner.archiveWeave(byWeave(c, w), w),
    setRole: async (c, w, p, r) => inner.setRole(byWeave(c, w), w, p, r),
    exportWeave: async (c, w, f) => inner.exportWeave(byWeave(c, w), w, f),
    keeperListWeaves: async (c) => inner.keeperListWeaves(keeperOnly(c)),
    keeperGetSettings: async (c) => inner.keeperGetSettings(keeperOnly(c)),
    keeperSetSettings: async (c, p) => inner.keeperSetSettings(keeperOnly(c), p),
    keeperList: async (c) => inner.keeperList(keeperOnly(c)),
    keeperAdd: async (c, n) => inner.keeperAdd(keeperOnly(c), n),
    keeperRemove: async (c, id) => inner.keeperRemove(keeperOnly(c), id),
    keeperAgentsList: async (c) => inner.keeperAgentsList(keeperOnly(c)),
    keeperAgentsAdd: async (c, n, o) => inner.keeperAgentsAdd(keeperOnly(c), n, o),
    keeperAgentsRevoke: async (c, id) => inner.keeperAgentsRevoke(keeperOnly(c), id),
    keeperAgentsSetOwner: async (c, id, o) => inner.keeperAgentsSetOwner(keeperOnly(c), id, o),
    setWeaveGuidelines: async (c, w, g) => inner.setWeaveGuidelines(byWeave(c, w), w, g),
    getInstanceGuidelines: () => inner.getInstanceGuidelines(),
    getGuidelines: async (c, w) => inner.getGuidelines(byWeave(c, w), w),
    // Lobby tools. `"stored"` is the Lobby's own token for everything that acts *in* the Lobby;
    // the two exceptions are the ones whose authority lies in another Weave and say so by naming it.
    getLobby: () => inner.getLobby(),
    // Nothing to resolve: there is no stored Lobby identity until this call creates one, and the
    // Lobby needs no secret. The backend persists what comes back.
    joinLobby: (who, cred) => inner.joinLobby(who, cred === STORED ? undefined : cred),
    setCapabilities: async (c, profile) => inner.setCapabilities(byLobby(c), profile),
    findAgents: async (c, filter) => inner.findAgents(byLobby(c), filter),
    // Two credentials: the caller's Lobby identity, and its authority in the target Weave —
    // `"stored"` there is the token stored for `targetWeaveId`, not the Lobby's.
    openRequest: async (c, input) => inner.openRequest(byLobby(c), {
      ...input,
      targetCredential: input.targetCredential === undefined ? undefined : byWeave(input.targetCredential, input.targetWeaveId),
    }),
    listRequests: async (c, o) => inner.listRequests(byLobby(c), o),
    getRequest: async (c, id) => inner.getRequest(byLobby(c), id),
    offer: async (c, id, input) => inner.offer(byLobby(c), id, input),
    acceptRequest: async (c, id, ids, d) => inner.acceptRequest(byLobby(c), id, ids, d),
    cancelRequest: async (c, id) => inner.cancelRequest(byLobby(c), id),
    // The accepted agent's own Lobby identity is what completes.
    completeRequest: async (c, id, note) => inner.completeRequest(byLobby(c), id, note),
    // Authority in the Thread's own Weave: the Lobby's token for a request Thread, the Weave's otherwise.
    removeParticipant: async (c, t, p) => inner.removeParticipant(byThread(c, t), t, p),
    // Keeper authority in the *target* Weave, which this one does name.
    inviteToWeave: async (c, p, w, t) => inner.inviteToWeave(byWeave(c, w), p, w, t),
  };
}
