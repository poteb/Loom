import type { Session, SessionState } from "../session.js";

/** Who invited me to `threadId`: the actor of the latest thread.invited event addressed to me there. */
function inviterName(state: SessionState, threadId: string): string {
  const meId = state.me?.participant.id;
  let actor: string | undefined;
  for (const e of state.events) {
    if (e.type !== "thread.invited" || e.threadId !== threadId) continue;
    if (meId && e.payload.participantId !== meId) continue;
    actor = e.actor;   // keep going: the last one wins
  }
  if (!actor) return "Someone";
  // Keeper actors are recorded as `keeper:<id>` and have no participant row to look up.
  if (actor.startsWith("keeper:")) return "Keeper";
  return state.participants.find((p) => p.id === actor)?.name ?? "Someone";
}

/**
 * One dismissible line per unread invite: who invited me, and to which Thread. Dismissing marks the
 * invite seen (the same state opening the Thread sets), so it does not come back on the next event.
 */
export function InviteBanner({ state, session }: { state: SessionState; session: Session }) {
  if (state.invitesForMe.size === 0) return null;
  return (
    <>
      {[...state.invitesForMe].map((threadId) => (
        <div key={threadId} class="banner invite-banner">
          <span>{inviterName(state, threadId)} invited you to {state.threads.find((t) => t.id === threadId)?.name ?? threadId}</span>
          <button type="button" class="link" aria-label="dismiss" onClick={() => session.markSeen(threadId)}>×</button>
        </div>
      ))}
    </>
  );
}
