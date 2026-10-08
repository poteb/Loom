export type Kind = "human" | "agent";
export type Role = "member" | "keeper";

export type Weave = { id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number; guidelines: string };
export type Thread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null; url: string | null;
};
export type Participant = {
  id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string; agentId: string | null;
  /**
   * The Lobby capability profile. Null everywhere but the Lobby — and null from `getWeave` **in**
   * the Lobby too: read a listener's profile with `listListeners` or `findAgents`, and your own
   * with `getMyLobbyParticipant`.
   */
  capabilities: Profile | null;
  /** When this participant last made a call, stamped by the server; null until the first. */
  lastSeenAt: string | null;
};

export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "thread.invited" | "thread.removed" | "thread.url_changed"
  | "weave.archived" | "weave.guidelines_changed"
  // Lobby. All of these are addressed-only: they never wake anyone through a Weave's "all events" mode.
  | "participant.capabilities_changed" | "listener.removed"
  | "request.opened" | "request.offered" | "request.offer_withdrawn" | "request.accepted" | "request.closed" | "request.completed" | "request.overdue"
  | "weave.invited" | "weave.invitation_withdrawn";
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
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean; guidelines: string;
  /** Milliseconds a Lobby Listener may go without a check-in before Loom removes its profile, once it also reads offline; null never removes. */
  removeOfflineListenersAfterMs: number | null };
export type Keeper = { id: string; name: string; createdAt: string };
export type Agent = { id: string; name: string; createdAt: string; revokedAt: string | null; owner: string | null };
export type InviteResult = { seq: number; created: boolean };
/** Read positions (spec 2026-09-26 §4), mirrored from core by hand like the rest of this file. */
export type MarkReadResult = { threadId: string; seq: number };
export type MarkAllReadResult = { seq: number; threads: number };
export type ReadPositions = { joinedSeq: number; threads: Record<string, number> };

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
  pollIntervalMs?: number;
  [k: string]: unknown;
};

/** What a request asks of a listener. `models` are alternatives; `tools` are all required. */
export type Requirements = {
  models?: { model: string; effort?: string }[];
  tools?: string[];
  runtime?: string;
  spawnsSubagents?: boolean;
  maxResponseMs?: number;
};

/**
 * A listener's status now (spec 2026-09-27 §4.2): offline when not seen within twice its
 * `pollIntervalMs` (15 minutes when none is declared), working when it holds accepted work on a
 * working request, otherwise idle. True as of the read that carried it.
 */
export type ListenerStatus = "working" | "idle" | "offline";
/** The request a listener is working on, the soonest due, and how many more. Names the request and its Lobby Thread only. */
export type CurrentWork = { requestId: string; title: string; threadId: string; more: number };
/** The median and longest gap between a listener's last 20 check-ins, in ms; both null with fewer than two. */
export type Cadence = { typicalGapMs: number | null; longestGapMs: number | null; samples: number };
/** The directory's per-status counts: all three words, zeros included. */
export type StatusCounts = { working: number; idle: number; offline: number };

/** A `requirements` filter, plus the owner whose requests the agent would have to serve. */
export type AgentFilter = Requirements & { owner?: string };
export type FoundAgent = {
  participant: Participant; capabilities: Profile;
  status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence;
};

/** One directory entry. Shaped like `FoundAgent` on purpose: the same fields, the same order. */
export type Listener = {
  participant: Participant; capabilities: Profile;
  status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence;
};

export type ListenersSort = "name" | "owner" | "joined";
export type ServesKind = "anyone" | "owner" | "list";

export type FacetValue = { value: string; count: number };
/** `efforts` is the model's top 10; `moreEfforts` says there are others. */
export type ModelFacet = { model: string; count: number; efforts: FacetValue[]; moreEfforts: boolean };

export type ListenersFacets = {
  models: { values: ModelFacet[]; more: boolean };
  tools: { values: FacetValue[]; more: boolean };
  runtimes: { values: FacetValue[]; more: boolean };
  /** Always the three kinds, always in this order, zeros included. `more` is always false. */
  serves: { values: FacetValue[]; more: boolean };
};

/** Every bound, default and normalisation behind these is core's; this is the shape alone. */
export type ListenersQuery = {
  /** Case-insensitive substring of the participant's name OR the profile's `owner`. */
  q?: string;
  /** Any-of, with an optional effort per alternative — the same shape as `Requirements.models`. */
  models?: { model: string; effort?: string }[];
  /** All-of. */
  tools?: string[];
  /** Equality. */
  runtime?: string;
  serves?: ServesKind;
  /** Any-of: working, idle, offline. An empty array is no filter. */
  status?: ListenerStatus[];
  sort?: ListenersSort;          // default "name"
  dir?: "asc" | "desc";          // default "asc"
  limit?: number;                // default 50, 0..1000
  cursor?: string;               // opaque; from a previous answer's nextCursor
  /** Default true. `false` skips the four facet queries for a caller that only wants the counts. */
  facets?: boolean;
};

export type ListenersPage = {
  /** Every listener in the Lobby, ignoring `q` and every filter. What the sidebar counts. */
  total: number;
  /** After the search and the filters. What the header counts. */
  matched: number;
  listeners: Listener[];
  /** Absent when this is the last page, and always absent when `limit` is 0. */
  nextCursor?: string;
  /** Absent only when the caller asked for `facets: false`. */
  facets?: ListenersFacets;
  /** Per-status counts over the search and every filter except `status`. Always present. */
  statusCounts: StatusCounts;
};

export type Lobby = {
  weaveId: string; title: string;
  /** The Lobby's own Weave secret — the read credential for `/w/<secret>`. Only an instance keeper's
   *  credential brings it back; it is absent for everyone else, including an anonymous caller. */
  secret?: string;
};

/** `filled` is legacy: rows closed that way before deadlines existed still read, and nothing writes it. */
export type RequestStatus = "open" | "working" | "completed" | "expired" | "cancelled" | "filled";

export type Offer = {
  requestId: string; participantId: string; model: string | null; effort: string | null;
  note: string | null; accepted: boolean; createdAt: string;
};

/** One accepted offer: its deadline, its completion or removal, whether it is overdue now, and liveness. */
export type Acceptance = {
  participantId: string; dueAt: string | null; completedAt: string | null; note: string | null;
  removed: boolean; removedAt: string | null; overdue: boolean; overdueNotifiedAt: string | null;
  lastSeenAt: string | null;
  /** The accepted listener's status now: not the acceptance's own state (that is `completedAt`, `removed`, `overdue`). */
  listenerStatus: ListenerStatus;
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
  acceptances: Acceptance[];
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
/** One invitation into a Weave that is neither redeemed nor withdrawn (spec 2026-10-08 §5.1). */
export type PendingInvitation = {
  invitationId: string; participantId: string; inviteeName: string; targetThreadId: string; targetThreadName: string;
  createdAt: string; createdBy: string; createdByName: string | null; requestId: string | null;
};
/** What a withdrawal answers (spec 2026-10-08 §4.1): `created` is false on a repeat, which carries the original seq. */
export type WithdrawResult = { invitationId: string; seq: number; withdrawnAt: string; created: boolean };
export type RemovalResult = { seq: number; created: boolean; acceptanceRemoved: boolean; targetRemoved: boolean };
