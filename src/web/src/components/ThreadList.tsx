import { useState } from "preact/hooks";
import type { Session, SessionState } from "../session.js";

export function ThreadList({ state, session, onError }: { state: SessionState; session: Session; onError: (e: unknown) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const archived = !!state.weave?.archivedAt;
  const submit = async (e: Event) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try { await session.createThread(n); setName(""); setCreating(false); }
    catch (err) { onError(err); }
  };
  const close = async (id: string) => {
    try { await session.closeThread(id); } catch (e) { onError(e); }
  };
  return (
    <aside class="threads">
      <div class="threads-head">
        <span>Threads</span>
        {!archived && <button onClick={() => setCreating((v) => !v)}>New thread</button>}
      </div>
      {creating && (
        <form onSubmit={submit} class="thread-form">
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Thread name" maxLength={100} autoFocus />
          <button type="submit">Create</button>
        </form>
      )}
      <ul>
        {state.threads.map((t) => (
          <li key={t.id} class={t.id === state.currentThreadId ? "active" : ""}>
            {/* A real button, so selecting a thread is reachable by keyboard (Tab, then Enter or Space). */}
            <button type="button" class="thread-pick" aria-current={t.id === state.currentThreadId ? "true" : undefined}
              onClick={() => session.selectThread(t.id)}>
              <span>{t.name}</span>
              {t.closedAt && <span class="badge">closed</span>}
            </button>
            {session.canModerate() && !t.isGeneral && !t.closedAt && (
              <button class="link" onClick={() => void close(t.id)}>close</button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
