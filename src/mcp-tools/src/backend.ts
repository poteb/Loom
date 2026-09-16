export class LoomToolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "LoomToolError"; }
}

export type Kind = "human" | "agent";
export type Role = "member" | "keeper";

/** `join_weave`'s secret-less path: with an `inviteId` the invitation says which Weave, and the
 *  caller's own credential proves it is the invitee, so `secret` is ignored and may be empty. */
export type JoinWeaveOptions = { inviteId?: string };

/**
 * What `open_request` carries. `requirements` stays opaque — core owns its shape — and
 * `targetCredential` is a credential for the **target** Weave, whose meaning the host decides:
 * remote `/mcp` resolves it as a credential, the Claude Code channel also understands `"stored"`.
 * Optional, because an agent key is one actor everywhere and stands for both.
 */
export type OpenRequestInput = {
  title: string; requirements: unknown; wanted?: number; timeoutMs?: number;
  targetWeaveId: string; targetThreadId: string; url?: string | null;
  targetCredential?: string;
};

export type OfferInput = { model?: string; effort?: string; note?: string };

export type LoomToolBackend = {
  createWeave(input: { title: string; opener: string; creator: { name: string; kind: Kind }; guidelines?: string }, credential?: string): Promise<unknown>; // CreateWeaveResult shape
  joinWeave(secret: string, who: { name?: string; kind: Kind }, credential?: string, opts?: JoinWeaveOptions): Promise<unknown>; // JoinResult shape; credential: the connection's agent key, if any
  lookupWeave(secret: string): Promise<{ weaveId: string }>;
  getWeave(credential: string, weaveId: string): Promise<unknown>;
  readEvents(credential: string, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }): Promise<unknown[]>;
  postMessage(credential: string, threadId: string, text: string): Promise<unknown>;
  createThread(credential: string, weaveId: string, name: string, url?: string | null): Promise<unknown>;
  setThreadUrl(credential: string, threadId: string, url: string | null): Promise<unknown>;
  inviteParticipant(credential: string, threadId: string, participantId: string): Promise<unknown>;      // { seq, created }
  inbox(credential: string, weaveId: string, opts: { since?: number; limit?: number }): Promise<unknown[]>;
  closeThread(credential: string, threadId: string): Promise<void>;
  archiveWeave(credential: string, weaveId: string): Promise<void>;
  setRole(credential: string, weaveId: string, participantId: string, role: Role): Promise<unknown>;
  exportWeave(credential: string, weaveId: string, format: "md" | "json"): Promise<string>;
  keeperListWeaves(credential: string): Promise<unknown[]>;
  keeperGetSettings(credential: string): Promise<unknown>;
  keeperSetSettings(credential: string, patch: Record<string, unknown>): Promise<unknown>;
  keeperList(credential: string): Promise<unknown[]>;
  keeperAdd(credential: string, name: string): Promise<unknown>;
  keeperRemove(credential: string, id: string): Promise<void>;
  keeperAgentsList(credential: string): Promise<unknown[]>;
  keeperAgentsAdd(credential: string, name: string): Promise<unknown>;                                   // { agent, key }
  keeperAgentsRevoke(credential: string, id: string): Promise<void>;
  setWeaveGuidelines(credential: string, weaveId: string, guidelines: string): Promise<unknown>;         // { weave, seq }
  /** Public: the instance text is read before a connection has any credential. */
  getInstanceGuidelines(): Promise<string>;
  /** The combined text (instance layer then Weave layer) for one Weave; same authority as getWeave. */
  getGuidelines(credential: string, weaveId: string): Promise<string>;

  // --- Lobby ---------------------------------------------------------------
  // One method per Lobby tool, named after the client wrappers, plus `getLobby`: no tool calls it,
  // but the `loom://lobby/requests` resource needs the Lobby's weaveId to ask the surface for a
  // credential for it (`resourceCredential`), the same way the per-Weave guidelines read does.
  /** Public: where the Lobby is, answered before the caller holds any credential. */
  getLobby(): Promise<unknown>;                                                                          // { weaveId, title }
  /** Secret-less join of the instance's one Lobby; `credential` is the connection's agent key, if any. */
  joinLobby(who: { name?: string; kind: Kind }, credential?: string): Promise<unknown>;                  // JoinResult shape
  /** The caller's own Lobby profile; `null` clears it. */
  setCapabilities(credential: string, profile: unknown): Promise<unknown>;                               // Participant shape
  findAgents(credential: string, filter: Record<string, unknown>): Promise<unknown[]>;                   // [{ participant, capabilities }]
  openRequest(credential: string, input: OpenRequestInput): Promise<unknown>;                            // Request shape
  listRequests(credential: string, opts: { status?: string }): Promise<unknown[]>;
  getRequest(credential: string, requestId: string): Promise<unknown>;
  offer(credential: string, requestId: string, input: OfferInput): Promise<unknown>;
  acceptRequest(credential: string, requestId: string, participantIds: string[]): Promise<unknown>;      // { request, invitationIds }
  cancelRequest(credential: string, requestId: string): Promise<unknown>;
  inviteToWeave(credential: string, participantId: string, targetWeaveId: string, targetThreadId: string): Promise<unknown>; // { invitationId, seq }
};
