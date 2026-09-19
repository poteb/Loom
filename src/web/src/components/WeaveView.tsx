import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { LoomClientError } from "@loom/client";
import type { Session, SessionState } from "../session.js";
import { Header } from "./Header.js";
import { HomeLink } from "./HomeLink.js";
import { ThreadList } from "./ThreadList.js";
import { MessageList } from "./MessageList.js";
import { Composer } from "./Composer.js";
import { NamePrompt } from "./NamePrompt.js";
import { InviteBanner } from "./InviteBanner.js";
import { GuidelinesPanel } from "./GuidelinesPanel.js";
import { RequestsPanel } from "./RequestsPanel.js";
import { ProfileCards } from "./ProfileCard.js";

/**
 * One Weave page, whichever route reached it (spec §2.7). It takes the session rather than building
 * one, so `/w/<secret>`, `/weave/<id>` and `/lobby` converge here: the credential choice happens
 * inside the session, and this view only ever renders what that choice produced.
 *
 * Two states it did not have before `/weave/<id>` existed. A session that found **no credential at
 * all** is not an error — it is a way in the page may be able to offer, so the route gets to replace
 * the explanation with one (`noCredential`, the Join-the-Lobby form of §3.3). And a session reading
 * with a stored **secret** because its identity died says so, offers a join, and withholds the
 * composer until that join lands (§2.6) — the composer would otherwise promise a write this
 * credential cannot make.
 */
export function WeaveView({ session, state, banner, noCredential, openMainInPlace }: {
  session: Session; state: SessionState;
  /** Rendered above the Weave: the persistence bar, and nothing else today. */
  banner?: JSX.Element | null;
  /** Rendered instead of the generic explanation when `status` is `"no-credential"`. */
  noCredential?: JSX.Element | null;
  /**
   * Given only when leaving this JS context would lose what this page holds (spec §3.1): every way
   * back to `/` this view renders — the header's wordmark on a loaded page, and the "Go to the main
   * page" link on the two cards that replace it — then switches the route in place instead of being
   * an `<a href>`. The route decides (`leavingIsSafe`); this view renders what it was handed, and
   * ordinary links without it.
   */
  openMainInPlace?: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);   // message waiting for a name
  const [draft, setDraft] = useState<string | undefined>();      // text handed back to the composer
  const [error, setError] = useState<string | undefined>();
  const [joinError, setJoinError] = useState<string | undefined>();
  // The read-only banner's Join opens the same prompt a blocked send opens, asked for outright
  // rather than provoked by typing a message the session cannot post.
  const [askName, setAskName] = useState(false);

  // The banner rides on every state the page can be in, not just the loaded one. The case that
  // forces it: a §2.6 invalidation whose write reached only memory, on an entry with no secret,
  // ends here at `no-credential` — and without the bar the page says the identity is dead and never
  // says the browser is keeping nothing, which is the one thing the human can act on (§6).
  // The header, and with it the wordmark home, belongs to the loaded page — so these three cards
  // carry the way back themselves, under the same rule (§3.1). `loading` deliberately carries none:
  // a page still resolving what it is has nothing to say about itself yet, and the wait is short.
  if (state.status === "no-credential") {
    return <>{banner}{noCredential ?? <NoCredential state={state} openMainInPlace={openMainInPlace} />}</>;
  }
  if (state.status === "loading") return <>{banner}<div class="center">Loading…</div></>;
  if (state.status === "error") {
    return <>{banner}<div class="center error"><h1>Loom</h1><p>{state.error}</p>
      <p><HomeLink openMainInPlace={openMainInPlace} /></p></div></>;
  }

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // Every mutation funnels through here so none of them can swallow a failure or leave an unhandled
  // rejection behind: "no_identity" is not an error to display — the session has already raised
  // needsName, which opens the name prompt exactly as a blocked send does.
  const reportError = (e: unknown) => {
    if (e instanceof LoomClientError && e.code === "no_identity") return;
    setError(message(e));
  };

  const send = async (text: string) => {
    setError(undefined);
    try { await session.post(text); setDraft(undefined); }
    catch (e) {
      if (e instanceof LoomClientError && e.code === "no_identity") { setPending(text); return; }
      setError(message(e));
      throw e;
    }
  };
  const join = async (name: string) => {
    setJoinError(undefined);
    try { await session.join(name); }
    catch (e) { setJoinError(message(e)); return; }   // joinError is for join failures only
    setAskName(false);                                // the name is settled either way below
    const text = pending;
    if (text) {
      try { await session.post(text); }
      catch (e) {
        // Joined, but the message did not land: close the prompt (the name is settled) and hand the
        // text back to the composer rather than dropping what the user wrote.
        setPending(null);
        setDraft(text);
        setError(message(e));
        return;
      }
    }
    setPending(null);
    setDraft(undefined);
  };
  const dismissPrompt = () => { setPending(null); setAskName(false); session.dismissNamePrompt(); };
  const archived = !!state.weave?.archivedAt;
  // Reading with the Weave link, because the identity that used to work no longer does (§2.6). A
  // join is the way out, and `session.join()` clears the reason.
  const readOnly = state.readOnlyReason === "secret-fallback";

  return (
    <div class="layout">
      {banner}
      <Header state={state} session={session} onError={reportError} openMainInPlace={openMainInPlace} />
      <div class="body">
        <aside class="sidebar">
          <ThreadList state={state} session={session} onError={reportError} />
          <GuidelinesPanel state={state} session={session} onError={reportError} />
          {/* Both render nothing away from the Lobby, so every other Weave's sidebar is unchanged. */}
          <RequestsPanel state={state} session={session} onError={reportError} />
          <ProfileCards state={state} />
        </aside>
        <div class="main">
          {archived && <div class="banner">This Weave is archived and read-only.</div>}
          {readOnly && (
            <div class="banner">
              Your identity in this Weave is no longer valid — you are reading with the Weave link.{" "}
              <button onClick={() => setAskName(true)}>Join</button>
            </div>
          )}
          {state.refreshError && <div class="warn-bar">Having trouble syncing: {state.refreshError}</div>}
          <InviteBanner state={state} session={session} />
          <MessageList state={state} />
          {error && <div class="error-bar">{error}</div>}
          {!archived && !readOnly && <Composer state={state} onSend={send} draft={draft} />}
        </div>
      </div>
      {(pending !== null || askName || (state.needsName && !state.me)) && (
        <NamePrompt onSubmit={join} onCancel={dismissPrompt} error={joinError} />
      )}
    </div>
  );
}

/**
 * What a Weave this browser holds nothing for says (spec §3.3). Deliberately no "paste a secret"
 * field (§10.8): the two ways in are a link someone sends and an invitation that follows a Lobby
 * request, and both of them arrive from outside this page.
 */
function NoCredential({ state, openMainInPlace }: { state: SessionState; openMainInPlace?: () => void }) {
  return (
    <div class="center">
      <h1>Loom</h1>
      {/* Set when the identity was invalidated during this very load and no secret was stored. */}
      {state.error && <p class="error">{state.error}</p>}
      <p>This browser holds no key for this Weave.</p>
      <p>
        Two ways in: the <code>/w/&lt;secret&gt;</code> link its keeper can send you, or a request in
        the Lobby that ends in an invitation.
      </p>
      {/* The screen a §2.6 invalidation whose write reached only memory ends on — so this link, of
          all of them, is the one that must not be a full page load. */}
      <p><HomeLink openMainInPlace={openMainInPlace} /></p>
    </div>
  );
}
