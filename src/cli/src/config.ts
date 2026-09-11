import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

  /**
   * Read-modify-write against the latest on-disk config, serialized across processes with a
   * lock file (O_EXCL create). Returns the config as saved. A lock older than STALE_LOCK_MS is
   * assumed abandoned (crashed process) and taken over.
   */
  async update(mutate: (c: CliConfig) => void): Promise<CliConfig> {
    await this.acquireLock();
    try {
      const c = this.load();
      mutate(c);
      this.save(c);
      return c;
    } finally {
      this.releaseLock();
    }
  }

  private get lockPath(): string { return `${this.path}.lock`; }
  private static readonly STALE_LOCK_MS = 10_000;
  private static readonly LOCK_TIMEOUT_MS = 5_000;

  private async acquireLock(): Promise<void> {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const t0 = Date.now();
    for (;;) {
      try {
        closeSync(openSync(this.lockPath, "wx"));
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > ConfigStore.STALE_LOCK_MS) { rmSync(this.lockPath, { force: true }); continue; }
        } catch { continue; /* lock vanished between the failed create and the stat: retry now */ }
        if (Date.now() - t0 > ConfigStore.LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for config lock ${this.lockPath}`);
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
      }
    }
  }

  private releaseLock(): void { rmSync(this.lockPath, { force: true }); }

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
