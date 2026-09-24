import { useState } from "preact/hooks";
import type { Participant, Thread } from "@loom/client";
import type { Session } from "../session.js";

/**
 * The per-thread controls for whoever may edit the thread (its creator, or a keeper), split in two
 * so the details panel can put each where it belongs: the artefact link form under the Thread's
 * facts, and one invite control per participant in the people list.
 */

/**
 * The artefact link form. Rendered with `key={thread.id}` so switching threads remounts it and the
 * field starts from the newly selected thread's url instead of the previous one's.
 */
export function LinkForm({ thread, session, onError }: { thread: Thread; session: Session; onError: (e: unknown) => void }) {
  const [url, setUrl] = useState(thread.url ?? "");
  const saveUrl = async (e: Event) => {
    e.preventDefault();
    try { await session.setThreadUrl(thread.id, url.trim() || null); } catch (err) { onError(err); }
  };
  return (
    <form class="url-form" onSubmit={saveUrl}>
      <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="Link to an artefact"
        aria-label="Artefact link" maxLength={2000} />
      <button type="submit" class="btn btn-sm">Save link</button>
    </form>
  );
}

/** Invite one participant to the thread, or say they already are. The name is on the row beside it,
 *  so the button's visible word is short and its accessible name carries whom it invites. */
export function InviteControl({ thread, participant, invited, session, onError }: {
  thread: Thread; participant: Participant; invited: boolean; session: Session; onError: (e: unknown) => void;
}) {
  const invite = async () => {
    try { await session.invite(thread.id, participant.id); } catch (err) { onError(err); }
  };
  return invited
    ? <span class="invited-mark muted" title="invited">invited</span>
    : <button type="button" class="btn btn-xs" aria-label={`invite ${participant.name}`} onClick={() => void invite()}>Invite</button>;
}
