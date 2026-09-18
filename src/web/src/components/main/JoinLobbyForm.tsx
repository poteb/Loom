import { useState } from "preact/hooks";
import { LoomClientError, type LoomClient } from "@loom/client";
import type { KeyValueStorage } from "../../storage.js";
import type { PersistenceNotice } from "../../persistence.js";
import { setIdentity } from "../../weaves-store.js";
import { isValidName, suggestName } from "../../name.js";

/** What a failed join says. `validation` keeps the server's own words — the client rule should have
 *  caught it, so a mismatch is a bug worth seeing verbatim (spec §4.1). */
function messageFor(e: unknown): string {
  if (e instanceof LoomClientError) {
    if (e.code === "weave_not_found") return "This instance has no Lobby yet.";
    if (e.code === "network") return "Could not reach the server.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The one Join-the-Lobby form. Rendered by the main page and by the router's unjoined-Lobby fork,
 * so every way into the Lobby runs the same persistence branch.
 *
 * It never reads or writes `location`: the two callbacks are the whole outcome, and which one fires
 * is decided by the verdict of the single credential write (spec §3.1). Whether the form should be
 * on screen at all is `hasIdentity`'s question, asked at the two call sites; the form asserts
 * nothing about it.
 *
 * It takes no `WeavesSignal` on purpose. Both callbacks replace the page this form is on, so a join
 * never changes a list that stays on screen — unlike the creation form of §4.5, which does not
 * navigate and therefore does take one.
 */
export function JoinLobbyForm({ client, storage, notice, lobby, onJoined, onJoinedInPlace }: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice;
  /** Which Weave this form joins, and what to call it while asking. The write itself uses the id the
   *  join answers with, which is the same one and is authoritative. */
  lobby: { weaveId: string; title: string };
  /** Called when the credential persisted: the caller may safely leave this JS context. */
  onJoined: (weaveId: string) => void;
  /** Called when it did not: the caller must render the Lobby here, without navigating. */
  onJoinedInPlace: (weaveId: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [taken, setTaken] = useState<string | undefined>();
  const valid = isValidName(name);
  const suggestion = taken === undefined ? undefined : suggestName(taken);

  // One setter behind the field and the suggestion button alike: every message on this form names
  // the name it is about, so none of them may outlive it.
  const change = (next: string) => { setName(next); setError(undefined); setTaken(undefined); };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    setTaken(undefined);
    let done: { weaveId: string; hand: (weaveId: string) => void } | undefined;
    try {
      const j = await client.joinLobby({ name, kind: "human" });
      // One write, before anything that could destroy this JS context, and its verdict decides
      // whether leaving is safe at all (spec §3.1). The write goes into a variable and is reported
      // afterwards — nested inside an optional call (`onWrite?.(setIdentity(…))`) it would simply
      // not happen whenever that callback were absent.
      const result = setIdentity(storage, j.weaveId,
        { token: j.token, participantId: j.participant.id, name: j.participant.name },
        { title: j.weave.title, lastOpenedAt: new Date().toISOString() });
      notice.note(result);
      done = { weaveId: j.weaveId, hand: result === "durable" ? onJoined : onJoinedInPlace };
    } catch (err) {
      // The typed name is never discarded on a failure (spec §6): only the message changes.
      if (err instanceof LoomClientError && err.code === "name_taken") setTaken(name);
      else setError(messageFor(err));
    } finally {
      setBusy(false);
    }
    // Outside the `try` on purpose. The join and the write have both succeeded by now, so an
    // exception raised by the destination — it is the caller's code, and it replaces this page —
    // must not be reported here as a failed join: that would invite a retry of a join that already
    // happened, and the retry answers `name_taken`.
    if (done) done.hand(done.weaveId);
  };

  return (
    <section class="join-lobby">
      <h2>Join the Lobby</h2>
      <p class="join-lobby-title">{lobby.title}</p>
      <form onSubmit={submit}>
        {/* No `maxLength`: silently truncating at 32 hides the rule instead of stating it, and the
            hint plus the disabled Join already say what is wrong with a longer name. */}
        <label>Name <input value={name} onInput={(e) => change((e.target as HTMLInputElement).value)} /></label>
        <button type="submit" disabled={!valid || busy}>Join</button>
        <p class="hint">1–32 characters: letters, digits, <code>_ . -</code></p>
        {error && <p class="error">{error}</p>}
        {taken !== undefined && suggestion !== undefined && (
          <div class="join-taken error">
            <p>
              <code>{taken}</code>
              {" is already in the Lobby. If that was you from a browser that did not save its key, "
                + "that identity cannot be recovered — pick another name."}
            </p>
            {/* `type="button"`: the suggestion fills the field and stops there. Auto-submitting a
                guess the server never confirmed would spend a request on the human's behalf. */}
            <button type="button" onClick={() => change(suggestion)}>{`Try ${suggestion}?`}</button>
          </div>
        )}
      </form>
    </section>
  );
}
