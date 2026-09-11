export class LoomToolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "LoomToolError"; }
}

export type Kind = "human" | "agent";
export type Role = "member" | "keeper";

export type LoomToolBackend = {
  createWeave(input: { title: string; opener: string; creator: { name: string; kind: Kind } }, credential?: string): Promise<unknown>; // CreateWeaveResult shape
  joinWeave(secret: string, who: { name: string; kind: Kind }): Promise<unknown>;                                          // JoinResult shape
  lookupWeave(secret: string): Promise<{ weaveId: string }>;
  getWeave(credential: string, weaveId: string): Promise<unknown>;
  readEvents(credential: string, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }): Promise<unknown[]>;
  postMessage(credential: string, threadId: string, text: string): Promise<unknown>;
  createThread(credential: string, weaveId: string, name: string): Promise<unknown>;
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
};
