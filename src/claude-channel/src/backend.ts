import { LoomClient, LoomClientError, type Kind, type Role, type Settings } from "@loom/client";
import type { LoomToolBackend } from "@loom/mcp-tools";
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
   * ignored here: the channel stores the participant identity it creates and reuses that instead. */
  async joinWeave(secret: string, who: { name?: string; kind: Kind }, _credential?: string) {
    const weaveId = await this.client.lookupWeave(secret);
    // Already joined under this name: hand back the stored identity rather than consuming the name
    // a second time (which the server refuses with name_taken). Falls through to a fresh join if the
    // stored token no longer works or the participant is gone.
    const stored = this.state.load().weaves[weaveId];
    if (stored && who.name !== undefined && sameName(stored.participantName, who.name)) {
      const reused = await this.reuseStored(weaveId, stored);
      if (reused) return reused;
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
          if (reused) return reused;
        }
      }
      throw e;
    }
    const joined: JoinedWeave = {
      title: info.weave.title, token: j.token, participantId: j.participant.id, participantName: j.participant.name,
      generalThreadId: general.id, wake: "all", lastSeq: 0,
    };
    await this.state.upsertWeave(j.weaveId, joined);
    await this.hooks.onJoined(j.weaveId, joined);
    return j;
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
  keeperAgentsAdd(c: string, name: string) { return this.as(c).admin.addAgent(name); }
  keeperAgentsRevoke(c: string, id: string) { return this.as(c).admin.revokeAgent(id); }
  setWeaveGuidelines(c: string, w: string, g: string) { return this.as(c).setWeaveGuidelines(w, g); }
  getInstanceGuidelines() { return this.client.getInstanceGuidelines(); }
  async getGuidelines(c: string, w: string) { return (await this.as(c).getWeave(w)).guidelines; }
}
