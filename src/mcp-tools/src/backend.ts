export class LoomToolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "LoomToolError"; }
}

export type Kind = "human" | "agent";
export type Role = "member" | "keeper";

export type LoomToolBackend = {
  createWeave(input: { title: string; opener: string; creator: { name: string; kind: Kind }; guidelines?: string }, credential?: string): Promise<unknown>; // CreateWeaveResult shape
  joinWeave(secret: string, who: { name?: string; kind: Kind }, credential?: string): Promise<unknown>;                     // JoinResult shape; credential: the connection's agent key, if any
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
};
