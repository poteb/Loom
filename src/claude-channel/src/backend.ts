import { LoomClient, type Kind, type Role, type Settings } from "@loom/client";
import type { LoomToolBackend } from "@loom/mcp-tools";
import type { ChannelState, JoinedWeave } from "./state.js";

export type JoinHooks = { onJoined(weaveId: string, w: JoinedWeave): void | Promise<void> };

/** LoomToolBackend over the HTTP client; create/join also persist the identity and open a stream via hooks. */
export class ClientToolBackend implements LoomToolBackend {
  constructor(private readonly client: LoomClient, private readonly state: ChannelState, private readonly hooks: JoinHooks) {}
  private as(credential: string): LoomClient { return this.client.withToken(credential); }

  async createWeave(input: { title: string; opener: string; creator: { name: string; kind: Kind } }, credential?: string) {
    const r = await (credential ? this.as(credential) : this.client).createWeave(input);
    const joined: JoinedWeave = {
      title: r.weave.title, secret: r.secret, token: r.token, participantId: r.participant.id, participantName: r.participant.name,
      generalThreadId: r.generalThread.id, wake: "all", lastSeq: 0,
    };
    this.state.upsertWeave(r.weave.id, joined);
    await this.hooks.onJoined(r.weave.id, joined);
    return r;
  }
  async joinWeave(secret: string, who: { name: string; kind: Kind }) {
    const j = await this.client.joinWeave(secret, who);
    const info = await this.as(j.token).getWeave(j.weaveId);
    const general = info.threads.find((t) => t.isGeneral) ?? info.threads[0]!;
    const joined: JoinedWeave = {
      title: info.weave.title, secret, token: j.token, participantId: j.participant.id, participantName: j.participant.name,
      generalThreadId: general.id, wake: "all", lastSeq: 0,
    };
    this.state.upsertWeave(j.weaveId, joined);
    await this.hooks.onJoined(j.weaveId, joined);
    return j;
  }
  async lookupWeave(secret: string) { return { weaveId: await this.client.lookupWeave(secret) }; }
  getWeave(c: string, weaveId: string) { return this.as(c).getWeave(weaveId); }
  readEvents(c: string, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }) { return this.as(c).readEvents(weaveId, opts); }
  postMessage(c: string, threadId: string, text: string) { return this.as(c).postMessage(threadId, text); }
  createThread(c: string, weaveId: string, name: string) { return this.as(c).createThread(weaveId, name); }
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
}
