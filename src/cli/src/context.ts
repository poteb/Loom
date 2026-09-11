import { LoomClient, LoomClientError } from "@loom/client";
import { ConfigStore, type CliConfig, type WeaveEntry } from "./config.js";

export type CliIo = { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv };
export type GlobalOpts = { url?: string; weave?: string; json?: boolean };

export class CliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "CliError"; }
}

export type CliContext = {
  io: CliIo; store: ConfigStore; config: CliConfig; opts: GlobalOpts; baseUrl: string;
  client(token?: string): LoomClient;
  resolveWeave(): { weaveId: string; entry: WeaveEntry };
  keeperClient(): LoomClient;
  remember(weaveId: string, entry: WeaveEntry): void;
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
      const entry = config.weaves[weaveId];
      if (!entry) throw new CliError("no_weave", `No stored credentials for Weave ${weaveId}; join it first`);
      return { weaveId, entry };
    },
    keeperClient: () => {
      const t = io.env.LOOM_KEEPER_TOKEN;
      if (!t) throw new CliError("no_keeper_token", "Admin commands need LOOM_KEEPER_TOKEN");
      return root.withToken(t);
    },
    remember: (weaveId, entry) => {
      config.weaves[weaveId] = entry;
      config.lastWeave = weaveId;
      store.save(config);
    },
  };
  return ctx;
}

export function isClientError(e: unknown): e is LoomClientError { return e instanceof LoomClientError; }
