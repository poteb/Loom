import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Listener, ListenersFacets, ListenersSort, LoomClient, ServesKind } from "@loom/client";
import type { KeyValueStorage } from "../../storage.js";
import { leavingIsSafe, type PersistenceNotice } from "../../persistence.js";
import { isCredentialFailure, weaveKey } from "../../weaves-store.js";
import { ProfileCard } from "../ProfileCard.js";
import { FacetChips, ModelChips } from "./FacetChips.js";
import {
  queryFromView, searchFromView, viewFromSearch, type ListenersView,
} from "./listeners-query.js";

/** Spec §5.3: one page of 50, and "Show more" appends the next. */
const PAGE = 50;
const DEBOUNCE_MS = 250;

/** What the route settles before this page exists, plus the two things the page may do to storage. */
export type ListenersPageProps = {
  reader: LoomClient; lobbyId: string;
  /** True when the page was rendered here rather than navigated to (`openListenersInPlace`), which
   *  is what keeps its query string off the address bar (spec §5.4). */
  inPlace?: boolean;
  storage: KeyValueStorage; notice: PersistenceNotice;
  openInPlace: (weaveId: string) => void;
  openMainInPlace: () => void;
  /** Told when a query proved this page's credential dead. The route owns the write and the reader
   *  it is replaced with, because the route is what holds both (spec §5.5). */
  onCredentialFailure: () => void;
};

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
  { value: "name", label: "name" }, { value: "owner", label: "owner" }, { value: "joined", label: "joined" },
];
/** The three stored words, said the way §5.3 says them. The URL still carries the words themselves. */
const SERVES: Record<string, string> = { anyone: "anyone", owner: "its owner", list: "a named list" };

/**
 * The Lobby's directory: search, four facet filters, sort, the `ProfileCard` grid and Show more
 * (spec §5.3). It opens no WebSocket and holds no session — it is a page of answers to queries it
 * makes itself, and the only live thing on it is the quiet "the list has changed" line (§5.5).
 */
export function ListenersPage({
  reader, lobbyId, inPlace, storage, notice, openInPlace, openMainInPlace, onCredentialFailure,
}: ListenersPageProps) {
  // The link this page was opened with, read once. `partial` latches with it: it describes that
  // link, not the controls, which the human has been driving ever since.
  const opened = useMemo(() => viewFromSearch(location.search), []);
  const [view, setView] = useState<ListenersView>(opened.view);
  const [draft, setDraft] = useState(opened.view.q);
  const [state, setState] = useState<PageState>({ status: "loading", rows: [] });
  const [changed, setChanged] = useState(false);
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
      : { ...s, status: "loading", error: undefined, moreError: undefined, appending: false });
    reader.listListeners(queryFromView(next, { limit: PAGE, cursor })).then(
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
        // retire a credential on the strength of a superseded request (spec §7).
        if (!live.current || n !== gen.current) return;
        if (isCredentialFailure(e)) { onCredentialFailure(); return; }
        const message = e instanceof Error ? e.message : String(e);
        setState((s) => cursor
          ? { ...s, appending: false, moreError: message }
          : { ...s, status: "error", error: message, appending: false });
      },
    );
  };

  // The one query the page makes on its own: the first one, and a fresh one whenever the view or the
  // credential changes. The cursor is dropped by construction here — only "Show more" carries one.
  useEffect(() => { run(view); }, [view, reader]);

  const writeUrl = (next: ListenersView) => {
    // Rewriting this page's own query string names the same page, which is what the no-pushState
    // rule is about (spec §5.4). Rendered in place, the URL is left entirely alone: the address
    // would name a page this browser could not load again. The path is compared exactly — a
    // `startsWith` would rewrite the query string of some other page that begins the same way.
    if (inPlace) return;
    if (location.pathname !== "/lobby/listeners" && location.pathname !== "/lobby/listeners/") return;
    const s = searchFromView(next);
    history.replaceState(null, "", s ? `${location.pathname}?${s}` : location.pathname);
  };

  /** The one way a control changes the page: new state, new URL, and — through the effect — one
   *  fresh query with no cursor. */
  const apply = (next: ListenersView) => { setView(next); writeUrl(next); };

  const type = (value: string) => {
    // The box is never disabled while a request is in flight, and a keystroke never fires one: the
    // request is what the typing *stopping* means (spec §5.3).
    setDraft(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => apply({ ...view, q: value.trim() }), DEBOUNCE_MS);
  };

  const toggleModel = (model: string) => apply({ ...view,
    models: view.models.some((m) => m.model === model)
      ? view.models.filter((m) => m.model !== model)
      : [...view.models, { model }] });
  const toggleEffort = (model: string, effort: string) => apply({ ...view,
    models: view.models.map((m) => m.model !== model ? m : m.effort === effort ? { model } : { model, effort }) });
  const toggleTool = (tool: string) => apply({ ...view,
    tools: view.tools.includes(tool) ? view.tools.filter((t) => t !== tool) : [...view.tools, tool] });
  const toggleRuntime = (runtime: string) => apply({ ...view, runtime: view.runtime === runtime ? undefined : runtime });
  const toggleServes = (serves: string) => apply({ ...view,
    serves: view.serves === serves ? undefined : serves as ServesKind });

  const anySet = view.q !== "" || view.models.length > 0 || view.tools.length > 0
    || view.runtime !== undefined || view.serves !== undefined;
  const clear = () => {
    setDraft("");
    apply({ q: "", models: [], tools: [], runtime: undefined, serves: undefined, sort: view.sort, dir: view.dir });
  };
  /** What the "the list has changed" line offers: this view again, with the new count as the
   *  baseline. Never `location.reload()` — a full page load is exactly what an in-place browser
   *  cannot survive. */
  const reload = () => { firstTotal.current = undefined; setChanged(false); apply({ ...view }); };
  const showMore = () => { if (state.nextCursor && !state.appending) run(view, state.nextCursor); };

  // One question, one answer, for both ways off this page: may this browser leave this JS context
  // without losing the credential the entry on screen is about (spec §3.1)?
  const canLeave = leavingIsSafe(storage, notice, weaveKey(lobbyId));
  const n = (v: number) => v.toLocaleString();
  const counts = state.status !== "error" && state.total !== undefined && state.matched !== undefined
    ? state.matched === state.total
      ? `Showing ${n(state.rows.length)} of ${n(state.total)} listeners`
      : `Showing ${n(state.rows.length)} of ${n(state.matched)} matches (${n(state.total)} listeners)`
    : undefined;

  return (
    <div class="listeners">
      <header class="listeners-head">
        <div>
          {canLeave
            ? <a class="home-link" href="/" title="Go to the main page">Loom</a>
            : <button type="button" class="home-link" title="Go to the main page"
                      onClick={() => openMainInPlace()}>Loom</button>}
          <h1>Listeners</h1>
        </div>
        {/* The only exit to the Lobby an in-place browser has, so it is on screen in every state of
            this page — loading, error, empty and ready alike. */}
        {canLeave
          ? <a class="listeners-back" href="/lobby">Back to the Lobby</a>
          : <button type="button" class="listeners-back" onClick={() => openInPlace(lobbyId)}>Back to the Lobby</button>}
      </header>

      {opened.partial && (
        <p class="listeners-partial muted">Part of this link was not understood, so it was ignored.</p>
      )}

      <div class="listeners-controls">
        <label class="listeners-search">Search
          <input type="search" value={draft} placeholder="name or owner"
            onInput={(e) => type((e.target as HTMLInputElement).value)} />
        </label>
        <label>sort
          <select value={view.sort}
            onChange={(e) => apply({ ...view, sort: (e.target as HTMLSelectElement).value as ListenersSort })}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label>direction
          <select value={view.dir}
            onChange={(e) => apply({ ...view, dir: (e.target as HTMLSelectElement).value as "asc" | "desc" })}>
            <option value="asc">asc</option>
            <option value="desc">desc</option>
          </select>
        </label>
        {anySet && <button type="button" class="link" onClick={clear}>Clear filters</button>}
      </div>

      {state.facets && (
        <div class="listeners-facets">
          <ModelChips facet={state.facets.models} selected={view.models}
            onToggleModel={toggleModel} onToggleEffort={toggleEffort} />
          <FacetChips label="tools" hint="all of these" values={state.facets.tools.values}
            more={state.facets.tools.more} selected={view.tools} onToggle={toggleTool} />
          <FacetChips label="runtime" hint="one of these" values={state.facets.runtimes.values}
            more={state.facets.runtimes.more} selected={view.runtime ? [view.runtime] : []} onToggle={toggleRuntime} />
          <FacetChips label="serves" hint="one of these" values={state.facets.serves.values}
            more={false} selected={view.serves ? [view.serves] : []} onToggle={toggleServes}
            labelOf={(v) => SERVES[v] ?? v} />
        </div>
      )}

      {/* Above the rows, never instead of them (spec §7). */}
      {state.status === "error" && <p class="error">{state.error}</p>}
      {changed && (
        <p class="listeners-changed muted">
          <span>The list has changed since you loaded it.</span>{" "}
          <button type="button" class="link" onClick={reload}>Reload the list</button>
        </p>
      )}

      <p class="listeners-counts">
        {counts && <span>{counts}</span>}
        {state.status === "loading" && state.rows.length > 0 && <span class="listeners-updating">updating…</span>}
      </p>

      <Grid state={state} />

      {state.nextCursor && (
        <div class="listeners-more">
          <button type="button" onClick={showMore} disabled={state.appending}>Show more</button>
          {state.moreError && <span class="error">{state.moreError}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The rows, or the one sentence that stands in for them. "No listener matches these filters" is
 * reachable **only** from a successful read that returned nothing — a failed query still renders
 * whatever rows it has, and a first load renders "Loading…" (spec §5.3, §7).
 */
function Grid({ state }: { state: PageState }) {
  if (state.rows.length === 0) {
    if (state.status === "loading") return <p class="muted">Loading…</p>;
    if (state.status === "ready") {
      return state.total === 0
        ? <p class="muted">Nobody has declared a profile yet.</p>
        : <p class="muted">No listener matches these filters.</p>;
    }
    return null;                               // an error, whose message is already above
  }
  return (
    <div class={`listeners-grid${state.status === "loading" ? " listeners-grid-stale" : ""}`}>
      {/* A `Listener` carries the profile *beside* the participant, and `getWeave` blanks the
          participant's own copy in the Lobby (spec §3.1) — so the card is handed the pair put back
          together rather than a participant whose `capabilities` is null. */}
      {state.rows.map((l) => (
        <ProfileCard key={l.participant.id} participant={{ ...l.participant, capabilities: l.capabilities }} />
      ))}
    </div>
  );
}
