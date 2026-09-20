import { useEffect, useState } from "preact/hooks";
import { LoomClientError, type Lobby } from "@loom/client";
import type { RouteDeps } from "../app.js";
import type { SessionTarget } from "../session.js";
import { useSession } from "../useSession.js";
import { leavingIsSafe } from "../persistence.js";
import { weaveKey } from "../weaves-store.js";
import { WeaveView } from "./WeaveView.js";
import { HomeLink } from "./HomeLink.js";
import { PersistenceBar } from "./PersistenceBar.js";
import { JoinLobbyForm } from "./main/JoinLobbyForm.js";

/**
 * The one place a Weave page is mounted, for all three of its routes (spec §2.7), and the owner of
 * the unjoined-Lobby fork (§3.3).
 */
export function WeaveRoute(props: RouteDeps & (
  | { lobbyRoute: true; target?: never }
  | { lobbyRoute?: false; target: SessionTarget })) {
  // Explicitly, not `{...props}`: the two route props below are this component's own business, and
  // spreading them onto children that ignore or overwrite them would say otherwise.
  const { client, storage, notice, openInPlace, openMainInPlace, openListenersInPlace } = props;
  const deps: RouteDeps = { client, storage, notice, openInPlace, openMainInPlace, openListenersInPlace };
  if (props.lobbyRoute) return <LobbyRoute {...deps} />;
  return <WeaveSession {...deps} target={props.target} />;
}

type Found =
  | { kind: "loading" } | { kind: "lobby"; lobby: Lobby }
  | { kind: "none" } | { kind: "error"; message: string };

/**
 * `/lobby` is `/weave/<lobby id>` with a friendlier URL, and one public lookup away from being it.
 *
 * `weave_not_found` is the instance's own answer — it has no Lobby yet — and settles the question.
 * Every other failure is a failed *read*, and saying "no Lobby" for one would be a guess about an
 * instance that may well have a perfectly good Lobby.
 */
export function LobbyRoute(deps: RouteDeps) {
  const { client, storage, notice, openMainInPlace } = deps;
  const [found, setFound] = useState<Found>({ kind: "loading" });
  // Same reason as `WeaveMount` below: the notice is a plain page-scoped object, and the two cards
  // this route can render ask it which element their way back should be.
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

  // No entry of its own to ask about — this route has not resolved a Weave — so the page-scoped
  // half of the rule is the whole of it here.
  const back = leavingIsSafe(storage, notice) ? undefined : openMainInPlace;
  if (found.kind === "loading") return <div class="center">Loading…</div>;
  if (found.kind === "error") {
    return <div class="center error"><h1>Loom</h1><p>{found.message}</p>
      <p><HomeLink openMainInPlace={back} /></p></div>;
  }
  if (found.kind === "none") {
    return (
      <div class="center">
        <h1>Loom</h1>
        <p>This instance has no Lobby yet.</p>
        <p><HomeLink openMainInPlace={back} /></p>
      </div>
    );
  }
  // The pointer is known here, so the page below never has to ask for it again.
  return <WeaveSession {...deps} target={{ kind: "id", weaveId: found.lobby.weaveId }} lobby={found.lobby} />;
}

/**
 * The session's lifetime, and the one thing that ends it early: a join made on this very page.
 *
 * A join here has nowhere to navigate to — this route *is* the destination — so the whole outcome
 * is a rebuilt session, over the **same** storage instance (§2.4a), which is what makes the
 * credential the join just wrote the one the new session reads, durable or not (§3.1). `key` is
 * what rebuilds it: `useSession` memoises on its target, and the target has not changed.
 *
 * Both of the form's callbacks land here. A durable join could reload the page instead, but there
 * is no reason to — the session it would rebuild is the one this already has, and one code path is
 * easier to be sure of than two.
 */
function WeaveSession(props: RouteDeps & { target: SessionTarget; lobby?: Lobby }) {
  const [reloadKey, setReloadKey] = useState(0);
  return <WeaveMount key={reloadKey} {...props} onJoined={() => setReloadKey((n) => n + 1)} />;
}

function WeaveMount({ client, storage, notice, openMainInPlace, openListenersInPlace, target, lobby, onJoined }:
  RouteDeps & { target: SessionTarget; lobby?: Lobby; onJoined: () => void }) {
  const { session, state } = useSession(target, { client, storage, onWrite: notice.note });
  // The notice is a plain page-scoped object, so a subscription is what turns a failed write —
  // raised by this session's own §10.9 entry write, or by the form that rendered this page in
  // place — into a render. The header's choice of element below is read on every one of them.
  const [, setNoticeVersion] = useState(0);
  useEffect(() => notice.subscribe(() => setNoticeVersion((n) => n + 1)), [notice]);
  const [discovered, setDiscovered] = useState<Lobby | undefined>();
  const [askFailed, setAskFailed] = useState(false);
  // The fork (spec §3.3). Joining the Lobby needs no secret and joining anything else does, so a
  // page with no credential has to know which one it is looking at. A direct `/weave/<id>` link
  // carries no discovery of its own, so it resolves the public pointer itself — on this branch
  // only: a page that loaded fine never makes the call, and `/lobby` already knows the answer.
  //
  // "Not answered yet" is part of the condition rather than a fact about the dep array: the one call
  // this branch makes is one because `asking` goes false the moment an answer (or a failure) lands.
  const asking = state.status === "no-credential" && target.kind === "id" && !lobby
    && discovered === undefined && !askFailed;
  useEffect(() => {
    if (!asking) return;
    let live = true;
    // A failure needs no message of its own: what this page says without the answer is the
    // explanation of §3.3, which is also what it says when the ids do not match.
    client.getLobby().then((l) => { if (live) setDiscovered(l); }, () => { if (live) setAskFailed(true); });
    return () => { live = false; };
  }, [client, asking]);

  // The way back to `/` (spec §3.1): whether it may be an anchor is the one question
  // `leavingIsSafe` answers, the same one My Weaves and Open the Lobby ask on the way in. Its two
  // halves behave differently and both are deliberate. The **pending** half is re-read on every
  // render, so a later write that does persist turns the control back into an ordinary link with
  // nothing clicked. The **notice** half latches for the life of the page and never clears: a
  // browser that has refused one write is not trusted with a full page load again, because what
  // that load costs is the whole in-memory store — this page may hold a Lobby identity written
  // before an in-place transition, and the main page lists every entry there is.
  const weaveId = state.weave?.id ?? (target.kind === "id" ? target.weaveId : undefined);
  const canLeave = leavingIsSafe(storage, notice, weaveId === undefined ? undefined : weaveKey(weaveId));

  const here = lobby ?? discovered;
  const isLobby = !!here && target.kind === "id" && here.weaveId === target.weaveId;
  // While the question is open the page has no honest card to show: the explanation is the wrong one
  // for the one Weave that can be joined from here, and a request is long enough to read. No way
  // home on it either, for the reason `WeaveView`'s `loading` card has none.
  const noCredential = asking
    ? <div class="center">Loading…</div>
    : here && isLobby
      ? (
        <div class="page-join">
          <JoinLobbyForm client={client} storage={storage} notice={notice}
            lobby={{ weaveId: here.weaveId, title: here.title }}
            onJoined={onJoined} onJoinedInPlace={onJoined} />
          {/* This element replaces the generic no-credential screen whole, `HomeLink` included, so
              without one of its own a credential-less Lobby page has no way back at all — not from
              the header either, which belongs to a loaded page. It is a page that can be degraded:
              a Lobby identity invalidated by a write that reached only memory lands right here. */}
          <p class="page-join-home"><HomeLink openMainInPlace={canLeave ? undefined : openMainInPlace} /></p>
        </div>
      )
      : undefined;
  // The §6 notice belongs to the page, not to the main page's layout. A join made from `/` whose
  // credential did not persist replaces `MainPage` — and its bar — with this route in the very same
  // render, and a `/w/<secret>` load writes its own entry here (§10.9), so without this seam the one
  // warning the human needs would be latched and never drawn. `App` hands every route the same
  // notice and mounts one route at a time, so it stays one bar, and one dismissal, per page load.
  //
  // The sidebar's way into the directory is decided by the same `canLeave`, and for the same reason
  // (spec §5.1): an anchor to `/lobby/listeners` can be middle-clicked, and on this browser that is
  // the page load which drops the only copy of the credential. The view renders the answer.
  return <WeaveView session={session} state={state} banner={<PersistenceBar notice={notice} />}
    noCredential={noCredential} openMainInPlace={canLeave ? undefined : openMainInPlace}
    openListenersInPlace={canLeave ? undefined : openListenersInPlace} />;
}
