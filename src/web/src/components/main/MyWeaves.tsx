import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { LoomClientError, type LoomClient } from "@loom/client";
import type { KeyValueStorage, WriteResult } from "../../storage.js";
import type { WeavesSignal } from "../../weaves-signal.js";
import {
  forgetWeave, hasIdentity, invalidateIdentity, isCredentialFailure, readerFor, readWeaveEntry,
  saveWeaveEntry, storedWeaves, type StoredWeave,
} from "../../weaves-store.js";
import { createRefreshQueue, type RefreshQueue } from "./refresh-queue.js";

/** Requests in flight for this browser at any instant — in total and across renders (spec §4.2). */
const IN_FLIGHT = 6;
/** Rows past this are behind "Show more"; the filter box appears once there are more than eight. */
const PAGE = 25;
const FILTER_FROM = 8;

/** What a row shows for a Weave whose title this browser has never been told. */
const UNKNOWN_TITLE = "(title unknown)";
const GONE = "this Weave is gone";
const FAILED = "could not refresh";

export type WeaveRow = {
  weaveId?: string; secret?: string; title: string;
  /** `"unresolved"` is a legacy row nothing has turned into a Weave id yet: it has no `weaveId`, so
   *  it cannot be linked to and cannot be Forgotten either — `forget()` needs one. */
  state: "joined" | "read-only" | "identity-invalid" | "unavailable" | "unresolved";
  joinedAs?: string; isLobby: boolean; archived: boolean; lastOpenedAt?: string;
  /** What the stored entry alone already says (e.g. an unresolved legacy row's unknown title). The
   *  refresh's own markers live in component state keyed by `rowKey`, because they are not in
   *  storage and must survive a re-derive; a row renders `notes[rowKey(row)] ?? row.note`. */
  note?: string;
};

/** A row's identity across a re-derive. An unresolved legacy row has no id yet, only its secret. */
export function rowKey(row: WeaveRow): string {
  return row.weaveId ?? `legacy:${row.secret ?? ""}`;
}

type IdEntry = Extract<StoredWeave, { kind: "id" }>;

/** The §4.2 row states, every one of them a question the stored entry already answers. */
function idRow(e: IdEntry, lobbyWeaveId?: string): WeaveRow {
  const joined = hasIdentity(e);
  const invalid = e.identity === "invalid";
  const state: WeaveRow["state"] = joined ? "joined"
    : invalid ? (e.secret !== undefined ? "identity-invalid" : "unavailable")
      : e.secret !== undefined ? "read-only" : "unavailable";
  return {
    weaveId: e.weaveId, secret: e.secret, title: e.title ?? UNKNOWN_TITLE, state,
    // The name is part of the identity and is deleted with it, so an invalidated row never claims one.
    joinedAs: joined ? e.name : undefined,
    isLobby: e.weaveId === lobbyWeaveId, archived: !!e.archived, lastOpenedAt: e.lastOpenedAt,
    // The two dead-end states say why here rather than through `state`, because "the identity died
    // and there was no link" and "this browser never held a credential" are different sentences.
    note: state !== "unavailable" ? undefined
      : invalid ? "your identity here stopped working, and this browser has no link for it"
        : "this browser holds no key for this Weave",
  };
}

/**
 * Folds a legacy entry into an id entry when their `secret` matches, else when their `token` does.
 *
 * Only the row count is folded: the id entry wins whole, and nothing of the legacy entry is carried
 * onto it. Merging credentials is `mergeLegacy`'s job, on the one path that also writes them
 * (`migrateLegacyOne`), so a row here never offers a credential that `refreshRow` — which reads the
 * stored entry, not the row — would not find.
 */
export function foldRows(stored: StoredWeave[], lobbyWeaveId?: string): WeaveRow[] {
  const ids = stored.filter((s): s is IdEntry => s.kind === "id");
  const rows = ids.map((e) => idRow(e, lobbyWeaveId));
  for (const s of stored) {
    if (s.kind !== "legacy") continue;
    const folded = ids.some((e) => (e.secret !== undefined && e.secret === s.secret)
      || (e.token !== undefined && e.token === s.token));
    if (folded) continue;
    // Nothing has resolved this link into a Weave id yet (spec §4.2): its title is unknown, it
    // cannot be linked to — `/weave/<id>` is the only row link there is — and Copy link still works.
    rows.push({
      secret: s.secret, title: UNKNOWN_TITLE, state: "unresolved",
      isLobby: false, archived: false, note: "not resolved yet",
    });
  }
  return rows;
}

/** The one line §4.2 gives each row state. `undefined` where the row's own `note` says it instead —
 *  which is both dead ends and the unresolved legacy row. */
function stateText(row: WeaveRow): string | undefined {
  if (row.state === "joined") return row.joinedAs === undefined ? undefined : `joined as ${row.joinedAs}`;
  if (row.state === "read-only") return "read-only — not joined";
  if (row.state === "identity-invalid") return "your identity here stopped working — open to rejoin";
  return undefined;
}

/**
 * Every Weave this browser holds something for (spec §4.2).
 *
 * Three rules hold this component together. It **renders from storage with no network at all** —
 * the cached `title`/`archived` of §2.4, so a browser with 300 entries paints instantly. It
 * **follows storage**: rows are re-derived on every `WeavesSignal` bump rather than captured at
 * mount, so a migration that finishes after the first paint, a refreshed title and an invalidated
 * identity all reach the screen with nothing clicked. And it **reports every write it makes** to
 * `onWrite` — always `notice.note` — so the one-time notice of §6 covers these writes too.
 *
 * The refresh is lazy and bounded, and the bound is on the browser rather than on one render: the
 * component owns exactly one `createRefreshQueue(6, …)` for the life of the mount, and the effect
 * below only computes what is newly on screen and hands it over.
 */
export function MyWeaves({ client, storage, weaves, onWrite, lobbyWeaveId }: {
  client: LoomClient; storage: KeyValueStorage; weaves: WeavesSignal;
  /** Every write this list makes reports its verdict here. Always `notice.note`. */
  onWrite: (r: WriteResult) => void;
  lobbyWeaveId?: string;
}) {
  // Anything that writes an entry bumps the signal; this is the one place that listens. Storage
  // itself stays a plain KeyValueStorage (spec §4.2) — the session and every test inject it.
  const [version, setVersion] = useState(0);
  useEffect(() => weaves.subscribe(() => setVersion((n) => n + 1)), [weaves]);   // unmount unsubscribes
  const rows = useMemo(() => foldRows(storedWeaves(storage), lobbyWeaveId), [storage, lobbyWeaveId, version]);

  // Per-row facts that are *not* in storage: "could not refresh", "this Weave is gone". Keyed by the
  // row, so a re-derive after a bump does not lose them and does not mix them up.
  const [notes, setNotes] = useState<Record<string, string>>({});
  /**
   * What the last Copy link came to, for the **one** row it was clicked on: `"done"` when the
   * clipboard took the link, `"manual"` when there was no clipboard to take it (an insecure origin
   * has none) or it refused. One row rather than a map, because the manual fallback puts a secret on
   * screen: opening a second row's closes the first, so at most one link is ever legible.
   *
   * No timer clears it — a timer would have to be cancelled on unmount and is not worth owning.
   * Its exits are the row's own **Hide**, the next filter keystroke, "Show more", a Forget of that
   * row, and unmount.
   */
  const [copied, setCopied] = useState<{ key: string; mark: "done" | "manual" } | undefined>();
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(PAGE);

  // "This component is still mounted." Checked before every state touch a finished request makes,
  // because `dispose()` only stops rows that have not started — the six in flight still resolve.
  const alive = useRef(true);

  const markRow = (row: WeaveRow, e: unknown) =>
    setNotes((n) => ({ ...n, [rowKey(row)]: e instanceof LoomClientError && e.code === "weave_not_found" ? GONE : FAILED }));

  const needle = filter.trim().toLowerCase();
  const sorted = [...rows].sort((a, b) =>
    (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? "") || a.title.localeCompare(b.title));
  const matching = needle === "" ? sorted : sorted.filter((r) => r.title.toLowerCase().includes(needle));
  /** The rows this render actually puts on screen — the definition of "on screen" §4.2 refreshes. */
  const visible = matching.slice(0, limit);

  /** One row's refresh. `readerFor` is the shared rule, so a row is never read with a credential the
   *  page itself would not have used — most rows have a token, but an unjoined or invalidated one
   *  has only a secret, and a `withToken(undefined)` call would simply 401. */
  const refreshRow = async (row: WeaveRow): Promise<void> => {
    if (!row.weaveId) return;
    const weaveId = row.weaveId;
    const choice = readerFor(client, readWeaveEntry(storage, weaveId));
    if (!choice) return;                                   // nothing to read with: keep the cache as it is
    try {
      const info = await choice.reader.getWeave(weaveId);
      if (!alive.current) return;                          // unmounted mid-flight: the request finishes,
                                                           // this component does not. Every path out of
                                                           // the await is gated, so nothing calls
                                                           // `onWrite`, `weaves.bump()` or `markRow`
                                                           // after `dispose()`.
      // The verdict goes to the notice like every other write on this page: a title that reached only
      // memory is the same degraded browser a join or a creation would have found (spec §4.2, §6).
      // Into a variable first — nested in an optional call the write itself would not happen.
      const result = saveWeaveEntry(storage, weaveId, { title: info.weave.title, archived: !!info.weave.archivedAt });
      onWrite(result);
      weaves.bump();                                       // the stored row changed: re-derive the list
    } catch (e) {
      if (!alive.current) return;                          // same gate on the failure path
      if (choice.withToken && isCredentialFailure(e)) {
        // Exactly what the session does (spec §2.6): the identity goes, the secret stays, and a
        // stored secret gets one more try — so a dead token costs a row its identity, not its title.
        // Reported, and never silent: an invalidation that reached only memory leaves this page
        // saying the identity is dead while `localStorage` still holds the old token, which the
        // human is told about once. The bump is immediate, so the row changes state before the
        // retry even starts.
        onWrite(invalidateIdentity(storage, weaveId));
        weaves.bump();
        // The retry is awaited *inside this same slot*: a row that invalidates costs the bound one
        // request at a time, never two, and never jumps the FIFO ahead of rows that have waited.
        const again = readerFor(client, readWeaveEntry(storage, weaveId));
        if (again) return await refreshRow(row);
        // Nothing left to read with, so this row is over, not merely unlucky. The entry the
        // invalidation just wrote explains it in its own words ("your identity here stopped
        // working, and this browser has no link for it"), and the bump above has already re-derived
        // the row from it — `markRow`'s transient-sounding marker would be rendered *instead* of
        // that sentence and would be the wrong thing to tell the human.
        return;
      }
      markRow(row, e);                                     // 404 → "this Weave is gone"; else the quiet marker
    }
  };

  // `refreshRow` closes over `client`, `storage`, `weaves` and `onWrite`, so a new one exists on every
  // render, while the queue is built once. The queue therefore calls the row refresh *indirectly*,
  // through a ref that each render updates — never the closure that happened to exist at mount, which
  // would keep writing through a stale `onWrite` after `MainPage` re-rendered.
  const latestRefresh = useRef(refreshRow);
  useEffect(() => { latestRefresh.current = refreshRow; });   // no dep array: every render, and this
                                                             // effect is declared *before* the one
                                                             // below, so it has already run when a
                                                             // freshly enqueued row starts

  // One queue for the life of this mount. `useRef(createRefreshQueue(...))` would build — and throw
  // away — a new queue on every render, which is exactly the bug this replaces, so it is built lazily
  // on first use instead.
  const queueRef = useRef<RefreshQueue<WeaveRow> | null>(null);
  if (queueRef.current === null) {
    queueRef.current = createRefreshQueue<WeaveRow>(IN_FLIGHT, (row) => latestRefresh.current(row));
  }
  useEffect(() => () => { alive.current = false; queueRef.current?.dispose(); }, []);   // unmount

  // Which rows have been fetched (or are in flight, or are queued) this page, by row key rather than
  // by position — a bump re-derives the whole list, and this must survive that. A ref, not state:
  // changing it must not itself cause a render.
  const fetched = useRef(new Set<string>());
  useEffect(() => {
    // Runs on every render, which is cheap and correct: `pending` is empty unless a row entered the
    // slice ("Show more", a filter cleared, or a legacy row that migration has just resolved into a
    // row with an id — which is a new key and genuinely does want one fetch).
    const pending = visible.filter((r) => !fetched.current.has(rowKey(r)));
    if (pending.length === 0) return;
    for (const r of pending) fetched.current.add(rowKey(r));   // claimed *before* enqueueing, so a
    queueRef.current!.enqueue(pending);                        // bump mid-flight cannot queue it twice
  });                                                          // no dep array: every render, by design

  const forget = (row: WeaveRow) => {
    if (!row.weaveId) return;
    // The one write on this page that reports nothing, and deliberately so: `remove` returns no
    // verdict, and §2.4b's tombstone makes a removal that never reached `localStorage` read as
    // absent for the rest of this page anyway — the row goes and stays gone. The whole cost of a
    // failed removal is that the entry is back after a reload, and no credential was lost.
    forgetWeave(storage, row.weaveId);
    // Everything this page remembers *about the row* rather than about the entry goes with it.
    // None of it is in storage, so nothing else would ever drop it: a Weave forgotten after a 404
    // and re-acquired in the same page (a creation, or a join) would otherwise be born carrying
    // "this Weave is gone" and never be read again, because its key is still claimed.
    const key = rowKey(row);
    fetched.current.delete(key);
    setNotes(({ [key]: _note, ...rest }) => rest);
    setCopied((c) => (c?.key === key ? undefined : c));
    weaves.bump();
  };

  /** Which Copy link click the answer on screen belongs to. A second click closes the first row's
   *  fallback at once, so a slower answer from that first click must not reopen it. */
  const copyClick = useRef(0);

  /** Copy link, which must always answer: an insecure origin has no `navigator.clipboard` at all,
   *  and a clipboard that exists can refuse — by rejecting, or, in some implementations, by
   *  throwing outright when the document is unfocused or the permission is denied. All three land
   *  in the manual fallback, which is the one place the secret reaches the DOM, and only after an
   *  explicit click on that row (§5). */
  const copyLink = (row: WeaveRow, link: string) => {
    const key = rowKey(row);
    const ticket = ++copyClick.current;
    setCopied(undefined);                    // whatever was open closes now, not when this answers
    const answer = (mark: "done" | "manual") => {
      if (alive.current && copyClick.current === ticket) setCopied({ key, mark });
    };
    let written: Promise<void> | undefined;
    try { written = navigator.clipboard?.writeText(link); } catch { answer("manual"); return; }
    if (written === undefined) { answer("manual"); return; }
    // Handled, not `void`ed: a refused write is an ordinary outcome of this button, and leaving it
    // to surface as an unhandled rejection would tell the human nothing and the console too much.
    written.then(() => answer("done"), () => answer("manual"));
  };

  return (
    <section class="my-weaves">
      <h2>My Weaves</h2>
      {rows.length === 0
        ? <p class="muted">This browser holds no Weaves yet.</p>
        : (
          <>
            {/* A typed filter keeps its box however short the list gets: Forgetting down to eight
                rows would otherwise take the control away while the filter was still in force. */}
            {(rows.length > FILTER_FROM || filter !== "") && (
              <label class="weave-filter">Filter
                <input value={filter}
                  onInput={(e) => { setFilter((e.target as HTMLInputElement).value); setCopied(undefined); }} />
              </label>
            )}
            {matching.length === 0 && <p class="muted">No Weave matches.</p>}
            <ul class="weave-list">
              {visible.map((row) => {
                const key = rowKey(row);
                const note = notes[key] ?? row.note;
                // "Nothing here can be opened": either the entry has no credential left, or the
                // server has answered that the Weave is gone. Both offer Forget and nothing else —
                // a gone Weave's link leads nowhere either, so Copy link goes with the row link.
                const dead = row.state === "unavailable" || note === GONE;
                const link = row.secret === undefined ? undefined : `${location.origin}/w/${row.secret}`;
                return (
                  <li key={key} class={`weave-row${dead ? " weave-row-dead" : ""}`}>
                    {!dead && row.weaveId !== undefined
                      ? <a class="weave-row-title" href={`/weave/${row.weaveId}`}>{row.title}</a>
                      : <span class="weave-row-title">{row.title}</span>}
                    {row.isLobby && <span class="badge">Lobby</span>}
                    {row.archived && <span class="badge">Archived</span>}
                    {stateText(row) !== undefined && <span class="weave-row-state">{stateText(row)}</span>}
                    {note !== undefined && <span class="weave-row-note">{note}</span>}
                    {!dead && link !== undefined && (
                      // Named after the row: twenty-five rows are otherwise twenty-five buttons
                      // called "Copy link", which is no help to anyone reaching them by name.
                      <button type="button" class="weave-row-copy" aria-label={`Copy link to ${row.title}`}
                        onClick={() => copyLink(row, link)}>Copy link</button>
                    )}
                    {copied?.key === key && copied.mark === "done" && <span class="weave-row-copied">Copied</span>}
                    {copied?.key === key && copied.mark === "manual" && link !== undefined && (
                      <span class="weave-row-copy-manual">
                        Could not copy it for you — here it is:
                        <input class="weave-row-link" readOnly value={link} aria-label={`Link to ${row.title}`} />
                        <button type="button" class="weave-row-hide" aria-label={`Hide the link to ${row.title}`}
                          onClick={() => setCopied(undefined)}>Hide</button>
                      </span>
                    )}
                    {dead && row.weaveId !== undefined && (
                      <button type="button" class="weave-row-forget" aria-label={`Forget ${row.title}`}
                        onClick={() => forget(row)}>Forget</button>
                    )}
                  </li>
                );
              })}
            </ul>
            {matching.length > limit && (
              <button type="button" class="weave-more"
                onClick={() => { setLimit((n) => n + PAGE); setCopied(undefined); }}>Show more</button>
            )}
          </>
        )}
    </section>
  );
}
