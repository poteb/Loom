export type Kind = "human" | "agent";
export type Role = "member" | "keeper";

export type Weave = { id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number; guidelines: string };
export type Thread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null; url: string | null;
};
export type Participant = { id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string; agentId: string | null };

export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "thread.invited" | "thread.url_changed"
  | "weave.archived" | "weave.guidelines_changed";
export type LoomEvent = {
  weaveId: string; seq: number; threadId: string; type: EventType;
  actor: string; at: string; payload: Record<string, unknown>;
};

/** An inbox entry: the event plus the Thread it belongs to, so one call is enough to act on it. */
export type InboxItem = LoomEvent & { threadName: string; threadUrl: string | null };

// `guidelines` on these three results is the combined text an agent should read (the instance
// layer then the Weave layer); `weave.guidelines` beside it is this Weave's layer alone.
export type WeaveInfo = { weave: Weave; threads: Thread[]; participants: Participant[]; guidelines: string };
export type CreateWeaveInput = { title: string; opener: string; creator: { name: string; kind: Kind }; guidelines?: string };
export type CreateWeaveResult = { weave: Weave; secret: string; participant: Participant; token: string; generalThread: Thread; guidelines: string };
export type JoinResult = { weaveId: string; weave: Weave; generalThreadId: string; participant: Participant; token: string; alreadyJoined?: boolean; guidelines: string };
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean; guidelines: string };
export type Keeper = { id: string; name: string; createdAt: string };
export type Agent = { id: string; name: string; createdAt: string; revokedAt: string | null };
export type InviteResult = { seq: number; created: boolean };
