import { useEffect, useState } from "preact/hooks";
import { LoomClientError, type Lobby } from "@loom/client";
import type { RouteDeps } from "../app.js";
import type { SessionTarget } from "../session.js";
import { useSession } from "../useSession.js";
import { WeaveView } from "./WeaveView.js";
import { JoinLobbyForm } from "./main/JoinLobbyForm.js";

/**
 * The one place a Weave page is mounted, for all three of its routes (spec §2.7), and the owner of
 * the unjoined-Lobby fork (§3.3).
 */
export function WeaveRoute(props: RouteDeps & (
  | { lobbyRoute: true; target?: never }
  | { lobbyRoute?: false; target: SessionTarget })) {
  const deps: RouteDeps = props;
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
  const { client } = deps;
  const [found, setFound] = useState<Found>({ kind: "loading" });
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

  if (found.kind === "loading") return <div class="center">Loading…</div>;
  if (found.kind === "error") return <div class="center error"><h1>Loom</h1><p>{found.message}</p></div>;
  if (found.kind === "none") {
    return (
      <div class="center">
        <h1>Loom</h1>
        <p>This instance has no Lobby yet.</p>
        <p><a href="/">Go to the main page</a></p>
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

function WeaveMount({ client, storage, notice, target, lobby, onJoined }:
  RouteDeps & { target: SessionTarget; lobby?: Lobby; onJoined: () => void }) {
  const { session, state } = useSession(target, { client, storage, onWrite: notice.note });
  const [discovered, setDiscovered] = useState<Lobby | undefined>();
  // The fork (spec §3.3). Joining the Lobby needs no secret and joining anything else does, so a
  // page with no credential has to know which one it is looking at. A direct `/weave/<id>` link
  // carries no discovery of its own, so it resolves the public pointer itself — on this branch
  // only: a page that loaded fine never makes the call, and `/lobby` already knows the answer.
  const mustAsk = state.status === "no-credential" && target.kind === "id" && !lobby;
  useEffect(() => {
    if (!mustAsk) return;
    let live = true;
    // A failure needs no message of its own: what this page says without the answer is the
    // explanation of §3.3, which is also what it says when the ids do not match.
    client.getLobby().then((l) => { if (live) setDiscovered(l); }, () => {});
    return () => { live = false; };
  }, [client, mustAsk]);

  const here = lobby ?? discovered;
  const isLobby = !!here && target.kind === "id" && here.weaveId === target.weaveId;
  return (
    <WeaveView session={session} state={state}
      noCredential={here && isLobby
        ? (
          <div class="page-join">
            <JoinLobbyForm client={client} storage={storage} notice={notice}
              lobby={{ weaveId: here.weaveId, title: here.title }}
              onJoined={onJoined} onJoinedInPlace={onJoined} />
          </div>
        )
        : undefined} />
  );
}
