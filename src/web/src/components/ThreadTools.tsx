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

/**
 * Kick one participant out of the Weave (spec 2026-10-09 §12), for a keeper, on every row but its
 * own. Pressing Kick only asks: the confirmation replaces the button in this row alone, and only its
 * own Kick calls the session. It is in the page, not `window.confirm`, so the design session can
 * style it. On success the row leaves the list (the session marks the participant kicked); on a
 * refusal the error goes to the view's one error path and the row returns to idle.
 */
export function KickControl({ participant, session, onError }: { participant: Participant; session: Session; onError: (e: unknown) => void }) {
  const [step, setStep] = useState<"idle" | "confirm" | "kicking">("idle");
  const kick = async () => {
    setStep("kicking");
    try { await session.kick(participant.id); }
    catch (err) { onError(err); setStep("idle"); }
  };
  return (
    <span class="kick-control">
      {step === "idle"
        ? <button type="button" class="btn btn-xs" aria-label={`kick ${participant.name}`} onClick={() => setStep("confirm")}>Kick</button>
        : (
          <span class="kick-confirm">
            <span>Kick {participant.name} out of this Weave?</span>
            <button type="button" class="btn btn-xs" aria-label={`confirm kick ${participant.name}`} disabled={step === "kicking"}
              onClick={() => void kick()}>Kick</button>
            <button type="button" class="btn btn-xs" disabled={step === "kicking"} onClick={() => setStep("idle")}>Cancel</button>
          </span>
        )}
    </span>
  );
}
