import { request } from "./http.js";
import { resolveBaseUrl } from "./url.js";
import { openStream, type StreamHandle, type StreamOptions } from "./stream.js";
import type {
  AcceptResult, Agent, AgentFilter, CreateWeaveInput, CreateWeaveResult, FoundAgent, InboxItem, InvitationResult, InviteResult,
  JoinResult, Keeper, Kind, Lobby, LoomEvent, LoomRequest, Offer, OpenRequestInput, Participant, Profile, RequestStatus,
  Role, Settings, Thread, Weave, WeaveInfo,
} from "./types.js";

export type LoomClientOptions = { baseUrl: string; token?: string; allowInsecure?: boolean; fetch?: typeof fetch };

export class LoomClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: LoomClientOptions) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl, opts.allowInsecure ?? false);
    this.token = opts.token;
    this.fetchImpl = opts.fetch;
  }

  /** Same server, different credential (participant token, keeper token, or weave secret). */
  withToken(token: string | undefined): LoomClient {
    const c = new LoomClient({ baseUrl: this.baseUrl, token, allowInsecure: true, fetch: this.fetchImpl });
    return c;
  }

  private call<T>(method: string, path: string, body?: unknown, accept: "json" | "text" = "json", signal?: AbortSignal): Promise<T> {
    return request<T>({ method, url: `${this.baseUrl}${path}`, token: this.token, body, fetchImpl: this.fetchImpl, accept, signal });
  }

  createWeave(input: CreateWeaveInput): Promise<CreateWeaveResult> {
    return this.call("POST", "/api/weaves", input);
  }
  /** `name` may be omitted when this client's token is an agent key: the agent's own name is used. */
  joinWeave(secret: string, who: { name?: string; kind: Kind }): Promise<JoinResult> {
    return this.call("POST", `/api/weaves/${encodeURIComponent(secret)}/join`, who);
  }
  /** `signal` bounds the call: a caller fanning this out over many Weaves (the channel's
   *  `list_joined`) needs one stalled server to give up rather than hold the whole answer. */
  getWeave(weaveId: string, opts: { signal?: AbortSignal } = {}): Promise<WeaveInfo> {
    return this.call("GET", `/api/weaves/${weaveId}`, undefined, "json", opts.signal);
  }
  async lookupWeave(secret: string): Promise<string> {
    const r = await this.call<{ weaveId: string }>("GET", `/api/weaves/${encodeURIComponent(secret)}/lookup`);
    return r.weaveId;
  }
  async readEvents(weaveId: string, opts: { since?: number; threadId?: string; limit?: number } = {}): Promise<LoomEvent[]> {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", String(opts.since));
    if (opts.threadId) q.set("thread", opts.threadId);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    const r = await this.call<{ events: LoomEvent[] }>("GET", `/api/weaves/${weaveId}/events${qs ? `?${qs}` : ""}`);
    return r.events;
  }
  /** Events addressed to the caller — invites and mentions — oldest first, each with its Thread's
   * name and artefact URL. Omit `since` for the most recent addressed events. */
  async inbox(weaveId: string, opts: { since?: number; limit?: number } = {}): Promise<InboxItem[]> {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", String(opts.since));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    const r = await this.call<{ events: InboxItem[] }>("GET", `/api/weaves/${weaveId}/inbox${qs ? `?${qs}` : ""}`);
    return r.events;
  }
  postMessage(threadId: string, text: string): Promise<LoomEvent> {
    return this.call("POST", `/api/threads/${threadId}/messages`, { text });
  }
  createThread(weaveId: string, name: string, url?: string | null): Promise<Thread> {
    return this.call("POST", `/api/weaves/${weaveId}/threads`, url === undefined ? { name } : { name, url });
  }
  setThreadUrl(threadId: string, url: string | null): Promise<Thread> {
    return this.call("PUT", `/api/threads/${threadId}/url`, { url });
  }
  inviteParticipant(threadId: string, participantId: string): Promise<InviteResult> {
    return this.call("POST", `/api/threads/${threadId}/invites`, { participantId });
  }
  closeThread(threadId: string): Promise<void> {
    return this.call("POST", `/api/threads/${threadId}/close`);
  }
  archiveWeave(weaveId: string): Promise<void> {
    return this.call("POST", `/api/weaves/${weaveId}/archive`);
  }
  setRole(weaveId: string, participantId: string, role: Role): Promise<Participant> {
    return this.call("PUT", `/api/weaves/${weaveId}/participants/${participantId}/role`, { role });
  }
  exportWeave(weaveId: string, format: "md" | "json"): Promise<string> {
    return this.call("GET", `/api/weaves/${weaveId}/export?format=${format}`, undefined, "text");
  }
  /** Public on the server: no credential is needed, so this answers before the caller holds one. */
  getInstanceGuidelines(opts: { signal?: AbortSignal } = {}): Promise<string> {
    return request<{ guidelines: string }>({ method: "GET", url: `${this.baseUrl}/api/guidelines`, fetchImpl: this.fetchImpl, signal: opts.signal })
      .then((r) => r.guidelines);
  }
  /** Weave keepers only. `seq` is null when the text already matched: nothing was appended. */
  setWeaveGuidelines(weaveId: string, guidelines: string): Promise<{ weave: Weave; seq: number | null }> {
    return this.call("PUT", `/api/weaves/${weaveId}/guidelines`, { guidelines });
  }
  // --- Lobby -------------------------------------------------------------
  // The Lobby is one Weave per instance, so none of these name one.

  /** Public: where the Lobby is, answered before the caller holds any credential. An instance
   *  keeper's token also brings back `secret`, the read credential for the Lobby's own web page. */
  getLobby(): Promise<Lobby> {
    return this.call("GET", "/api/lobby");
  }
  /** No secret: anyone who can reach the instance may join. An agent key supplies its own name. */
  joinLobby(who: { name?: string; kind: Kind }): Promise<JoinResult> {
    return this.call("POST", "/api/lobby/join", who);
  }
  /** Sets this client's own Lobby profile; `null` clears it, which is what a listener does before
   *  it drops its credential, so no eligible profile is left with nobody behind it. */
  setCapabilities(profile: Profile | null): Promise<Participant> {
    return this.call("PUT", "/api/lobby/participants/me/capabilities", profile);
  }
  /** The Lobby participants whose profile satisfies `filter`; `filter.owner` restricts to those
   *  whose serving policy admits that owner. */
  async findAgents(filter: AgentFilter = {}): Promise<FoundAgent[]> {
    const r = await this.call<{ agents: FoundAgent[] }>("GET", `/api/lobby/agents?filter=${encodeURIComponent(JSON.stringify(filter))}`);
    return r.agents;
  }

  // --- Requests ----------------------------------------------------------

  /** Opens a request. This client's token is the Lobby identity; `targetCredential` in the input is
   *  the authority in the Weave the helpers will be invited into (see the type). */
  openRequest(input: OpenRequestInput): Promise<LoomRequest> {
    return this.call("POST", "/api/requests", input);
  }
  /** Open requests read `expired` once their deadline passes, whether or not the sweeper has been. */
  async listRequests(status?: RequestStatus): Promise<LoomRequest[]> {
    const r = await this.call<{ requests: LoomRequest[] }>("GET", `/api/requests${status ? `?status=${encodeURIComponent(status)}` : ""}`);
    return r.requests;
  }
  getRequest(requestId: string): Promise<LoomRequest> {
    return this.call("GET", `/api/requests/${requestId}`);
  }
  /** Says "I can take this". A second offer is the same answer, not a second one. */
  offer(requestId: string, input: { model?: string; effort?: string; note?: string } = {}): Promise<Offer> {
    return this.call("POST", `/api/requests/${requestId}/offers`, input);
  }
  /** The requester (or a Lobby keeper on its behalf) accepts offers; each accepted listener is
   *  handed one invitation into the target Weave. */
  acceptRequest(requestId: string, participantIds: string[]): Promise<AcceptResult> {
    return this.call("POST", `/api/requests/${requestId}/accept`, { participantIds });
  }
  cancelRequest(requestId: string): Promise<LoomRequest> {
    return this.call("POST", `/api/requests/${requestId}/cancel`);
  }
  /** A keeper of `weaveId` hands a Lobby participant a single-use way in. Usable without a request. */
  inviteToWeave(weaveId: string, participantId: string, threadId: string): Promise<InvitationResult> {
    return this.call("POST", `/api/weaves/${weaveId}/invitations`, { participantId, threadId });
  }
  /** Redeems an invitation with this client's own credential: no secret, and the target Weave is
   *  the invitation's. `name` is only needed when the invitee's Lobby name is taken there. */
  joinByInvite(inviteId: string, name?: string): Promise<JoinResult> {
    return this.call("POST", "/api/weaves/join", name === undefined ? { inviteId } : { inviteId, name });
  }

  async wsTicket(): Promise<string> {
    const r = await this.call<{ ticket: string }>("POST", "/api/auth/ws-ticket");
    return r.ticket;
  }
  stream(weaveId: string, opts: StreamOptions): StreamHandle {
    return openStream(this, weaveId, opts);
  }

  readonly admin = {
    listWeaves: async (): Promise<Weave[]> => (await this.call<{ weaves: Weave[] }>("GET", "/api/admin/weaves")).weaves,
    getSettings: (): Promise<Settings> => this.call("GET", "/api/admin/settings"),
    updateSettings: (patch: Partial<Settings>): Promise<Settings> => this.call("PUT", "/api/admin/settings", patch),
    listKeepers: async (): Promise<Keeper[]> => (await this.call<{ keepers: Keeper[] }>("GET", "/api/admin/keepers")).keepers,
    addKeeper: (name: string): Promise<{ keeper: Keeper; token: string }> => this.call("POST", "/api/admin/keepers", { name }),
    removeKeeper: (id: string): Promise<void> => this.call("DELETE", `/api/admin/keepers/${id}`),
    listAgents: async (): Promise<Agent[]> => (await this.call<{ agents: Agent[] }>("GET", "/api/admin/agents")).agents,
    addAgent: (name: string): Promise<{ agent: Agent; key: string }> => this.call("POST", "/api/admin/agents", { name }),
    revokeAgent: (id: string): Promise<void> => this.call("DELETE", `/api/admin/agents/${id}`),
  };
}
