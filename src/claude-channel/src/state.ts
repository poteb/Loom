import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type Wake = "all" | "mentions";
export type JoinedWeave = {
  title: string; token: string; participantId: string; participantName: string;
  generalThreadId: string; wake: Wake;
  /** Machine-wide watermark: the highest seq any session on this machine has delivered. */
  lastSeq: number;
};
/** Per-session delivery cursors, keyed by Claude Code session id (`CLAUDE_CODE_SESSION_ID`). */
export type SessionCursors = { at: string; cursors: Record<string, number> };
export type ChannelConfig = {
  url?: string; allowInsecure?: boolean;
  weaves: Record<string, JoinedWeave>;
  sessions: Record<string, SessionCursors>;
};

const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The channel's persistent state, shared by every channel process on the machine.
 *
 * Identity (participant tokens) is deliberately machine-wide: one "ClaudeCode" participant per
 * machine, whichever session is talking. Delivery position is per session: each Claude Code session
 * (identified by `CLAUDE_CODE_SESSION_ID`, stable across `--resume`/`--continue`) keeps its own
 * cursor so a resumed session replays exactly what *it* missed, while a brand-new session starts at
 * the machine-wide watermark rather than replaying history another session already handled.
 *
 * Every mutation is a locked read-merge-write against the file so concurrent processes never lose
 * each other's updates; reads serve the last snapshot this process saw (`get()`) or reload (`load()`).
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export class ChannelState {
  private cache: ChannelConfig | undefined;
  readonly file: string;
  private readonly lockFile: string;
  /** Written into the lock file so a process can tell its own lock from one that replaced it. */
  private readonly lockToken = `${process.pid}:${randomUUID()}`;

  constructor(readonly dir: string, readonly sessionId: string = ChannelState.sessionIdFrom(process.env), private readonly now: () => Date = () => new Date()) {
    this.file = path.join(dir, "config.json");
    this.lockFile = `${this.file}.lock`;
  }

  static dirFrom(env: NodeJS.ProcessEnv): string {
    if (env.LOOM_CHANNEL_STATE_DIR) return env.LOOM_CHANNEL_STATE_DIR;
    const home = env.HOME ?? env.USERPROFILE ?? ".";
    return path.join(home, ".claude", "channels", "loom");
  }

  /** Claude Code's session id when it provides one; otherwise a per-process id (no resume semantics). */
  static sessionIdFrom(env: NodeJS.ProcessEnv): string {
    return env.CLAUDE_CODE_SESSION_ID ?? `pid:${process.pid}`;
  }

  /** Reloads from disk. Never writes: unknown fields are dropped in memory, `migrate()` cleans the file. */
  load(): ChannelConfig {
    const config = this.read();
    this.cache = config;
    return config;
  }

  /** Rewrites a file that carries fields this version does not know (e.g. the legacy `secret`),
   * through the locked path so it cannot clobber another process's concurrent update. */
  async migrate(): Promise<void> {
    if (this.readChecked().dirty) await this.mutate(() => {});
  }

  /** Last snapshot this process saw; loads on first use. */
  get(): ChannelConfig { return this.cache ?? this.load(); }

  /** This session's next `since` for a Weave: its own cursor if it has one, else the machine-wide watermark. */
  cursor(weaveId: string): number {
    const c = this.get();
    return c.sessions[this.sessionId]?.cursors[weaveId] ?? c.weaves[weaveId]?.lastSeq ?? 0;
  }

  /** Records where this session starts listening to a Weave (its own cursor if it has one, else
   * the current watermark) and returns it. Persisting the starting point matters for quiet
   * sessions: without it a session that received nothing would have no entry, and on resume it
   * would fall back to a watermark other sessions have since moved past, skipping those events. */
  ensureCursor(id: string): Promise<number> {
    return this.mutate((c) => {
      const s = this.session(c);
      s.cursors[id] ??= c.weaves[id]?.lastSeq ?? 0;
      return s.cursors[id];
    });
  }

  upsertWeave(id: string, w: JoinedWeave): Promise<void> {
    return this.mutate((c) => {
      c.weaves[id] = w;
      // A (re)join resets where this session listens from; other sessions keep their own cursors.
      this.session(c).cursors[id] = w.lastSeq;
    });
  }

  removeWeave(id: string): Promise<void> {
    return this.mutate((c) => {
      delete c.weaves[id];
      for (const s of Object.values(c.sessions)) delete s.cursors[id];
    });
  }

  /** Records that this session delivered `seq`; both its cursor and the watermark only move forward. */
  setLastSeq(id: string, seq: number): Promise<void> {
    return this.mutate((c) => {
      const w = c.weaves[id];
      if (!w) return;
      if (seq > w.lastSeq) w.lastSeq = seq;
      const s = this.session(c);
      if (seq > (s.cursors[id] ?? -1)) s.cursors[id] = seq;
    });
  }

  setWake(id: string, wake: Wake): Promise<void> {
    return this.mutate((c) => { const w = c.weaves[id]; if (w) w.wake = wake; });
  }

  private session(c: ChannelConfig): SessionCursors {
    const s = (c.sessions[this.sessionId] ??= { at: "", cursors: {} });
    s.at = this.now().toISOString();
    return s;
  }

  private read(): ChannelConfig { return this.readChecked().config; }

  private readChecked(): { config: ChannelConfig; dirty: boolean } {
    if (!existsSync(this.file)) return { config: { weaves: {}, sessions: {} }, dirty: false };
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ChannelConfig>;
    const weaves: Record<string, JoinedWeave> = {};
    let dirty = false;
    for (const [id, entry] of Object.entries(raw.weaves ?? {})) {
      // Only known fields survive a load, so a legacy `secret` field (or anything else) is dropped.
      const { title, token, participantId, participantName, generalThreadId, wake, lastSeq } = entry;
      weaves[id] = { title, token, participantId, participantName, generalThreadId, wake, lastSeq };
      if (Object.keys(entry).length !== 7) dirty = true;
    }
    return { config: { url: raw.url, allowInsecure: raw.allowInsecure, weaves, sessions: raw.sessions ?? {} }, dirty };
  }

  /** Locked read-modify-write; the merged result becomes this process's snapshot. */
  private async mutate<T = void>(fn: (c: ChannelConfig) => T): Promise<T> {
    await this.acquireLock();
    try {
      const c = this.read();
      const result = fn(c);
      this.prune(c);
      // If another process judged this lock stale and took it over while we were in here, our
      // snapshot is no longer authoritative: abort rather than overwrite its write.
      if (!this.ownsLock()) throw new Error(`channel state lock ${this.lockFile} was taken over by another process; write aborted`);
      this.write(c);
      this.cache = c;
      return result;
    } finally {
      if (this.ownsLock()) rmSync(this.lockFile, { force: true });
    }
  }

  private ownsLock(): boolean {
    try { return readFileSync(this.lockFile, "utf8") === this.lockToken; } catch { return false; }
  }

  private prune(c: ChannelConfig): void {
    const cutoff = this.now().getTime() - SESSION_TTL_MS;
    for (const [id, s] of Object.entries(c.sessions)) {
      if (id !== this.sessionId && Date.parse(s.at) < cutoff) delete c.sessions[id];
    }
  }

  /** Atomic replace, with the temp file fsynced first so a crash right after the rename cannot
   * leave an empty or truncated config (and with it the participant tokens) behind. */
  private write(c: ChannelConfig): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(c, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  /** O_EXCL lock file holding "<pid>:<uuid>". A lock is only ever taken over from an owner that is
   * demonstrably dead (its pid no longer exists); a live owner keeps it however long it takes, and
   * we give up after LOCK_TIMEOUT_MS instead. Time-based takeover would let a merely paused owner
   * resume and overwrite the new owner's write. A lock without a readable pid (older tooling, or a
   * corrupt file) falls back to the age rule. */
  private async acquireLock(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const t0 = Date.now();
    for (;;) {
      try {
        writeFileSync(this.lockFile, this.lockToken, { flag: "wx" });
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (this.lockAbandoned()) { rmSync(this.lockFile, { force: true }); continue; }
        } catch { continue; /* lock vanished between the failed create and the inspection: retry now */ }
        if (Date.now() - t0 > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for channel state lock ${this.lockFile}`);
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
      }
    }
  }

  private lockAbandoned(): boolean {
    const owner = /^(\d+):/.exec(readFileSync(this.lockFile, "utf8"));
    if (owner) return !processAlive(Number(owner[1]));
    return Date.now() - statSync(this.lockFile).mtimeMs > STALE_LOCK_MS;
  }
}
