export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "thread.invited" | "thread.url_changed" | "weave.archived";

export type LoomEvent = {
  weaveId: string; seq: number; threadId: string; type: EventType;
  actor: string; at: string; payload: Record<string, unknown>;
};

export type Role = "member" | "keeper";
export type Kind = "human" | "agent";

export type PublicParticipant = {
  id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string; agentId: string | null;
};
export type PublicThread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null; url: string | null;
};
export type PublicWeave = {
  id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number;
};
export type PublicAgent = { id: string; name: string; createdAt: string; revokedAt: string | null };

export type Actor =
  | { kind: "participant"; participant: PublicParticipant }
  | { kind: "keeper"; keeperId: string; name: string }
  | { kind: "secret"; weaveId: string }
  | { kind: "agent"; agent: PublicAgent };

export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean };
