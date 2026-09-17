import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type Wake = "all" | "mentions";
export type JoinedWeave = {
  title: string; token: string; participantId: string; participantName: string;
  generalThreadId: string; wake: Wake;
  /** Machine-wide watermark: the highest seq any session on this machine has delivered. */
  lastSeq: number;
  /** Set when this Weave is the instance's Lobby (joined with join_lobby). Persisted rather than
   * re-derived, so a restarted plugin holding a stored Lobby credential still knows to clear the
   * profile before leaving — a decision that must not depend on reaching the server. */
  isLobby?: true;
};
/** What a session wants woken for in a Weave. `requests` governs solicitation only: whether a *new*
 *  Lobby request this session is eligible for wakes it. Events of a request it is already party to
 *  wake regardless — it caused them by opening or offering. */
export type Prefs = { wake: Wake; invites: boolean; requests: boolean };
/** Per-session delivery cursors and preferences, keyed by Claude Code session id (`CLAUDE_CODE_SESSION_ID`). */
export type SessionCursors = { at: string; cursors: Record<string, number>; prefs?: Record<string, Partial<Prefs>> };
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
/** A temp file written by `commit()`: `config.<version>.<pid>.<uuid>.tmp`. Group 1 is its writer's pid. */
const TMP_FILE = /^config\.\d+\.(\d+)\.[0-9a-f-]{36}\.tmp$/;
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

  /**
   * Marks a stored Weave as the Lobby. Idempotent, and it touches nothing else — an entry joined by
   * secret (or stored before the flag existed) keeps its identity, watermark and preferences and
   * simply gains the flag, which is what `leave_weave` reads to clear the profile first.
   */
  markLobby(id: string): Promise<void> {
    return this.mutate((c) => {
      const w = c.weaves[id];
      if (w) w.isLobby = true;
    });
  }

  removeWeave(id: string): Promise<void> {
    return this.mutate((c) => {
      delete c.weaves[id];
      for (const s of Object.values(c.sessions)) { delete s.cursors[id]; delete s.prefs?.[id]; }
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

  /** This session's effective preferences for a Weave: its own settings, else the legacy
   * machine-wide `wake` (kept for compatibility, no longer written), else all / invites on. */
  prefs(weaveId: string): Prefs {
    const c = this.get();
    const mine = c.sessions[this.sessionId]?.prefs?.[weaveId] ?? {};
    return { wake: mine.wake ?? c.weaves[weaveId]?.wake ?? "all", invites: mine.invites ?? true, requests: mine.requests ?? true };
  }

  /** The stored Lobby, if this machine has joined it: what `credential: "stored"` resolves to for
   * every Lobby tool, and what makes leave_weave clear the profile first. */
  lobbyEntry(): { weaveId: string; weave: JoinedWeave } | undefined {
    const found = Object.entries(this.get().weaves).find(([, w]) => w.isLobby);
    return found ? { weaveId: found[0], weave: found[1] } : undefined;
  }

  setPrefs(weaveId: string, patch: Partial<Prefs>): Promise<Prefs> {
    return this.mutate((c) => {
      const s = this.session(c);
      s.prefs ??= {};
      const cur = s.prefs[weaveId] ?? {};
      s.prefs[weaveId] = { ...cur, ...patch };
      const p = s.prefs[weaveId];
      return { wake: p.wake ?? c.weaves[weaveId]?.wake ?? "all", invites: p.invites ?? true, requests: p.requests ?? true };
    });
  }

  /** @deprecated Kept for compatibility; preferences are per session — see setPrefs. */
  setWake(id: string, wake: Wake): Promise<void> {
    return this.setPrefs(id, { wake }).then(() => {});
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
      const { title, token, participantId, participantName, generalThreadId, wake, lastSeq, isLobby } = entry;
      // `isLobby` is written only when true, so a file whose entry carries anything else — an
      // explicit false, a dropped legacy field — counts as dirty and is rewritten.
      weaves[id] = { title, token, participantId, participantName, generalThreadId, wake, lastSeq, ...(isLobby ? { isLobby: true as const } : {}) };
      if (Object.keys(entry).length !== Object.keys(weaves[id]!).length) dirty = true;
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
    const body = JSON.stringify({ ...c, commit: { id, parent } }, null, 2) + "\n";
    writeFileDurably(tmp, body);
    try {
      try {
        this.publish(tmp, target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        // The source is gone, not the filesystem's fault: something removed this writer's temp file
        // while it was paused (an older sweeper, or a cleaner outside Loom). Write it again and link
        // once more — the content is a pure function of the snapshot, so rewriting changes nothing.
        writeFileDurably(tmp, body);
        this.publish(tmp, target);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code === "ENOENT") throw new Error(`channel state temp file ${tmp} disappeared twice while publishing version ${base + 1}`);
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
   * file, and temp files abandoned by crashed writers.
   *
   * A temp file is abandoned when its writer's process is gone — the name carries that pid — not
   * when it is merely old: a writer suspended past any age threshold still wakes up and links its
   * file, and removing it under them turns a join into a lost participant token. Age remains the
   * only signal for a temp file whose name says nothing about who owns it. */
  private sweep(committed: number): void {
    for (const v of this.versions()) if (v < committed - 2) rmSync(this.versionPath(v), { force: true });
    rmSync(path.join(this.dir, LEGACY_FILE), { force: true });
    const cutoff = Date.now() - STALE_TMP_MS;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".tmp")) continue;
      const p = path.join(this.dir, f);
      const owner = Number(TMP_FILE.exec(f)?.[1]);
      try {
        if (Number.isInteger(owner)) { if (!pidAlive(owner)) rmSync(p, { force: true }); }
        else if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch { /* already gone */ }
    }
  }
}

/** A writer entry belongs to a process that still exists (and could therefore still resume and re-check). */
function writerAlive(writerId: string): boolean {
  return pidAlive(Number(/^(\d+):/.exec(writerId)?.[1]));
}

/** Whether a process id is still in use. EPERM means it exists but belongs to someone else. */
function pidAlive(pid: number): boolean {
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
