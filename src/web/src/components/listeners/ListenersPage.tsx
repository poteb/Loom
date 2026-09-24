import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { LoomClientError } from "@loom/client";
import type { Listener, ListenersFacets, ListenersSort, Profile, ServesKind } from "@loom/client";
import type { Session } from "../../session.js";
import { viewOfPath } from "../../lobby-view.js";
import { ProfileCard, agoText, modelSpecs } from "../ProfileCard.js";
import { FacetChips, ModelChips } from "./FacetChips.js";
import {
  EMPTY_VIEW, queryFromView, viewFromSearch, writeSearch, type ListenersView,
} from "./listeners-query.js";

/** Spec §5.3: one page of 50, and "Show more" appends the next. */
const PAGE = 50;
const DEBOUNCE_MS = 250;

/**
 * Core's own bounds on a query, quoted where a control has to stop at them: `MAX_Q` in
 * `listeners-input.ts` for the search, and the 20 alternatives / 50 tools of `matching.ts`'s
 * `reqSchema`, which the listeners filter reuses. Past any of them core answers `validation`, so a
 * control that let a human go there would turn a keystroke or a click into an error line for a
 * query that was never going to be asked.
 */
const MAX_Q = 100;
const MAX_MODELS = 20;
const MAX_TOOLS = 50;

/**
 * The page's four cells, as one value. An **error is a state of its own**, never an empty `rows`:
 * "No listener matches these filters" is rendered only for a *successful* read that returned zero,
 * and a rejected query keeps whatever rows are on screen (spec §7). `moreError` is separate because
 * a failed "Show more" is local to its button and must not paint over the rows above it.
 */
type PageState = {
  status: "loading" | "ready" | "error";
  rows: Listener[];
  total?: number; matched?: number;
  facets?: ListenersFacets;
  nextCursor?: string;
  error?: string;
  moreError?: string;
  appending?: boolean;
};

const SORTS: { value: ListenersSort; label: string }[] = [
  { value: "name", label: "Name" }, { value: "owner", label: "Owner" }, { value: "joined", label: "Joined" },
];
/** The three stored words, said the way §5.3 says them. The URL still carries the words themselves. */
const SERVES: Record<string, string> = { anyone: "anyone", owner: "its owner", list: "a named list" };

/** The table's columns, in order; the details row spans all of them. */
const COLUMNS = ["Listener", "Owner", "Models", "Tools", "Runtime", "Serves", "Last seen", "Joined", "Actions"];

/**
 * Where a row's Invite goes: the Thread this browser has open. `WeaveView` hands it down only when
 * `canEditThread` says this browser may invite to that Thread, so its absence is the whole of "no
 * Invite on any row". `invited` is the session's own record of who already is (`state.invited`).
 */
export type InviteTarget = { threadId: string; invited?: ReadonlySet<string>; meId?: string };

/**
 * The Lobby's directory: search, four facet filters, sort, the listeners table and Show more
 * (spec §5.3). One view of the Lobby page, and it reads nothing from `SessionState` itself: what it
 * has is a session to ask, its own answers, and the one slice `WeaveView` hands it for the rows'
 * Invite. The only live thing on it is the quiet "the list has changed" line, because it has no
 * stream of its own (§5.5).
 */
export function ListenersPage({ session, invite }: { session: Session; invite?: InviteTarget }) {
  // The link this page was opened with, read once. `partial` latches with it: it describes that
  // link, not the controls, which the human has been driving ever since.
  //
  // Read where it is written (spec §4.3): one condition governs both halves, so there is no browser
  // that seeds itself from an address it then refuses to keep up to date.
  const opened = useMemo(
    () => viewOfPath(location.pathname) === "listeners"
      ? viewFromSearch(location.search) : { view: EMPTY_VIEW, partial: false }, []);
  const [view, setView] = useState<ListenersView>(opened.view);
  const [draft, setDraft] = useState(opened.view.q);
  // The view and the draft are also held in refs, because the debounce timer and every control read
  // them from a callback that outlives the render it was created in. A `setTimeout` closing over a
  // render's `view` fires 250 ms later holding the page **as it was before** whatever was clicked in
  // between, and writes it back over the top.
  const viewRef = useRef(view);
  const draftRef = useRef(draft);
  const [state, setState] = useState<PageState>({ status: "loading", rows: [] });
  const [changed, setChanged] = useState(false);
  // A row's failed Invite, on this page's own line: the error bar belongs to the header and the
  // sidebar panels, and an invite made from here is this page's to report.
  const [inviteError, setInviteError] = useState<string | undefined>();
  // One generation for the page: every query takes the next number and applies its answer — or its
  // rejection — only while it is still the newest thing asked for (spec §7).
  const gen = useRef(0);
  const live = useRef(true);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The first answer's `total`, which every later answer is compared against (spec §5.5). */
  const firstTotal = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    live.current = false;
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const run = (next: ListenersView, cursor?: string) => {
    const n = ++gen.current;
    setState((s) => cursor
      ? { ...s, appending: true, moreError: undefined }
      // A fresh query's first page is a different question, so the cursor the *old* one answered
      // with is dropped the moment this one starts — not when it answers, and not at all if it
      // fails (spec §5.3, §2.5). Left on screen, "Show more" would send the old view's cursor with
      // the new view, take the newer generation with it, and append a page of one query onto the
      // rows of another: "Showing 60 of 12 matches". The answer re-sets it; a failure leaves the
      // rows and no button, which is the truthful state.
      : { ...s, status: "loading", error: undefined, moreError: undefined, appending: false,
          nextCursor: undefined });
    // The facets are asked for on every query but Show more's: they describe the *filters*, which
    // appending a page cannot change, and they are the most expensive read this query makes (§6).
    // The page keeps the ones it has (`page.facets ?? s.facets` below).
    // Two calls, deliberately: reading the directory is not the same act as spending the page's one
    // credential recovery, and only the second needs an owner (spec §6.1). `issue` names the very
    // reader this request went out with, so it cannot be captured a moment too late.
    const { issue, page: answer } = session.listListeners(
      queryFromView(next, { limit: PAGE, cursor, facets: cursor === undefined }));
    answer.then(
      (page) => {
        if (!live.current || n !== gen.current) return;
        if (firstTotal.current === undefined) firstTotal.current = page.total;
        else if (page.total !== firstTotal.current) setChanged(true);
        setState((s) => ({
          status: "ready",
          // "Show more" is the one query that appends; it checks its generation before it does.
          rows: cursor ? [...s.rows, ...page.listeners] : page.listeners,
          total: page.total, matched: page.matched,
          facets: page.facets ?? s.facets, nextCursor: page.nextCursor,
        }));
      },
      (e: unknown) => {
        // The guard comes **first**, and it is the same guard the answer takes: a rejection nobody
        // is waiting for any more must not paint an error over newer rows, and must certainly not
        // spend the page's one credential recovery. Only a LIVE query may authorise one (spec §6.1).
        if (!live.current || n !== gen.current) return;
        session.reportCredentialFailure(e, issue);
        // …and the failure is rendered either way: where it recovered, `doLoad` takes the page to
        // `loading` and this view unmounts under the error it has just painted (spec §6.1, §6.3).
        const message = e instanceof Error ? e.message : String(e);
        // A cursor core answered with `validation` is malformed or in a format this instance no
        // longer writes, and it will be refused for as long as this page offers it (spec §7). So
        // the page forgets it: the rows stay, the reason is said, and the button goes rather than
        // sending the same refused value on every press. Every other failure keeps the cursor,
        // because a retry is exactly what it wants.
        const refused = cursor !== undefined && e instanceof LoomClientError && e.code === "validation";
        setState((s) => cursor
          ? { ...s, appending: false, moreError: message, nextCursor: refused ? undefined : s.nextCursor }
          : { ...s, status: "error", error: message, appending: false });
      },
    );
  };

  // The one query the page makes on its own: the first one, and a fresh one whenever the view or the
  // credential changes. The cursor is dropped by construction here — only "Show more" carries one.
  // `useSession` memoises the session on `[key, client, storage]`, so it is the same object across a
  // view flip and across a `doLoad` — the re-query after a recovery comes from the `loading` →
  // `ready` remount (spec §6.3) and not from this dependency.
  useEffect(() => { run(view); }, [view, session]);

  /**
   * The one way a control changes the page: new state, new URL, and — through the effect — one
   * fresh query with no cursor.
   *
   * It takes an **updater** rather than a finished view, because the base it updates is not always
   * the one the caller could see. A control pressed inside the debounce window is the newer intent
   * and supersedes the keystroke that has not fired yet: the pending timer is cancelled and the
   * draft's trimmed text folded into the base, so the typed text rides along in **this one query**
   * instead of coming back 250 ms later as a second one carrying a stale view.
   */
  const apply = (update: (v: ListenersView) => ListenersView) => {
    let base = viewRef.current;
    if (debounce.current) {
      clearTimeout(debounce.current);
      debounce.current = undefined;
      base = { ...base, q: draftRef.current.trim() };
    }
    const next = update(base);
    viewRef.current = next;
    setView(next);
    writeSearch(next);
  };

  const type = (value: string) => {
    // The box is never disabled while a request is in flight, and a keystroke never fires one: the
    // request is what the typing *stopping* means (spec §5.3).
    setDraft(value);
    draftRef.current = value;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      // Cleared first, so `apply` does not read this timer as one it has to supersede.
      debounce.current = undefined;
      apply((v) => ({ ...v, q: draftRef.current.trim() }));
    }, DEBOUNCE_MS);
  };

  const toggleModel = (model: string) => apply((v) => ({ ...v,
    models: v.models.some((m) => m.model === model)
      ? v.models.filter((m) => m.model !== model)
      : [...v.models, { model }] }));
  const toggleEffort = (model: string, effort: string) => apply((v) => ({ ...v,
    models: v.models.map((m) => m.model !== model ? m : m.effort === effort ? { model } : { model, effort }) }));
  const toggleTool = (tool: string) => apply((v) => ({ ...v,
    tools: v.tools.includes(tool) ? v.tools.filter((t) => t !== tool) : [...v.tools, tool] }));
  const toggleRuntime = (runtime: string) => apply((v) => ({ ...v, runtime: v.runtime === runtime ? undefined : runtime }));
  const toggleServes = (serves: string) => apply((v) => ({ ...v,
    serves: v.serves === serves ? undefined : serves as ServesKind }));

  // The raw `draft`, not a trimmed one: anything at all in the box — a space included — must leave
  // the control live, because pressing it is also what cancels a pending debounce (spec §9).
  const atDefaults = draft === "" && view.q === "" && view.models.length === 0 && view.tools.length === 0
    && view.runtime === undefined && view.serves === undefined && view.sort === "name" && view.dir === "asc";
  const clear = () => {
    // The pending keystroke is cancelled *before* `apply`, not folded into it: Clear filters empties
    // the box too, so there is no text left for it to carry, and a timer left running would have
    // typed it back in 250 ms after the click.
    if (debounce.current) { clearTimeout(debounce.current); debounce.current = undefined; }
    setDraft("");
    draftRef.current = "";
    // One `EMPTY_VIEW`: the sort and the direction go back too. This overrides listeners spec §5.3,
    // which kept the sort (spec §9, CR5).
    apply(() => ({ ...EMPTY_VIEW }));
  };
  /** What the "the list has changed" line offers: this view again, with the new count as the
   *  baseline. Never `location.reload()` — a full page load is exactly what an in-place browser
   *  cannot survive. */
  const reload = () => { firstTotal.current = undefined; setChanged(false); apply((v) => ({ ...v })); };
  const showMore = () => { if (state.nextCursor && !state.appending) run(view, state.nextCursor); };
  /** One row's Invite, answering whether it landed. "no_identity" is not an error to display, as in
   *  `WeaveView`'s `reportError`: the session has already raised its name prompt. */
  const inviteOne = async (threadId: string, participantId: string): Promise<boolean> => {
    setInviteError(undefined);
    try { await session.invite(threadId, participantId); return true; }
    catch (e) {
      if (live.current && !(e instanceof LoomClientError && e.code === "no_identity")) {
        setInviteError(e instanceof Error ? e.message : String(e));
      }
      return false;
    }
  };

  const n = (v: number) => v.toLocaleString();
  // `of` before `matched` and `out of` before `total`: three numbers in one sentence need the two
  // relations spelled differently (spec §9, CR2). Nothing else is ever rendered here — never a zero.
  const counts = state.status !== "error" && state.total !== undefined && state.matched !== undefined
    ? state.matched === state.total
      ? `Showing ${n(state.rows.length)} of ${n(state.total)} listeners`
      : `Showing ${n(state.rows.length)} of ${n(state.matched)} matches (out of ${n(state.total)} listeners)`
    : undefined;

  const updating = state.status === "loading" && state.rows.length > 0;

  return (
    <div class="listeners">
      <div class="listeners-toolbar">
        <div class="listeners-controls">
          <label class="listeners-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <span class="visually-hidden">Search</span>
            <input type="search" value={draft} placeholder="Filter by name or owner" maxLength={MAX_Q}
              onInput={(e) => type((e.target as HTMLInputElement).value)} />
          </label>
          <span class="spacer" />
          <label>Sort
            <select value={view.sort}
              onChange={(e) => { const s = (e.target as HTMLSelectElement).value as ListenersSort;
                                 apply((v) => ({ ...v, sort: s })); }}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          {/* Beside the sort it orders, under the same visible word; its own name is for a reader. */}
          <select aria-label="Direction" value={view.dir}
            onChange={(e) => { const d = (e.target as HTMLSelectElement).value as "asc" | "desc";
                               apply((v) => ({ ...v, dir: d })); }}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button type="button" class="btn btn-ghost" disabled={atDefaults} onClick={clear}>Clear filters</button>
        </div>

        {state.facets && (
          <div class="listeners-facets">
            {/* At the cap only an *unselected* chip is refused: taking one off is the one move that
                still gets anywhere, so the selected ones stay live. */}
            <ModelChips facet={state.facets.models} selected={view.models}
              atCap={view.models.length >= MAX_MODELS ? `At most ${MAX_MODELS} models at once` : undefined}
              onToggleModel={toggleModel} onToggleEffort={toggleEffort} />
            <FacetChips label="tools" hint="all of these" values={state.facets.tools.values}
              more={state.facets.tools.more} selected={view.tools} onToggle={toggleTool}
              atCap={view.tools.length >= MAX_TOOLS ? `At most ${MAX_TOOLS} tools at once` : undefined} />
            <FacetChips label="runtime" hint="one of these" values={state.facets.runtimes.values}
              more={state.facets.runtimes.more} selected={view.runtime ? [view.runtime] : []} onToggle={toggleRuntime} />
            <FacetChips label="serves" hint="one of these" values={state.facets.serves.values}
              more={false} selected={view.serves ? [view.serves] : []} onToggle={toggleServes}
              labelOf={(v) => SERVES[v] ?? v} />
          </div>
        )}
      </div>

      {opened.partial && (
        <p class="listeners-note muted">Part of this link was not understood, so it was ignored.</p>
      )}
      {/* Above the rows, never instead of them (spec §7), and announced, because the rows below it
          do not change when a query fails and there is nothing else to notice. */}
      {state.status === "error" && <p class="listeners-note error" role="alert">{state.error}</p>}
      {inviteError && <p class="listeners-note error" role="alert">{inviteError}</p>}
      {changed && (
        <p class="listeners-note muted">
          <span>The list has changed since you loaded it.</span>{" "}
          <button type="button" class="link" onClick={reload}>Reload the list</button>
        </p>
      )}

      <Table state={state} invite={invite} onInvite={inviteOne} />

      {(counts || updating || state.nextCursor || state.moreError) && (
        <div class="listeners-foot muted">
          {counts && <span>{counts}</span>}
          {updating && (
            // The rows are deliberately kept on screen while this runs (spec §5.3), so the only sign
            // that anything is happening is this word. `CreateWeaveForm` sets the precedent.
            <span class="listeners-updating" role="status">updating…</span>
          )}
          <span class="spacer" />
          {/* The error outlives the button: a cursor core refused with `validation` is forgotten, and
              the reason it was refused must not go with it. */}
          {state.moreError && <span class="error" role="alert">{state.moreError}</span>}
          {state.nextCursor && (
            <button type="button" class="btn btn-ghost btn-sm" onClick={showMore} disabled={state.appending}>Show more</button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The rows, or the one sentence that stands in for them. "No listener matches these filters" is
 * reachable **only** from a successful read that returned nothing: a failed query still renders
 * whatever rows it has, and a first load renders "Loading…" (spec §5.3, §7).
 */
function Table({ state, invite, onInvite }: {
  state: PageState; invite?: InviteTarget;
  onInvite: (threadId: string, participantId: string) => Promise<boolean>;
}) {
  if (state.rows.length === 0) {
    let line: JSX.Element | null = null;             // an error, whose message is already above
    if (state.status === "loading") line = <p class="muted" role="status">Loading…</p>;
    else if (state.status === "ready") {
      line = state.total === 0
        ? <p class="muted">Nobody has declared a profile yet.</p>
        : <p class="muted">No listener matches these filters.</p>;
    }
    return line && <div class="listeners-empty">{line}</div>;
  }
  const now = Date.now();
  return (
    <div class="listeners-table-wrap">
      {/* A control change keeps the rows and dims them; the table never blanks between queries. */}
      <table class={`listeners-table${state.status === "loading" ? " listeners-table-stale" : ""}`}>
        <thead>
          <tr>{COLUMNS.map((c) => <th key={c} scope="col" class={c === "Actions" ? "listener-actions" : undefined}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {state.rows.map((l) => <Row key={l.participant.id} listener={l} now={now} invite={invite} onInvite={onInvite} />)}
        </tbody>
      </table>
    </div>
  );
}

/** `serves` as one of the three words the facet row uses; a named list is spelled out in the details. */
function servesWord(profile: Profile): string {
  const v = profile.serves;
  const word = Array.isArray(v) ? "list" : v ?? "owner";
  return SERVES[word] ?? word;
}

/** When the listener joined: the time alone today, the date on any other day. */
function joinedText(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString();
}

/**
 * One listener: its row, and under it, while its Profile toggle is pressed, a row of its own holding
 * the full `ProfileCard`. Invite is offered only with an `InviteTarget` and never to this browser's
 * own participant; once it lands, or once the session's log shows the invite, it reads Invited and
 * takes no click. The ref, not the state, is what refuses a second click before the first answers:
 * two clicks in one tick both run before the re-render that would disable the button.
 */
function Row({ listener: l, now, invite, onInvite }: {
  listener: Listener; now: number; invite?: InviteTarget;
  onInvite: (threadId: string, participantId: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // The Thread the invite landed on, not a flag: a flag would go on saying Invited for another Thread.
  const [doneFor, setDoneFor] = useState<string | undefined>();
  const p = l.participant;
  const profile = l.capabilities;
  const tools = profile.tools ?? [];
  const joined = joinedText(p.joinedAt);
  const canInvite = invite !== undefined && p.id !== invite.meId;
  const invited = canInvite && (!!invite.invited?.has(p.id) || doneFor === invite.threadId);
  const details = `listener-details-${p.id}`;

  const doInvite = async () => {
    if (!invite || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const threadId = invite.threadId;
    const ok = await onInvite(threadId, p.id);
    inFlight.current = false;
    setBusy(false);
    if (ok) setDoneFor(threadId);
  };

  return (
    <>
      <tr class="listener-row">
        <td><span class="mono listener-name">{p.name}</span></td>
        <td>{profile.owner ? String(profile.owner) : ""}</td>
        <td>{modelSpecs(profile).join(", ")}</td>
        <td>{tools.slice(0, 3).join(", ")}{tools.length > 3 && <span class="muted"> +{tools.length - 3}</span>}</td>
        <td>{profile.runtime ? String(profile.runtime) : ""}</td>
        <td>{servesWord(profile)}</td>
        <td class="mono muted">{agoText(p.lastSeenAt, now)}</td>
        <td class="mono muted">{joined && <time dateTime={p.joinedAt}>{joined}</time>}</td>
        <td class="listener-actions">
          {canInvite && (invited
            ? <button type="button" class="btn btn-sm" disabled aria-label={`Invited ${p.name}`}>Invited</button>
            : <button type="button" class="btn btn-sm" disabled={busy} aria-label={`Invite ${p.name}`}
                onClick={() => void doInvite()}>Invite</button>)}
          <button type="button" class="btn btn-ghost btn-sm" aria-label={`Profile of ${p.name}`}
            aria-expanded={open} aria-controls={open ? details : undefined}
            onClick={() => setOpen((o) => !o)}>Profile</button>
        </td>
      </tr>
      {/* A `Listener` carries the profile *beside* the participant, and `getWeave` blanks the
          participant's own copy in the Lobby (spec §3.1), so the card is handed the pair put back
          together rather than a participant whose `capabilities` is null. */}
      {open && (
        <tr class="listener-details" id={details}>
          <td colSpan={COLUMNS.length}>
            <ProfileCard participant={{ ...p, capabilities: profile }} now={now} />
          </td>
        </tr>
      )}
    </>
  );
}
