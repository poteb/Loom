import type { Profile } from "./lobby/matching.js";

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

export type Role = "member" | "keeper";
export type Kind = "human" | "agent";

export type PublicParticipant = {
  id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string; agentId: string | null;
  /**
   * The Lobby capability profile. Null everywhere but the Lobby — and null from `getWeave` **in**
   * the Lobby too: read a listener's profile with `listListeners` or `findAgents`, and your own
   * with `getMyLobbyParticipant`.
   */
  capabilities: Profile | null;
};
export type PublicThread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null; url: string | null;
};
export type PublicWeave = {
  id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number;
  guidelines: string;
};
export type PublicAgent = { id: string; name: string; createdAt: string; revokedAt: string | null; owner: string | null };

export type Actor =
  | { kind: "participant"; participant: PublicParticipant }
  | { kind: "keeper"; keeperId: string; name: string }
  | { kind: "secret"; weaveId: string }
  | { kind: "agent"; agent: PublicAgent };

/**
 * The settings an instance keeper can read and patch. `settings.lobby_title` is deliberately not
 * here: it is read once, by `ensureLobby` at first boot, and the `.strict()` patch schema never
 * accepted it — carrying it on this shape only made `updateSettings({ lobbyTitle })` type-check and
 * then throw. Renaming the Lobby means renaming its Weave row.
 */
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean; guidelines: string };
