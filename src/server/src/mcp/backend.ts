import type { AgentFilter, Core, Kind, RequestStatus, Role, Settings } from "@loom/core";
import type { JoinWeaveOptions, LoomToolBackend, OfferInput, OpenRequestInput } from "@loom/mcp-tools";

/** LoomToolBackend directly over the core service layer (same process; no HTTP hop). Core errors carry {code,message}. */
export class CoreToolBackend implements LoomToolBackend {
  constructor(private readonly core: Core) {}
  private actor(credential: string) { return this.core.resolveCredential(credential); }

  async createWeave(input: { title: string; opener: string; creator: { name: string; kind: Kind }; guidelines?: string }, credential?: string) {
    return this.core.createWeave(input, credential ? await this.actor(credential) : undefined);
  }
  async joinWeave(secret: string, who: { name?: string; kind: Kind }, credential?: string, opts?: JoinWeaveOptions) {
    // Strict: a present-but-invalid credential (a revoked agent key) fails the join rather than
    // silently joining as nobody. With an inviteId core takes the redemption path instead, where
    // the actor is required: it must *be* the invitee.
    return this.core.joinWeave(secret, who, credential ? await this.actor(credential) : undefined, opts);
  }
  async lookupWeave(secret: string) { return { weaveId: await this.core.lookupWeaveIdBySecret(secret) }; }
  async getWeave(c: string, weaveId: string) { return this.core.getWeave(await this.actor(c), weaveId); }
  async readEvents(c: string, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }) { return this.core.readEvents(await this.actor(c), weaveId, opts); }
  async postMessage(c: string, threadId: string, text: string) { return this.core.postMessage(await this.actor(c), threadId, text); }
  async createThread(c: string, weaveId: string, name: string, url?: string | null) { return this.core.createThread(await this.actor(c), weaveId, name, url ?? null); }
  async setThreadUrl(c: string, threadId: string, url: string | null) { return this.core.setThreadUrl(await this.actor(c), threadId, url); }
  async inviteParticipant(c: string, threadId: string, participantId: string) { return this.core.inviteParticipant(await this.actor(c), threadId, participantId); }
  async inbox(c: string, weaveId: string, opts: { since?: number; limit?: number }) { return this.core.inbox(await this.actor(c), weaveId, opts); }
  async closeThread(c: string, threadId: string) { await this.core.closeThread(await this.actor(c), threadId); }
  async archiveWeave(c: string, weaveId: string) { await this.core.archiveWeave(await this.actor(c), weaveId); }
  async setRole(c: string, weaveId: string, participantId: string, role: Role) { return this.core.setRole(await this.actor(c), weaveId, participantId, role); }
  async exportWeave(c: string, weaveId: string, format: "md" | "json") { return this.core.exportWeave(await this.actor(c), weaveId, format); }
  async keeperListWeaves(c: string) { return this.core.listWeaves(await this.actor(c)); }
  async keeperGetSettings(c: string) { return this.core.readSettings(await this.actor(c)); }
  async keeperSetSettings(c: string, patch: Record<string, unknown>) { return this.core.updateSettings(await this.actor(c), patch as Partial<Settings>); }
  async keeperList(c: string) { return this.core.listKeepers(await this.actor(c)); }
  async keeperAdd(c: string, name: string) { return this.core.addKeeper(await this.actor(c), name); }
  async keeperRemove(c: string, id: string) { await this.core.removeKeeper(await this.actor(c), id); }
  async keeperAgentsList(c: string) { return this.core.listAgents(await this.actor(c)); }
  async keeperAgentsAdd(c: string, name: string) { return this.core.addAgent(await this.actor(c), name); }
  async keeperAgentsRevoke(c: string, id: string) { await this.core.revokeAgent(await this.actor(c), id); }
  async setWeaveGuidelines(c: string, w: string, g: string) { return this.core.setWeaveGuidelines(await this.actor(c), w, g); }
  async getInstanceGuidelines() { return this.core.getInstanceGuidelines(); }
  async getGuidelines(c: string, w: string) { return (await this.core.getWeave(await this.actor(c), w)).guidelines; }

  // --- Lobby ---------------------------------------------------------------
  async getLobby() { return this.core.getLobby(); }
  async joinLobby(who: { name?: string; kind: Kind }, credential?: string) {
    // Secret-less, as over REST: the Lobby is looked up from settings. An agent key joins under its
    // own name; anyone else must give one.
    return this.core.joinLobby(who, credential ? await this.actor(credential) : undefined);
  }
  async setCapabilities(c: string, profile: unknown) { return this.core.setCapabilities(await this.actor(c), profile); }
  async findAgents(c: string, filter: Record<string, unknown>) { return this.core.findAgents(await this.actor(c), filter as AgentFilter); }
  async openRequest(c: string, input: OpenRequestInput) {
    const { targetCredential, ...rest } = input;
    // Two credentials, because a request spans two Weaves: the session's own is the Lobby identity,
    // and this one its authority in the target. Left out, core falls back to the session's — which
    // is what makes an agent key enough on its own, and what makes a bare Lobby token invalid_token.
    const targetActor = targetCredential ? await this.actor(targetCredential) : undefined;
    return this.core.openRequest(await this.actor(c), targetActor, { ...rest, url: rest.url ?? null });
  }
  async listRequests(c: string, opts: { status?: string; limit?: number }) {
    // Passed through as the string it is: which words name a status is core's rule.
    return this.core.listRequests(await this.actor(c), { status: opts.status as RequestStatus | undefined, limit: opts.limit });
  }
  async getRequest(c: string, requestId: string) { return this.core.getRequest(await this.actor(c), requestId); }
  async offer(c: string, requestId: string, input: OfferInput) { return this.core.offer(await this.actor(c), requestId, input); }
  async acceptRequest(c: string, requestId: string, participantIds: string[]) { return this.core.acceptRequest(await this.actor(c), requestId, participantIds); }
  async cancelRequest(c: string, requestId: string) { return this.core.cancelRequest(await this.actor(c), requestId); }
  async inviteToWeave(c: string, participantId: string, targetWeaveId: string, targetThreadId: string) {
    return this.core.inviteToWeave(await this.actor(c), participantId, targetWeaveId, targetThreadId);
  }
}
