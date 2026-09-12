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
  const keeperOnly = (credential: string) => {
    if (credential === STORED) throw new LoomToolError("validation", "Keeper tools need an explicit keeper token");
    return credential;
  };
  // Wrapped as `async` so a synchronous LoomToolError from byWeave/byThread/keeperOnly becomes a rejected
  // promise (caught by mcp-tools' toToolResult and formatted as { code, message } JSON) rather than an
  // exception thrown out of the tool handler before that catch is even installed.
  return {
    createWeave: (input, credential) => inner.createWeave(input, credential === STORED ? undefined : credential),
    joinWeave: (s, who, cred) => inner.joinWeave(s, who, cred),
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
    keeperAgentsAdd: async (c, n) => inner.keeperAgentsAdd(keeperOnly(c), n),
    keeperAgentsRevoke: async (c, id) => inner.keeperAgentsRevoke(keeperOnly(c), id),
  };
}
