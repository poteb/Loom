import { request } from "./http.js";
import { resolveBaseUrl } from "./url.js";
import type {
  CreateWeaveInput, CreateWeaveResult, JoinResult, Keeper, Kind, LoomEvent, Participant, Role, Settings, Thread, Weave, WeaveInfo,
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

  private call<T>(method: string, path: string, body?: unknown, accept: "json" | "text" = "json"): Promise<T> {
    return request<T>({ method, url: `${this.baseUrl}${path}`, token: this.token, body, fetchImpl: this.fetchImpl, accept });
  }

  createWeave(input: CreateWeaveInput): Promise<CreateWeaveResult> {
    return this.call("POST", "/api/weaves", input);
  }
  joinWeave(secret: string, who: { name: string; kind: Kind }): Promise<JoinResult> {
    return this.call("POST", `/api/weaves/${encodeURIComponent(secret)}/join`, who);
  }
  getWeave(weaveId: string): Promise<WeaveInfo> {
    return this.call("GET", `/api/weaves/${weaveId}`);
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
  postMessage(threadId: string, text: string): Promise<LoomEvent> {
    return this.call("POST", `/api/threads/${threadId}/messages`, { text });
  }
  createThread(weaveId: string, name: string): Promise<Thread> {
    return this.call("POST", `/api/weaves/${weaveId}/threads`, { name });
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
  async wsTicket(): Promise<string> {
    const r = await this.call<{ ticket: string }>("POST", "/api/auth/ws-ticket");
    return r.ticket;
  }

  readonly admin = {
    listWeaves: async (): Promise<Weave[]> => (await this.call<{ weaves: Weave[] }>("GET", "/api/admin/weaves")).weaves,
    getSettings: (): Promise<Settings> => this.call("GET", "/api/admin/settings"),
    updateSettings: (patch: Partial<Settings>): Promise<Settings> => this.call("PUT", "/api/admin/settings", patch),
    listKeepers: async (): Promise<Keeper[]> => (await this.call<{ keepers: Keeper[] }>("GET", "/api/admin/keepers")).keepers,
    addKeeper: (name: string): Promise<{ keeper: Keeper; token: string }> => this.call("POST", "/api/admin/keepers", { name }),
    removeKeeper: (id: string): Promise<void> => this.call("DELETE", `/api/admin/keepers/${id}`),
  };
}
