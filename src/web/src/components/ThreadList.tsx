import { useState } from "preact/hooks";
import type { Session, SessionState } from "../session.js";
import { ThreadTools } from "./ThreadTools.js";

/** The bare host and path of a url, short enough to sit under a thread name. */
function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

export function ThreadList({ state, session, onError }: { state: SessionState; session: Session; onError: (e: unknown) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const archived = !!state.weave?.archivedAt;
  const submit = async (e: Event) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try { await session.createThread(n, url.trim() || null); setName(""); setUrl(""); setCreating(false); }
    catch (err) { onError(err); }
  };
  const close = async (id: string) => {
    try { await session.closeThread(id); } catch (e) { onError(e); }
  };
  const current = state.threads.find((t) => t.id === state.currentThreadId);
  return (
    <aside class="threads">
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
          <li key={t.id} class={[t.id === state.currentThreadId ? "active" : "", state.invitesForMe.has(t.id) ? "invited" : ""].filter(Boolean).join(" ")}>
            {/* A real button, so selecting a thread is reachable by keyboard (Tab, then Enter or Space). */}
            <button type="button" class="thread-pick" aria-current={t.id === state.currentThreadId ? "true" : undefined}
              onClick={() => session.selectThread(t.id)}>
              <span>{t.name}</span>
              {t.closedAt && <span class="badge">closed</span>}
              {state.invitesForMe.has(t.id) && <span class="badge badge-invited">invited</span>}
            </button>
            {t.url && <a class="thread-url" href={t.url} target="_blank" rel="noreferrer">{shortUrl(t.url)}</a>}
            {session.canModerate() && !t.isGeneral && !t.closedAt && (
              <button class="link" onClick={() => void close(t.id)}>close</button>
            )}
          </li>
        ))}
      </ul>
      {current && session.canEditThread(current) && (
        <ThreadTools key={current.id} thread={current} state={state} session={session} onError={onError} />
      )}
    </aside>
  );
}
