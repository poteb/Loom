import { useState } from "preact/hooks";
import type { Thread } from "@loom/client";
import type { Session, SessionState } from "../session.js";

/**
 * Per-thread controls for whoever may edit the thread (its creator, or a keeper): the artefact link
 * and the invite list. Rendered with `key={thread.id}` so switching threads remounts it and the url
 * field starts from the newly selected thread's url instead of the previous one's.
 */
export function ThreadTools({ thread, state, session, onError }: { thread: Thread; state: SessionState; session: Session; onError: (e: unknown) => void }) {
  const [url, setUrl] = useState(thread.url ?? "");
  const invited = state.invited[thread.id];
  const others = state.participants.filter((p) => p.id !== state.me?.participant.id);
  const saveUrl = async (e: Event) => {
    e.preventDefault();
    try { await session.setThreadUrl(thread.id, url.trim() || null); } catch (err) { onError(err); }
  };
  const invite = async (participantId: string) => {
    try { await session.invite(thread.id, participantId); } catch (err) { onError(err); }
  };
  return (
    <div class="thread-tools">
      <form class="url-form" onSubmit={saveUrl}>
        <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="Link to an artefact" maxLength={2000} />
        <button type="submit">Save link</button>
      </form>
      {others.length > 0 && (
        <div class="invite-list">
          <span class="invite-head">Invite</span>
          {others.map((p) => invited?.has(p.id)
            ? <span key={p.id} class="invited-mark" title="invited">✓ {p.name}</span>
            : <button key={p.id} type="button" class="link" onClick={() => void invite(p.id)}>invite {p.name}</button>)}
        </div>
      )}
    </div>
  );
}
