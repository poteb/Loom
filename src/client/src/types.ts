export type Kind = "human" | "agent";
export type Role = "member" | "keeper";

export type Weave = { id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number; guidelines: string };
export type Thread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null; url: string | null;
};
export type Participant = {
  id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string; agentId: string | null;
  /** The Lobby capability profile. Null everywhere but the Lobby, and there until one is set. */
  capabilities: Profile | null;
};

export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "thread.invited" | "thread.url_changed"
  | "weave.archived" | "weave.guidelines_changed"
  // Lobby. All of these are addressed-only: they never wake anyone through a Weave's "all events" mode.
  | "participant.capabilities_changed"
  | "request.opened" | "request.offered" | "request.accepted" | "request.closed"
  | "weave.invited";
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

// ---------------------------------------------------------------------------
// Lobby. A hand-written mirror of core's public shapes: the client does not
// depend on @loom/core at runtime, so these are kept in step with it by hand.
// ---------------------------------------------------------------------------

/** One model a listener offers, at the effort it offers it at. */
export type ModelSpec = { model: string; effort: string };

/** A listener's self-declared Lobby capabilities. Open-ended: unknown keys are carried, never matched on. */
export type Profile = {
  models?: ModelSpec[];
  tools?: string[];
  runtime?: string;
  spawnsSubagents?: boolean;
  owner?: string;
  serves?: "owner" | "anyone" | string[];
  [k: string]: unknown;
};

/** What a request asks of a listener. `models` are alternatives; `tools` are all required. */
export type Requirements = {
  models?: { model: string; effort?: string }[];
  tools?: string[];
  runtime?: string;
  spawnsSubagents?: boolean;
};

/** A `requirements` filter, plus the owner whose requests the agent would have to serve. */
export type AgentFilter = Requirements & { owner?: string };
export type FoundAgent = { participant: Participant; capabilities: Profile };
export type Lobby = {
  weaveId: string; title: string;
  /** The Lobby's own Weave secret — the read credential for `/w/<secret>`. Only an instance keeper's
   *  credential brings it back; it is absent for everyone else, including an anonymous caller. */
  secret?: string;
};

export type RequestStatus = "open" | "filled" | "expired" | "cancelled";

export type Offer = {
  requestId: string; participantId: string; model: string | null; effort: string | null;
  note: string | null; accepted: boolean; createdAt: string;
};

/** Named `LoomRequest` rather than `Request`, which is the DOM's. */
export type LoomRequest = {
  id: string; threadId: string; requesterId: string; owner: string; requirements: Requirements;
  wanted: number; targetWeaveId: string; targetWeaveTitle: string; targetThreadId: string;
  url: string | null; status: RequestStatus; expiresAt: string; closedAt: string | null;
  lastEventSeq: number; createdAt: string;
  /** The listeners the request was addressed to, snapshotted when it opened. */
  eligible?: string[];
  offers: Offer[];
};

export type OpenRequestInput = {
  title: string; requirements: Requirements; wanted?: number; timeoutMs?: number;
  targetWeaveId: string; targetThreadId: string; url?: string | null;
  /**
   * A credential for the **target** Weave: a keeper participant token there, or an instance keeper
   * token. Optional only when this client's own token is an agent key, which is one actor
   * everywhere and so proves both the Lobby identity and the target authority.
   */
  targetCredential?: string;
};

export type AcceptResult = { request: LoomRequest; invitationIds: string[] };
export type InvitationResult = { invitationId: string; seq: number };
