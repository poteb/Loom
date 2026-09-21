import { useState } from "preact/hooks";
import type { Session, SessionState } from "../session.js";
import { ThreadTools } from "./ThreadTools.js";

/** Defence in depth: the server validates thread urls, but a link is only rendered for a scheme we
 *  know is safe, so a stored `javascript:`/`data:` url could never become a clickable href here. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The bare host and path of a url, short enough to sit under a thread name. */
function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

export function ThreadList({ state, session, onError, onPick, markCurrent = true }: {
  state: SessionState; session: Session; onError: (e: unknown) => void;
  /** Told that this list has put a Thread on screen, by a selection or by a creation (spec §3.4).
   *  It reports; what that costs — closing the directory, and a history entry — is the caller's. */
  onPick?: () => void;
  /** Whether the selected Thread is drawn as the current one (spec §8). The selection is kept
   *  either way; only its mark is withheld while the main area shows something other than a Thread,
   *  so that no two sidebar entries claim at once to be the one being looked at. */
  markCurrent?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
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
  const close = async (id: string) => {
    try { await session.closeThread(id); } catch (e) { onError(e); }
  };
  const current = state.threads.find((t) => t.id === state.currentThreadId);
  const marked = (id: string) => markCurrent && id === state.currentThreadId;
  return (
    <nav class="threads">
      <div class="threads-head">
        <span>Threads</span>
        {!archived && <button onClick={() => setCreating((v) => !v)}>New thread</button>}
      </div>
      {creating && (
        <form onSubmit={submit} class="thread-form">
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Thread name" maxLength={100} autoFocus />
          <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="Artefact URL (optional)" maxLength={2000} />
          <button type="submit">Create</button>
        </form>
      )}
      <ul>
        {state.threads.map((t) => (
          <li key={t.id} class={[marked(t.id) ? "active" : "", state.invitesForMe.has(t.id) ? "invited" : ""].filter(Boolean).join(" ")}>
            {/* A real button, so selecting a thread is reachable by keyboard (Tab, then Enter or Space). */}
            <button type="button" class="thread-pick" aria-current={marked(t.id) ? "true" : undefined}
              onClick={() => { session.selectThread(t.id); onPick?.(); }}>
              <span>{t.name}</span>
              {t.closedAt && <span class="badge">closed</span>}
              {state.invitesForMe.has(t.id) && <span class="badge badge-invited">invited</span>}
            </button>
            {t.url && (isHttpUrl(t.url)
              ? <a class="thread-url" href={t.url} target="_blank" rel="noreferrer">{shortUrl(t.url)}</a>
              : <span class="thread-url">{shortUrl(t.url)}</span>)}
            {session.canModerate() && !t.isGeneral && !t.closedAt && (
              <button class="link" onClick={() => void close(t.id)}>close</button>
            )}
          </li>
        ))}
      </ul>
      {current && session.canEditThread(current) && (
        <ThreadTools key={current.id} thread={current} state={state} session={session} onError={onError} />
      )}
    </nav>
  );
}
