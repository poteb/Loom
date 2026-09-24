import { useState } from "preact/hooks";
import type { Session, SessionState } from "../session.js";
import { artefactTag } from "./artefact.js";

/** Which Threads the list shows. UI state only: it never reaches the session or the address bar. */
type Filter = "open" | "closed" | "all";

export function ThreadList({ state, session, onError, onPick, markCurrent = true }: {
  state: SessionState; session: Session; onError: (e: unknown) => void;
  /** Told that this list has put a Thread on screen, by a selection or by a creation (spec §3.4).
   *  It reports; what that costs (closing the directory, and a history entry) is the caller's. */
  onPick?: () => void;
  /** Whether the selected Thread is drawn as the current one (spec §8). The selection is kept
   *  either way; only its mark is withheld while the main area shows something other than a Thread,
   *  so that no two sidebar entries claim at once to be the one being looked at. */
  markCurrent?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [filter, setFilter] = useState<Filter>("open");
  const archived = !!state.weave?.archivedAt;
  const submit = async (e: Event) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try {
      await session.createThread(n, url.trim() || null);
      setName(""); setUrl(""); setCreating(false);
      // Creating a Thread selects it (`session.ts:831`), so this is a pick like any other: leaving
      // the human on the directory would hide what they have just made.
      onPick?.();
    }
    catch (err) { onError(err); }
  };
  const marked = (id: string) => markCurrent && id === state.currentThreadId;
  const openCount = state.threads.filter((t) => !t.closedAt).length;
  const closedCount = state.threads.length - openCount;
  // The current Thread is always listed, whatever the filter says: the page is showing it, and a
  // selection the list cannot draw would leave the human with no way to see where they are.
  const shown = state.threads.filter((t) => t.id === state.currentThreadId
    || filter === "all" || (filter === "open" ? !t.closedAt : !!t.closedAt));
  const tab = (value: Filter, label: string) => (
    <button type="button" class={`btn btn-ghost thread-filter-tab${filter === value ? " on" : ""}`}
      aria-pressed={filter === value ? "true" : "false"} onClick={() => setFilter(value)}>{label}</button>
  );
  return (
    <nav class="threads" aria-label="Threads">
      <div class="nav-head threads-head">
        <span class="sec">Threads</span>
        {/* "New thread" is the name, so the control says what it makes; "+ New" is what fits. */}
        {!archived && <button type="button" class="btn btn-xs" aria-label="New thread" aria-expanded={creating ? "true" : "false"}
          onClick={() => setCreating((v) => !v)}>+ New</button>}
      </div>
      {creating && (
        <form onSubmit={submit} class="thread-form">
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Thread name" aria-label="Thread name" maxLength={100} autoFocus />
          <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="Artefact URL (optional)" aria-label="Artefact URL (optional)" maxLength={2000} />
          <button type="submit" class="btn-sm">Create</button>
        </form>
      )}
      <div class="thread-filter">
        {tab("open", `Open · ${openCount}`)}
        {tab("closed", `Closed · ${closedCount}`)}
        {tab("all", "All")}
      </div>
      <ul>
        {shown.map((t) => {
          const tag = artefactTag(t.url);
          const invited = state.invitesForMe.has(t.id);
          return (
            <li key={t.id} class={[marked(t.id) ? "active" : "", invited ? "invited" : "", t.closedAt ? "closed" : ""].filter(Boolean).join(" ")}>
              {/* A real button, so selecting a thread is reachable by keyboard (Tab, then Enter or Space). */}
              <button type="button" class="thread-pick" aria-current={marked(t.id) ? "true" : undefined}
                onClick={() => { session.selectThread(t.id); onPick?.(); }}>
                <span class="muted thread-hash" aria-hidden="true">#</span>
                <span class="thread-name">{t.name}</span>
                {tag && <span class="mono thread-tag">{tag}</span>}
                {t.closedAt && <span class="pill pill-closed thread-pill">closed</span>}
                {invited && <span class="badge-invited">invited</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
