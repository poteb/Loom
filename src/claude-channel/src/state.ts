import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
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
  /** Per writer (process, keyed "<pid>:<uuid>"), the id of its most recent commit. Carried forward
   * by every descendant version, so a writer can prove its commit is in the lineage no matter how
   * many commits and sweeps followed. Internal bookkeeping. An entry is dropped only once its
   * writer's process no longer exists — a process that is gone cannot resume and re-check, whereas
   * a live one may have been suspended for any length of time. */
  writers: Record<string, { id: string; at: string }>;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_COMMIT_ATTEMPTS = 100;
const MAX_SNAPSHOT_ATTEMPTS = 10;
const STALE_TMP_MS = 60_000;
const VERSION_FILE = /^config\.(\d+)\.json$/;
const LEGACY_FILE = "config.json";

/** `id` is the commit id of the version the config came from (undefined for legacy/empty). */
type Snapshot = { config: ChannelConfig; base: number; dirty: boolean; id: string | undefined };
type Parsed = { config: ChannelConfig; dirty: boolean; id: string | undefined; parent: string | undefined };

/**
 * The channel's persistent state, shared by every channel process on the machine.
 *
 * Identity (participant tokens) is deliberately machine-wide: one "ClaudeCode" participant per
 * machine, whichever session is talking. Delivery position is per session: each Claude Code session
 * (identified by `CLAUDE_CODE_SESSION_ID`, stable across `--resume`/`--continue`) keeps its own
 * cursor so a resumed session replays exactly what *it* missed, while a brand-new session starts at
 * the machine-wide watermark rather than replaying history another session already handled.
 *
 * Concurrency is optimistic and lock-free. The state lives in versioned files `config.<n>.json`;
 * a mutation reads the newest version n, applies its change, and commits by *creating*
 * `config.<n+1>.json` exclusively as a hard link of a fully written, fsynced temp file. A hard link
 * publishes complete content and claims the name in one atomic step, so it acts as a
 * compare-and-swap on the version number: if another process committed n+1 first, the link fails
 * and the mutation is re-applied to the fresh snapshot.
 *
 * A writer that was paused long enough for its number to be superseded *and* swept can still
 * create the file, so a successful link is not yet proof of landing. Proof travels inside the
 * state: every commit records `writers[<this process>] = <commit id>`, and every descendant copies
 * that map forward. After publishing, the writer reads the newest state; if its own entry there is
 * the id it just committed, its change is in the lineage (however many commits and sweeps
 * followed). If not, the newest state does not descend from its version — a stale claim of a swept
 * number — and the mutation is re-applied on a fresh snapshot. Mutations are never re-applied over
 * their own descendants. Writer entries are pruned only when the writer's process is gone (it can
 * no longer resume), never by age: a live process may have been suspended for days. No lock file,
 * hence nothing to reclaim from a crashed or paused process. Filesystems without hard links are
 * refused.
 */
export class ChannelState {
  private cache: ChannelConfig | undefined;
  /** Identifies this process among writers; see ChannelConfig.writers. */
  private readonly writerId = `${process.pid}:${randomUUID()}`;

  constructor(readonly dir: string, readonly sessionId: string = ChannelState.sessionIdFrom(process.env), private readonly now: () => Date = () => new Date()) {}

  static dirFrom(env: NodeJS.ProcessEnv): string {
    if (env.LOOM_CHANNEL_STATE_DIR) return env.LOOM_CHANNEL_STATE_DIR;
    const home = env.HOME ?? env.USERPROFILE ?? ".";
    return path.join(home, ".claude", "channels", "loom");
  }

  /** Claude Code's session id when it provides one; otherwise a per-process id (no resume semantics). */
  static sessionIdFrom(env: NodeJS.ProcessEnv): string {
    return env.CLAUDE_CODE_SESSION_ID ?? `pid:${process.pid}`;
  }

  /** Path of the newest committed state file (the legacy `config.json` until the first commit). */
  get file(): string {
    const v = this.versions();
    return v.length ? this.versionPath(v[0]!) : path.join(this.dir, LEGACY_FILE);
  }

  /** Reloads from disk. Never writes. */
  load(): ChannelConfig {
    const { config } = this.snapshot();
    this.cache = config;
    return config;
  }

  /** Rewrites state that is still in the legacy file or carries fields this version does not know. */
  async migrate(): Promise<void> {
    if (this.snapshot().dirty) await this.mutate(() => {});
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
      const existing = c.weaves[id];
      const s = this.session(c);
      if (existing?.token === w.token) {
        // Same identity already stored (this very join re-applied over its own descendant, or a
        // redundant re-store): keep whatever progress the watermark and this session's cursor made.
        c.weaves[id] = { ...w, lastSeq: Math.max(existing.lastSeq, w.lastSeq) };
        s.cursors[id] ??= w.lastSeq;
        return;
      }
      // A new identity: a fresh join resets where this session listens from; other sessions keep their own cursors.
      c.weaves[id] = w;
      s.cursors[id] = w.lastSeq;
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

  /**
   * Optimistic read-modify-commit. `fn` must be a pure function of the snapshot it is given: it is
   * re-run on a fresh snapshot whenever another process committed first.
   */
  private async mutate<T = void>(fn: (c: ChannelConfig) => T): Promise<T> {
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
      const { config, base, id } = this.snapshot();
      const result = fn(config);
      this.prune(config);
      if (this.commit(base, id, config)) {
        this.cache = config;
        return result;
      }
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
    throw new Error(`could not commit channel state in ${this.dir}: lost the version race ${MAX_COMMIT_ATTEMPTS} times`);
  }

  private prune(c: ChannelConfig): void {
    const cutoff = this.now().getTime() - SESSION_TTL_MS;
    for (const [id, s] of Object.entries(c.sessions)) {
      if (id !== this.sessionId && Date.parse(s.at) < cutoff) delete c.sessions[id];
    }
  }

  /** Version numbers present on disk, newest first (unreadable files included: they still occupy their number). Test seam. */
  protected versions(): number[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((f) => VERSION_FILE.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a);
  }

  private versionPath(v: number): string { return path.join(this.dir, `config.${v}.json`); }

  /**
   * Newest readable state. `base` is the highest version number on disk (readable or not), so the
   * next commit never reuses a number; `config` comes from the newest version that parses.
   *
   * The versions we list can be swept from under us by a writer that commits twice in between, so
   * a listing whose files are all gone is re-enumerated rather than mistaken for an empty store.
   * A listing that is stable yet unreadable means corruption: that throws instead of silently
   * resetting the state (and with it the participant tokens) to empty.
   */
  private snapshot(): Snapshot {
    let versions = this.versions();
    for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt++) {
      for (const v of versions) {
        const parsed = this.parse(this.versionPath(v));
        if (parsed) return { config: parsed.config, base: versions[0]!, dirty: parsed.dirty, id: parsed.id };
      }
      if (versions.length > 0) {
        const again = this.versions();
        if (again[0] === versions[0]) throw new Error(`channel state in ${this.dir} is unreadable (newest version ${versions[0]}); refusing to reset it`);
        versions = again;
        continue;
      }
      // No versions: either a fresh or legacy store, or another process is migrating the legacy
      // file right now (it commits version 1, then removes config.json).
      const legacyPath = path.join(this.dir, LEGACY_FILE);
      const legacy = this.parse(legacyPath);
      if (legacy) return { config: legacy.config, base: 0, dirty: true, id: undefined };
      if (existsSync(legacyPath)) throw new Error(`channel state in ${this.dir} is unreadable (legacy config.json); refusing to reset it`);
      versions = this.versions();
      if (versions.length === 0) return { config: { weaves: {}, sessions: {}, writers: {} }, base: 0, dirty: false, id: undefined };
    }
    throw new Error(`channel state in ${this.dir} kept changing under us; giving up after ${MAX_SNAPSHOT_ATTEMPTS} attempts`);
  }

  private parse(file: string): Parsed | undefined {
    let raw: Partial<ChannelConfig> & { commit?: { id?: string; parent?: string } };
    try { raw = JSON.parse(readFileSync(file, "utf8")) as typeof raw; } catch { return undefined; }
    if (!raw || typeof raw !== "object") return undefined;
    const weaves: Record<string, JoinedWeave> = {};
    let dirty = false;
    for (const [id, entry] of Object.entries(raw.weaves ?? {})) {
      // Only known fields survive a load, so a legacy `secret` field (or anything else) is dropped.
      const { title, token, participantId, participantName, generalThreadId, wake, lastSeq } = entry;
      weaves[id] = { title, token, participantId, participantName, generalThreadId, wake, lastSeq };
      if (Object.keys(entry).length !== 7) dirty = true;
    }
    return { config: { url: raw.url, allowInsecure: raw.allowInsecure, weaves, sessions: raw.sessions ?? {}, writers: raw.writers ?? {} }, dirty, id: raw.commit?.id, parent: raw.commit?.parent };
  }

  /**
   * Compare-and-swap commit of `base + 1`: the content is fully written and fsynced to a private
   * temp file, then published under the version name as a hard link, which claims the name and
   * exposes the complete content atomically. Returns false if someone else published that version
   * first, or if this writer was so delayed that its number was already superseded and swept (the
   * file is created but nothing descends from it, so no reader ever uses it).
   */
  private commit(base: number, parent: string | undefined, c: ChannelConfig): boolean {
    mkdirSync(this.dir, { recursive: true });
    const target = this.versionPath(base + 1);
    const tmp = path.join(this.dir, `config.${base + 1}.${process.pid}.${randomUUID()}.tmp`);
    const id = randomUUID();
    for (const w of Object.keys(c.writers)) if (w !== this.writerId && !writerAlive(w)) delete c.writers[w];
    c.writers[this.writerId] = { id, at: this.now().toISOString() };
    writeFileDurably(tmp, JSON.stringify({ ...c, commit: { id, parent } }, null, 2) + "\n");
    try {
      this.publish(tmp, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new Error(`channel state dir ${this.dir} must be on a filesystem that supports hard links (NTFS, ext4, APFS, …): ${(e as Error).message}`);
    } finally {
      rmSync(tmp, { force: true });
    }
    if (!this.landed(base + 1, id)) return false;
    this.sweep(base + 1);
    return true;
  }

  /** Our version landed if it is the newest, or if the newest readable state still carries our
   * writer entry with this commit id — every descendant copies `writers` forward, so this holds
   * however many commits and sweeps followed. A newest state without it does not descend from our
   * version: ours was a stale claim of a swept number, and no reader ever used it. */
  private landed(version: number, id: string): boolean {
    if (this.versions()[0] === version) return true;
    return this.snapshot().config.writers[this.writerId]?.id === id;
  }

  /** Atomic claim-and-publish. Test seam. */
  protected publish(tmp: string, target: string): void { linkSync(tmp, target); }

  /** After a successful commit: drop versions older than the two before it (a concurrent reader may
   * still be on `committed - 1`; a delayed writer may need `committed - 1`'s parent link), the legacy
   * file, and temp files abandoned by crashed writers. */
  private sweep(committed: number): void {
    for (const v of this.versions()) if (v < committed - 2) rmSync(this.versionPath(v), { force: true });
    rmSync(path.join(this.dir, LEGACY_FILE), { force: true });
    const cutoff = Date.now() - STALE_TMP_MS;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".tmp")) continue;
      const p = path.join(this.dir, f);
      try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* already gone */ }
    }
  }
}

/** A writer entry belongs to a process that still exists (and could therefore still resume and re-check). */
function writerAlive(writerId: string): boolean {
  const pid = Number(/^(\d+):/.exec(writerId)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Writes and fsyncs a whole file (mode 0600). */
function writeFileDurably(file: string, data: string): void {
  const fd = openSync(file, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
