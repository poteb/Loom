import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Wake = "all" | "mentions";
export type JoinedWeave = {
  title: string; token: string; participantId: string; participantName: string;
  generalThreadId: string; wake: Wake; lastSeq: number;
};
export type ChannelConfig = { url?: string; allowInsecure?: boolean; weaves: Record<string, JoinedWeave> };

export class ChannelState {
  private cache: ChannelConfig | undefined;
  readonly file: string;

  constructor(readonly dir: string) { this.file = path.join(dir, "config.json"); }

  static dirFrom(env: NodeJS.ProcessEnv): string {
    if (env.LOOM_CHANNEL_STATE_DIR) return env.LOOM_CHANNEL_STATE_DIR;
    const home = env.HOME ?? env.USERPROFILE ?? ".";
    return path.join(home, ".claude", "channels", "loom");
  }

  load(): ChannelConfig {
    if (!existsSync(this.file)) return { weaves: {} };
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ChannelConfig>;
    return { url: raw.url, allowInsecure: raw.allowInsecure, weaves: raw.weaves ?? {} };
  }

  save(c: ChannelConfig): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    this.cache = c;
  }

  get(): ChannelConfig { return (this.cache ??= this.load()); }

  upsertWeave(id: string, w: JoinedWeave): void { const c = this.get(); c.weaves[id] = w; this.save(c); }
  removeWeave(id: string): void { const c = this.get(); delete c.weaves[id]; this.save(c); }
  setLastSeq(id: string, seq: number): void { const c = this.get(); const w = c.weaves[id]; if (w && seq > w.lastSeq) { w.lastSeq = seq; this.save(c); } }
  setWake(id: string, wake: Wake): void { const c = this.get(); const w = c.weaves[id]; if (w) { w.wake = wake; this.save(c); } }
}
