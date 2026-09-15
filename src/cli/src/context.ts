import { LoomClient, LoomClientError } from "@loom/client";
import { ConfigStore, type CliConfig, type WeaveEntry } from "./config.js";

/**
 * The process edges a command may touch. `stdin` is optional because most commands never read
 * it and a test supplies only what it exercises; a `-` argument with no provider is an error.
 */
export type CliIo = {
  stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv;
  stdin?: { read(): Promise<string> };
};
export type GlobalOpts = { url?: string; weave?: string; json?: boolean };

/**
 * A CLI-level failure carrying both the `{ code, message }` shape the CLI prints and the process
 * exit code it should produce. It defaults to 1 (a runtime error); pass `exitCode: 2` when the
 * argument the user typed is itself the problem, so the usage-error convention in
 * `src/cli/README.md` holds without the diagnostic having to travel through commander — commander
 * renders only the errors it throws itself while parsing, never one thrown from an action.
 */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(public readonly code: string, message: string, opts: { exitCode?: number } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = opts.exitCode ?? 1;
  }
}

export type CliContext = {
  io: CliIo; store: ConfigStore; config: CliConfig; opts: GlobalOpts; baseUrl: string;
  client(token?: string): LoomClient;
  resolveWeave(): { weaveId: string; entry: WeaveEntry };
  keeperClient(): LoomClient;
  remember(weaveId: string, entry: WeaveEntry): Promise<void>;
};

export function buildContext(opts: GlobalOpts, io: CliIo): CliContext {
  const store = new ConfigStore(ConfigStore.defaultPath(io.env));
  const config = store.load();
  const baseUrl = opts.url ?? io.env.LOOM_URL ?? config.url;
  if (!baseUrl) throw new CliError("no_url", "No Loom URL: pass --url or set LOOM_URL");
  const allowInsecure = io.env.LOOM_ALLOW_INSECURE === "1";
  // Validate once, eagerly, so a bad URL fails before any network call.
  const root = new LoomClient({ baseUrl, allowInsecure });
  const ctx: CliContext = {
    io, store, config, opts, baseUrl: root.baseUrl,
    client: (token) => root.withToken(token),
    resolveWeave: () => {
      const weaveId = opts.weave ?? config.lastWeave;
      if (!weaveId) throw new CliError("no_weave", "No Weave selected: pass --weave <id> or create/join one first");
      const agentKey = io.env.LOOM_AGENT_KEY;
      const entry = config.weaves[weaveId];
      // An agent key is a stable identity across machines: it stands in for a stored participant token.
      if (agentKey) return { weaveId, entry: { ...(entry ?? { title: weaveId, participantId: "", generalThreadId: "", participantName: "" }), token: agentKey } };
      if (!entry) throw new CliError("no_weave", `No stored credentials for Weave ${weaveId}; join it first`);
      return { weaveId, entry };
    },
    keeperClient: () => {
      const t = io.env.LOOM_KEEPER_TOKEN;
      if (!t) throw new CliError("no_keeper_token", "Admin commands need LOOM_KEEPER_TOKEN");
      return root.withToken(t);
    },
    remember: async (weaveId, entry) => {
      // Merge into whatever is on disk *now*, under a lock, rather than saving the snapshot loaded
      // at startup: two invocations racing (create + join) must both keep their new tokens.
      const latest = await store.update((c) => {
        c.weaves[weaveId] = entry;
        c.lastWeave = weaveId;
      });
      config.weaves = latest.weaves;
      config.lastWeave = latest.lastWeave;
    },
  };
  return ctx;
}

export function isClientError(e: unknown): e is LoomClientError { return e instanceof LoomClientError; }
