import { useState } from "preact/hooks";
import type { Session, SessionState } from "../session.js";

/** When an invitation was made, in the browser's clock: it may be days old, so the date is shown too. */
const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * The invitations still pending into this Weave (spec 2026-10-08 §9): a keeper's view in the
 * sidebar, with Withdraw on each direct one. A request's invitation is marked and has no button, since
 * the removal from the request's Thread is what withdraws it. Behaviour and class hooks only: where it
 * sits and how it looks belong to Paw's design session. It renders nothing before the page has loaded,
 * for anyone who is not a keeper here, and on the Lobby, which no invitation can target; an archived
 * Weave keeps it, since a withdrawal only removes access.
 *
 * A row withdrawn from this panel is hidden at once and for good: a withdrawn invitation never comes
 * back as pending, and a refresh that was already in flight may still carry it.
 */
export function InvitationsPanel({ state, session, onError }: { state: SessionState; session: Session; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [withdrawn, setWithdrawn] = useState<ReadonlySet<string>>(new Set());
  if (state.status !== "ready" || !session.canManageInvitations()) return null;
  const rows = (state.invitations ?? []).filter((i) => !withdrawn.has(i.invitationId));
  const withdraw = async (id: string) => {
    if (busy.has(id)) return;
    setBusy((b) => new Set([...b, id]));
    try {
      await session.withdrawInvitation(id);
      setWithdrawn((w) => new Set([...w, id]));
    } catch (e) {
      onError(e);
    } finally {
      setBusy((b) => { const next = new Set(b); next.delete(id); return next; });
    }
  };
  return (
    <section class="nav-section invitations">
      <div class="nav-head"><span class="sec">Pending invitations</span></div>
      {state.invitationsError !== undefined && <p class="error">Could not read the pending invitations: {state.invitationsError}</p>}
      {state.invitations !== undefined && state.invitationsError === undefined && rows.length === 0 && <p class="muted">No pending invitations.</p>}
      {rows.length > 0 && (
        <ul class="invitation-list">
          {rows.map((i) => (
            <li key={i.invitationId} class="invitation">
              <strong>{i.inviteeName}</strong>{` · thread "${i.targetThreadName}" · ${when(i.createdAt)} by ${i.createdByName ?? "someone"} `}
              {i.requestId === null
                ? <button type="button" class="btn btn-xs" disabled={busy.has(i.invitationId)} onClick={() => { void withdraw(i.invitationId); }}>Withdraw</button>
                : <span class="muted">Belongs to a request: remove the agent from the request's Thread to withdraw it.</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
