import { LoomClient, LoomClientError, type AgentFilter, type Kind, type Profile, type Requirements, type RequestStatus, type Role, type Settings } from "@loom/client";
import { LoomToolError, type JoinWeaveOptions, type LoomToolBackend, type OfferInput, type OpenRequestInput } from "@loom/mcp-tools";
import type { ChannelState, JoinedWeave } from "./state.js";

export type JoinHooks = {
  onJoined(weaveId: string, w: JoinedWeave): void | Promise<void>;
  /** Called right after a thread this session created persists, so the stored-credential resolver
   * (which needs to map threadId -> weaveId) doesn't have to wait for that thread's own
   * thread.created event to come back over the stream. */
  onThreadCreated?(weaveId: string, threadId: string): void;
};

/** Participant names are unique per Weave case-insensitively (core: unique index on lower(name)), and trimmed. */
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Error codes that prove a stored credential can never work again. */
const DEAD_IDENTITY = new Set(["invalid_token", "forbidden", "weave_not_found"]);

/** LoomToolBackend over the HTTP client; create/join also persist the identity and open a stream via hooks. */
export class ClientToolBackend implements LoomToolBackend {
  constructor(private readonly client: LoomClient, private readonly state: ChannelState, private readonly hooks: JoinHooks) {}
  private as(credential: string): LoomClient { return this.client.withToken(credential); }

  async createWeave(input: { title: string; opener: string; creator: { name: string; kind: Kind }; guidelines?: string }, credential?: string) {
    const r = await (credential ? this.as(credential) : this.client).createWeave(input);
    const joined: JoinedWeave = {
      title: r.weave.title, token: r.token, participantId: r.participant.id, participantName: r.participant.name,
      generalThreadId: r.generalThread.id, wake: "all", lastSeq: 0,
    };
    await this.state.upsertWeave(r.weave.id, joined);
    await this.hooks.onJoined(r.weave.id, joined);
    return r;
  }
  /** Reads the Weave's metadata with the secret (a read-only credential) *before* joining: joining is
   * irreversible and consumes the chosen name, so a metadata failure after a successful join would
   * lose the issued token and make a retry fail with `name_taken`. Order: lookup -> getWeave -> join
   * -> persist the token -> hooks. The connection-wide agent key other backends pass through is
   * ignored on this path: the channel stores the participant identity it creates and reuses that
   * instead. (An `inviteId` redemption does use a credential — see redeemInvite.) */
  async joinWeave(secret: string, who: { name?: string; kind: Kind }, credential?: string, opts?: JoinWeaveOptions) {
    // Redeeming an invitation is a different join: no secret, and the credential that proves this is
    // the invitee is the Lobby identity the channel stored (or an explicit one, if given).
    if (opts?.inviteId !== undefined) return this.redeemInvite(opts.inviteId, who.name, credential);
    const weaveId = await this.client.lookupWeave(secret);
    // Already joined under this name: hand back the stored identity rather than consuming the name
    // a second time (which the server refuses with name_taken). Falls through to a fresh join if the
    // stored token no longer works or the participant is gone.
    const stored = this.state.load().weaves[weaveId];
    if (stored && who.name !== undefined && sameName(stored.participantName, who.name)) {
      const reused = await this.reuseStored(weaveId, stored);
      if (reused) { await this.flagIfLobby(weaveId); return reused; }
    }
    const info = await this.as(secret).getWeave(weaveId);
    const general = info.threads.find((t) => t.isGeneral) ?? info.threads[0]!;
    let j: Awaited<ReturnType<LoomClient["joinWeave"]>>;
    try {
      j = await this.client.joinWeave(secret, who);
    } catch (e) {
      // name_taken can mean a sibling channel process joined under this name a moment ago and has
      // already persisted the identity: the state lock does not cover the network round trip.
      if (e instanceof LoomClientError && e.code === "name_taken") {
        const raced = this.state.load().weaves[weaveId];
        if (raced && who.name !== undefined && sameName(raced.participantName, who.name)) {
          const reused = await this.reuseStored(weaveId, raced);
          if (reused) { await this.flagIfLobby(weaveId); return reused; }
        }
      }
      throw e;
    }
    const joined: JoinedWeave = {
      title: info.weave.title, token: j.token, participantId: j.participant.id, participantName: j.participant.name,
      generalThreadId: general.id, wake: "all", lastSeq: 0,
    };
    await this.state.upsertWeave(j.weaveId, joined);
    await this.flagIfLobby(j.weaveId);
    await this.hooks.onJoined(j.weaveId, joined);
    return j;
  }
  /**
   * Flags a stored Weave as the Lobby when it is the Lobby, whatever way it was joined — by secret,
   * or by redeeming an invitation into it. `join_lobby` is not the only door, and an identity that
   * reached the Lobby through another one must still clear its profile before leaving (spec 5).
   * One cheap public call; if it cannot be made the join stands unflagged, and `leave_weave` asks
   * again rather than dropping the credential on a guess.
   */
  private async flagIfLobby(weaveId: string): Promise<void> {
    try {
      if ((await this.client.getLobby()).weaveId === weaveId) await this.state.markLobby(weaveId);
    } catch { /* not knowable now; leave_weave checks again for an entry without the flag */ }
  }
  /** Validates a stored identity with its own token and re-arms its stream. Returns undefined only
   * when the identity is definitively dead (token rejected, Weave gone, participant removed); a
   * transient failure propagates, because a fresh join on top of a live identity would burn the
   * name and fail with name_taken. */
  private async reuseStored(weaveId: string, stored: JoinedWeave) {
    let info: Awaited<ReturnType<LoomClient["getWeave"]>>;
    try {
      info = await this.as(stored.token).getWeave(weaveId);
    } catch (e) {
      if (e instanceof LoomClientError && DEAD_IDENTITY.has(e.code)) return undefined;
      throw e;
    }
    const participant = info.participants.find((p) => p.id === stored.participantId);
    if (!participant) return undefined;
    await this.hooks.onJoined(weaveId, stored);
    // This response is built here rather than by the server's join, so it has to carry `guidelines`
    // itself: a restored session takes this path and would otherwise never be told the rules.
    return { weaveId, weave: info.weave, generalThreadId: stored.generalThreadId, participant, token: stored.token, guidelines: info.guidelines, alreadyJoined: true };
  }
  async lookupWeave(secret: string) { return { weaveId: await this.client.lookupWeave(secret) }; }
  getWeave(c: string, weaveId: string) { return this.as(c).getWeave(weaveId); }
  readEvents(c: string, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }) { return this.as(c).readEvents(weaveId, opts); }
  inbox(c: string, weaveId: string, opts: { since?: number; limit?: number }) { return this.as(c).inbox(weaveId, opts); }
  postMessage(c: string, threadId: string, text: string) { return this.as(c).postMessage(threadId, text); }
  async createThread(c: string, weaveId: string, name: string, url?: string | null) {
    const t = await this.as(c).createThread(weaveId, name, url);
    this.hooks.onThreadCreated?.(weaveId, t.id);
    return t;
  }
  setThreadUrl(c: string, threadId: string, url: string | null) { return this.as(c).setThreadUrl(threadId, url); }
  inviteParticipant(c: string, threadId: string, participantId: string) { return this.as(c).inviteParticipant(threadId, participantId); }
  closeThread(c: string, threadId: string) { return this.as(c).closeThread(threadId); }
  archiveWeave(c: string, weaveId: string) { return this.as(c).archiveWeave(weaveId); }
  setRole(c: string, weaveId: string, participantId: string, role: Role) { return this.as(c).setRole(weaveId, participantId, role); }
  exportWeave(c: string, weaveId: string, format: "md" | "json") { return this.as(c).exportWeave(weaveId, format); }
  keeperListWeaves(c: string) { return this.as(c).admin.listWeaves(); }
  keeperGetSettings(c: string) { return this.as(c).admin.getSettings(); }
  keeperSetSettings(c: string, patch: Record<string, unknown>) { return this.as(c).admin.updateSettings(patch as Partial<Settings>); }
  keeperList(c: string) { return this.as(c).admin.listKeepers(); }
  keeperAdd(c: string, name: string) { return this.as(c).admin.addKeeper(name); }
  keeperRemove(c: string, id: string) { return this.as(c).admin.removeKeeper(id); }
  keeperAgentsList(c: string) { return this.as(c).admin.listAgents(); }
  keeperAgentsAdd(c: string, name: string, owner?: string) { return this.as(c).admin.addAgent(name, owner); }
  keeperAgentsRevoke(c: string, id: string) { return this.as(c).admin.revokeAgent(id); }
  keeperAgentsSetOwner(c: string, id: string, owner: string) { return this.as(c).admin.setAgentOwner(id, owner); }
  setWeaveGuidelines(c: string, w: string, g: string) { return this.as(c).setWeaveGuidelines(w, g); }
  getInstanceGuidelines() { return this.client.getInstanceGuidelines(); }
  async getGuidelines(c: string, w: string) { return (await this.as(c).getWeave(w)).guidelines; }

  // --- Lobby ---------------------------------------------------------------
  // The Lobby is stored like any other Weave, plus an `isLobby` flag: that is what makes
  // `credential: "stored"` mean something for the Lobby tools (resolved in stored.ts) and what
  // makes leave_weave clear the profile first.
  getLobby() { return this.client.getLobby(); }

  /** A secret-less join, otherwise exactly joinWeave: the identity is persisted and its stream
   * opened, and a repeat join under the stored name hands back the stored identity rather than
   * burning the name a second time. */
  async joinLobby(who: { name?: string; kind: Kind }, _credential?: string) {
    const { weaveId } = await this.client.getLobby();
    const stored = this.state.load().weaves[weaveId];
    if (stored && who.name !== undefined && sameName(stored.participantName, who.name)) {
      const reused = await this.reuseStored(weaveId, stored);
      // The id is already in hand here, so the flag needs no lookup: an entry joined by secret, or
      // stored before the flag existed, is upgraded on this path rather than staying unrecognised.
      if (reused) { if (!stored.isLobby) await this.state.markLobby(weaveId); return reused; }
    }
    const j = await this.client.joinLobby(who);
    const joined: JoinedWeave = {
      title: j.weave.title, token: j.token, participantId: j.participant.id, participantName: j.participant.name,
      generalThreadId: j.generalThreadId, wake: "all", lastSeq: 0, isLobby: true,
    };
    await this.state.upsertWeave(j.weaveId, joined);
    await this.hooks.onJoined(j.weaveId, joined);
    return j;
  }

  /** Redeems a cross-Weave invitation: no secret, and the invitee identity is this machine's Lobby
   * one (the invitation is addressed to that participant). The Weave it lands in is stored and
   * streamed exactly as a secret join's, so the agent wakes for what happens there. */
  private async redeemInvite(inviteId: string, name: string | undefined, credential?: string) {
    const lobby = this.state.lobbyEntry();
    if (!credential && !lobby) {
      throw new LoomToolError("no_weave", "Not joined to the Lobby, and an invitation is redeemed with the Lobby identity it was addressed to: call join_lobby first, or pass the credential it was issued to");
    }
    const j = await this.as(credential ?? lobby!.weave.token).joinByInvite(inviteId, name);
    const joined: JoinedWeave = {
      title: j.weave.title, token: j.token, participantId: j.participant.id, participantName: j.participant.name,
      generalThreadId: j.generalThreadId, wake: "all", lastSeq: 0,
    };
    await this.state.upsertWeave(j.weaveId, joined);
    await this.flagIfLobby(j.weaveId);
    await this.hooks.onJoined(j.weaveId, joined);
    return j;
  }

  setCapabilities(c: string, profile: unknown) { return this.as(c).setCapabilities(profile as Profile | null); }
  findAgents(c: string, filter: Record<string, unknown>) { return this.as(c).findAgents(filter as AgentFilter); }
  /** Two credentials, because a request spans two Weaves: `c` is the Lobby identity, and the input's
   * `targetCredential` (already resolved by the stored-credential wrapper) the authority in the
   * target. Left out, the server falls back to the caller's own — enough for an agent key alone. */
  openRequest(c: string, input: OpenRequestInput) {
    // `requirements` stays opaque on the tool surface; which keys and values are acceptable is core's
    // rule, checked there, so it is handed on as it came.
    return this.as(c).openRequest({ ...input, requirements: input.requirements as Requirements, url: input.url ?? null });
  }
  listRequests(c: string, opts: { status?: string; limit?: number }) { return this.as(c).listRequests(opts.status as RequestStatus | undefined, { limit: opts.limit }); }
  getRequest(c: string, requestId: string) { return this.as(c).getRequest(requestId); }
  offer(c: string, requestId: string, input: OfferInput) { return this.as(c).offer(requestId, input); }
  acceptRequest(c: string, requestId: string, participantIds: string[], deadlineMs?: number) { return this.as(c).acceptRequest(requestId, participantIds, deadlineMs); }
  cancelRequest(c: string, requestId: string) { return this.as(c).cancelRequest(requestId); }
  completeRequest(c: string, requestId: string, note?: string) { return this.as(c).completeRequest(requestId, note); }
  removeParticipant(c: string, threadId: string, participantId: string) { return this.as(c).removeParticipant(threadId, participantId); }
  inviteToWeave(c: string, participantId: string, targetWeaveId: string, targetThreadId: string) {
    return this.as(c).inviteToWeave(targetWeaveId, participantId, targetThreadId);
  }
}
