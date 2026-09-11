import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    writeFileSync(this.path, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  }
}
