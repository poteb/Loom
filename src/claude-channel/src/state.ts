import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
export class ChannelState {
  private cache: ChannelConfig | undefined;
  readonly file: string;
  private readonly lockFile: string;

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

  load(): ChannelConfig {
    const { config, dirty } = this.readChecked();
    // A file carrying fields this version does not know (e.g. the legacy `secret`) is rewritten
    // clean right away so the unknown data does not linger on disk.
    if (dirty) this.write(config);
    this.cache = config;
    return config;
  }

  /** Last snapshot this process saw; loads on first use. */
  get(): ChannelConfig { return this.cache ?? this.load(); }

  /** This session's next `since` for a Weave: its own cursor if it has one, else the machine-wide watermark. */
  cursor(weaveId: string): number {
    const c = this.get();
    return c.sessions[this.sessionId]?.cursors[weaveId] ?? c.weaves[weaveId]?.lastSeq ?? 0;
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
  private async mutate(fn: (c: ChannelConfig) => void): Promise<void> {
    await this.acquireLock();
    try {
      const c = this.read();
      fn(c);
      this.prune(c);
      this.write(c);
      this.cache = c;
    } finally {
      rmSync(this.lockFile, { force: true });
    }
  }

  private prune(c: ChannelConfig): void {
    const cutoff = this.now().getTime() - SESSION_TTL_MS;
    for (const [id, s] of Object.entries(c.sessions)) {
      if (id !== this.sessionId && Date.parse(s.at) < cutoff) delete c.sessions[id];
    }
  }

  private write(c: ChannelConfig): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** O_EXCL lock file; a lock older than STALE_LOCK_MS is assumed abandoned by a crashed process. */
  private async acquireLock(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const t0 = Date.now();
    for (;;) {
      try {
        closeSync(openSync(this.lockFile, "wx"));
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(this.lockFile).mtimeMs > STALE_LOCK_MS) { rmSync(this.lockFile, { force: true }); continue; }
        } catch { continue; /* lock vanished between the failed create and the stat: retry now */ }
        if (Date.now() - t0 > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for channel state lock ${this.lockFile}`);
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
      }
    }
  }
}
