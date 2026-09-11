import type { Core, Kind, Role, Settings } from "@loom/core";
import type { LoomToolBackend } from "@loom/mcp-tools";

/** LoomToolBackend directly over the core service layer (same process; no HTTP hop). Core errors carry {code,message}. */
export class CoreToolBackend implements LoomToolBackend {
  constructor(private readonly core: Core) {}
  private actor(credential: string) { return this.core.resolveCredential(credential); }

  async createWeave(input: { title: string; opener: string; creator: { name: string; kind: Kind } }, credential?: string) {
    return this.core.createWeave(input, credential ? await this.actor(credential) : undefined);
  }
  joinWeave(secret: string, who: { name: string; kind: Kind }) { return this.core.joinWeave(secret, who); }
  async lookupWeave(secret: string) { return { weaveId: await this.core.lookupWeaveIdBySecret(secret) }; }
  async getWeave(c: string, weaveId: string) { return this.core.getWeave(await this.actor(c), weaveId); }
  async readEvents(c: string, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }) { return this.core.readEvents(await this.actor(c), weaveId, opts); }
  async postMessage(c: string, threadId: string, text: string) { return this.core.postMessage(await this.actor(c), threadId, text); }
  async createThread(c: string, weaveId: string, name: string) { return this.core.createThread(await this.actor(c), weaveId, name); }
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
}
