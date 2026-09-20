import { useEffect, useMemo, useState } from "preact/hooks";
import { LoomClientError, type Lobby } from "@loom/client";
import type { RouteDeps } from "../../app.js";
import { leavingIsSafe } from "../../persistence.js";
import { hasIdentity, invalidateIdentity, readWeaveEntry, readerFor, weaveKey } from "../../weaves-store.js";
import { HomeLink } from "../HomeLink.js";
import { PersistenceBar } from "../PersistenceBar.js";
import { JoinLobbyForm } from "../main/JoinLobbyForm.js";
import { ListenersPage } from "./ListenersPage.js";

type Found =
  | { kind: "loading" } | { kind: "lobby"; lobby: Lobby }
  | { kind: "none" } | { kind: "error"; message: string };

/**
 * `/lobby/listeners` (spec §5.2). The route owns the pointer, the credential and the two ways of
 * having neither — never the controls, which belong to the page below it.
 *
 * The pointer is resolved exactly as `LobbyRoute` resolves it: `weave_not_found` is the instance's
 * own answer and settles the question, and every other failure is a failed *read*, which says so
 * rather than claiming there is no Lobby.
 */
export function ListenersRoute(props: RouteDeps & { inPlace?: boolean }) {
  const { client, storage, notice, openMainInPlace } = props;
  const [found, setFound] = useState<Found>({ kind: "loading" });
  // The notice is a plain page-scoped object, so a subscription is what turns a failed write — this
  // page's own join, or one made before an in-place transition — into a render. The cards below read
  // it on every one of them.
  const [, setNoticeVersion] = useState(0);
  useEffect(() => notice.subscribe(() => setNoticeVersion((n) => n + 1)), [notice]);
  useEffect(() => {
    let live = true;
    client.getLobby().then(
      (lobby) => { if (live) setFound({ kind: "lobby", lobby }); },
      (e: unknown) => {
        if (!live) return;
        setFound(e instanceof LoomClientError && e.code === "weave_not_found"
          ? { kind: "none" }
          : { kind: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => { live = false; };
  }, [client]);

  // No entry to ask about until the pointer is known, so the page-scoped half of the rule is the
  // whole of it on these two cards.
  const back = leavingIsSafe(storage, notice) ? undefined : openMainInPlace;
  const body = found.kind === "loading"
    ? <div class="center">Loading…</div>
    : found.kind === "error"
      ? <div class="center error"><h1>Loom</h1><p>{found.message}</p>
        <p><HomeLink openMainInPlace={back} /></p></div>
      : found.kind === "none"
        ? (
          <div class="center">
            <h1>Loom</h1>
            <p>This instance has no Lobby yet.</p>
            <p><HomeLink openMainInPlace={back} /></p>
          </div>
        )
        : <ListenersMount {...props} lobby={found.lobby} />;
  // The §6 notice belongs to the page, and this page can be reached by a transition that raised it:
  // `openListenersInPlace` exists for exactly the browser that is keeping nothing. It rides every
  // state, as `WeaveView`'s banner does, because the join card is one of them.
  return <><PersistenceBar notice={notice} />{body}</>;
}

/**
 * The credential, and the one way this page offers of getting one.
 *
 * `readerFor` makes the same choice the session makes — the participant token when the identity is
 * usable, the stored Weave secret when it is not — so the directory is never read with a credential
 * the Lobby page next door would not have used. Nothing at all means the join form, whose two
 * callbacks land in the same place: this route *is* the destination, so a join has nowhere to
 * navigate to and re-runs the first query here instead, durable or not (spec §5.5).
 */
function ListenersMount({ client, storage, notice, openInPlace, openMainInPlace, lobby, inPlace }:
  RouteDeps & { lobby: Lobby; inPlace?: boolean }) {
  const [reloadKey, setReloadKey] = useState(0);
  /** The end of the fallback chain: the stored secret itself was refused, so there is no credential
   *  left to try and the page settles instead of asking again (see `onCredentialFailure`). */
  const [refused, setRefused] = useState(false);
  const entry = readWeaveEntry(storage, lobby.weaveId);
  // `client.withToken` builds a **new** `LoomClient` on every call, so a `readerFor` recomputed on
  // every render hands the page below a reader whose *identity* changes each time — and every effect
  // keyed on it re-fires. Dismissing the bar above is a render this page already has, and it must not
  // cost a second query. The credential is what a reader is made of, so it is what the memo is keyed
  // on: which credential, and which kind it is (a token and a secret build different readers, and a
  // token that happened to equal a secret must not read as a hit). The hooks sit above every
  // conditional return, so the order is the same on the join fork as on the directory fork.
  const credential = hasIdentity(entry) ? `token:${entry.token}` : entry?.secret ? `secret:${entry.secret}` : "none";
  // `entry` is deliberately not a dependency: it is a fresh object every render, and `credential` is
  // the whole of what `readerFor` reads out of it.
  const choice = useMemo(() => readerFor(client, entry), [client, credential]);
  /**
   * A listeners query came back 401/403, and the guard in the page let it through: that credential
   * is provably dead (spec §5.5). Which credential decides what may be done about it, and **only
   * the identity fork may retry**:
   *
   * - the **participant token** → invalidate it and re-read the entry, which falls through to the
   *   stored secret, or to the join form when there is none. The **write happens first, into a
   *   variable, and is reported after** — `notice.note(invalidateIdentity(…))` written as one
   *   expression is the shape that skips the write whenever nobody is listening.
   * - the **stored secret** → there is nothing behind it and nothing of it in storage to retire, so
   *   invalidating and remounting would send the very same secret again, be refused again, and
   *   write again, without bound. This is a terminal state: say what happened and offer the one
   *   credential that could still work, a fresh join.
   */
  const onCredentialFailure = () => {
    if (!choice?.withToken) { setRefused(true); return; }
    const wrote = invalidateIdentity(storage, lobby.weaveId);
    notice.note(wrote);
    setReloadKey((n) => n + 1);
  };
  if (refused || !choice) {
    // The same fork `WeaveRoute` renders for an unjoined Lobby, and with a way home of its own for
    // the same reason: this card replaces the page whole, header included, so without one there is
    // no way out but the address bar.
    const canLeave = leavingIsSafe(storage, notice, weaveKey(lobby.weaveId));
    const rejoin = () => { setRefused(false); setReloadKey((n) => n + 1); };
    return (
      <div class="page-join">
        {/* Read out of storage rather than remembered from the failure: an identity this browser
            retired on some earlier page load is just as invalid, and says so the same way. */}
        {entry?.identity === "invalid" && (
          <p class="error page-join-invalid">Your identity in the Lobby is no longer valid.</p>
        )}
        {/* The secret's refusal, which storage cannot record: the link is still there and still the
            only thing this browser has, so the sentence is about what the Lobby answered. */}
        {refused && (
          <p class="error page-join-refused">The Lobby refused the link this browser holds.</p>
        )}
        <JoinLobbyForm client={client} storage={storage} notice={notice}
          lobby={{ weaveId: lobby.weaveId, title: lobby.title }}
          onJoined={rejoin} onJoinedInPlace={rejoin} />
        <p class="page-join-home"><HomeLink openMainInPlace={canLeave ? undefined : openMainInPlace} /></p>
      </div>
    );
  }
  // `key={reloadKey}` is what makes a rejoin — and a fall back to the secret — a fresh page with a
  // fresh first query, rather than one that kept the state of a credential that is gone.
  return (
    <ListenersPage key={reloadKey} reader={choice.reader} lobbyId={lobby.weaveId} inPlace={inPlace}
      storage={storage} notice={notice} openInPlace={openInPlace} openMainInPlace={openMainInPlace}
      onCredentialFailure={onCredentialFailure} />
  );
}
