import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** The lock file stopped holding our token mid-update: someone else owns the config now. */
class LockLostError extends Error {
  constructor() { super("config lock lost"); }
}

/** The pid out of a `"<pid>:<uuid>"` lock token, or undefined if it was not written by us. */
function ownerPid(token: string): number | undefined {
  const pid = Number(/^(\d+):[0-9a-f-]{36}$/.exec(token)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether the process that took the lock still exists — the only thing that licenses a takeover. */
function ownerAlive(token: string): boolean {
  const pid = ownerPid(token);
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

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
   * Read-modify-write against the latest on-disk config, serialized across processes with an
   * owner-aware lock file (O_EXCL create, holding `"<pid>:<uuid>"`). Returns the config as saved.
   *
   * A lock is taken over only when its owner process is gone; a live owner is waited for however
   * long its lock has been sitting there, because "old" and "abandoned" are not the same thing —
   * a suspended process wakes up and finishes its write. The lease is re-checked just before the
   * config is written, so a writer that did lose it (to a takeover of an unparsable lock, or to an
   * older version of this code) never saves its stale snapshot over its successor's, and never
   * removes a lock that is no longer its own; it retries the whole update instead.
   *
   * `mutate` therefore runs again on a retry, against the fresh on-disk config: it must be a pure
   * function of the config it is handed.
   */
  async update(mutate: (c: CliConfig) => void): Promise<CliConfig> {
    for (let attempt = 1; ; attempt++) {
      const token = await this.acquireLock();
      try {
        const c = this.load();
        mutate(c);
        this.assertHoldsLock(token);
        this.save(c);
        return c;
      } catch (e) {
        if (!(e instanceof LockLostError) || attempt >= ConfigStore.MAX_UPDATE_ATTEMPTS) throw e;
      } finally {
        this.releaseLock(token);
      }
    }
  }

  private get lockPath(): string { return `${this.path}.lock`; }
  /** Only ever applied to a lock whose owner cannot be identified (empty or written by another tool). */
  private static readonly STALE_LOCK_MS = 10_000;
  private static readonly LOCK_TIMEOUT_MS = 5_000;
  private static readonly MAX_UPDATE_ATTEMPTS = 5;

  private async acquireLock(): Promise<string> {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const token = `${process.pid}:${randomUUID()}`;
    const t0 = Date.now();
    for (;;) {
      try {
        const fd = openSync(this.lockPath, "wx");
        try { writeSync(fd, token); } finally { closeSync(fd); }
        return token;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const owner = this.readLock();
        if (owner === undefined) continue; // vanished between the failed create and the read: retry now
        if (ownerPid(owner) === undefined) {
          // Not one of our locks (empty, or left by another tool): age is the only signal there is.
          try {
            if (Date.now() - statSync(this.lockPath).mtimeMs > ConfigStore.STALE_LOCK_MS) { rmSync(this.lockPath, { force: true }); continue; }
          } catch { continue; }
        } else if (!ownerAlive(owner)) {
          rmSync(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() - t0 > ConfigStore.LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for config lock ${this.lockPath}`);
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
      }
    }
  }

  /** The lock file's contents, or undefined if it is not there. */
  private readLock(): string | undefined {
    try { return readFileSync(this.lockPath, "utf8"); } catch { return undefined; }
  }

  private assertHoldsLock(token: string): void {
    if (this.readLock() !== token) throw new LockLostError();
  }

  private releaseLock(token: string): void {
    if (this.readLock() === token) rmSync(this.lockPath, { force: true });
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
