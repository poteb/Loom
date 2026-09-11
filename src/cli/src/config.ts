import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type WeaveEntry = {
  title: string; secret?: string; token: string; participantId: string; generalThreadId: string; participantName: string;
};
export type CliConfig = { url?: string; lastWeave?: string; weaves: Record<string, WeaveEntry> };

export class ConfigStore {
  constructor(readonly path: string) {}

  static defaultPath(env: NodeJS.ProcessEnv): string {
    if (env.LOOM_CONFIG) return env.LOOM_CONFIG;
    const home = env.HOME ?? env.USERPROFILE ?? ".";
    return path.join(home, ".loom", "config.json");
  }

  load(): CliConfig {
    if (!existsSync(this.path)) return { weaves: {} };
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CliConfig>;
    return { url: raw.url, lastWeave: raw.lastWeave, weaves: raw.weaves ?? {} };
  }

  save(c: CliConfig): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    // A unique-per-process, per-call name so two concurrent saves (e.g. two CLI invocations
    // sharing a config path) never clobber each other's temp file mid-write.
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
    // Tighten permissions on an existing file that may have been more permissive (e.g. created
    // before this code existed, or with a permissive umask); a no-op mode-wise on Windows.
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }
}
