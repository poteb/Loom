import { useEffect, useRef, useState } from "preact/hooks";
import { LoomClientError, type Lobby } from "@loom/client";
import type { RouteDeps } from "../../app.js";
import type { WeavesSignal } from "../../weaves-signal.js";
import { leavingIsSafe } from "../../persistence.js";
import { hasIdentity, migrateLegacy, readWeaveEntry, weaveKey } from "../../weaves-store.js";
import { PersistenceBar } from "../PersistenceBar.js";
import { InstanceGuidelines } from "./InstanceGuidelines.js";
import { LobbySummary } from "./LobbySummary.js";
import { JoinLobbyForm } from "./JoinLobbyForm.js";
import { MyWeaves } from "./MyWeaves.js";
import { CreateWeaveForm } from "./CreateWeaveForm.js";

/**
 * The Lobby pointer: one of the page's four independent cells (spec §6). `none` is the instance's
 * own answer — it has no Lobby yet — and is deliberately not an `error`: nothing went wrong, §4.1 is
 * simply hidden, and the summary says so in its own voice.
 */
type LobbyCell =
  | { kind: "loading" } | { kind: "lobby"; lobby: Lobby }
  | { kind: "none" } | { kind: "error"; message: string };

/**
 * The main page (spec §4): what this instance is, how to get into the Lobby, what this browser
 * already holds, and how to make a new Weave.
 *
 * Four independent async cells — the guidelines, the Lobby pointer, the Lobby counts and My Weaves —
 * each `loading → value | error`. A failure in one is a line inside that section and never blanks
 * another: the join form is usable while the rest is still loading.
 *
 * It is also the page that owns the two page-scoped companions of the one storage instance. Every
 * write made from here reports its verdict to `notice.note` — `notice.note` is the only `onWrite`
 * anywhere — so the join, the creation, the migration below and every write My Weaves makes all
 * raise the *one* bar this component renders. And every writer that can change what My Weaves shows
 * bumps `weaves`, which this page listens to as well: the Lobby entry it reads to choose between the
 * join form and "Open the Lobby" is one of the entries a migration can resolve after the first
 * paint.
 */
export function MainPage({ client, storage, notice, weaves, openInPlace }: RouteDeps & { weaves: WeavesSignal }) {
  const [cell, setCell] = useState<LobbyCell>({ kind: "loading" });
  const [, setVersion] = useState(0);
  useEffect(() => weaves.subscribe(() => setVersion((n) => n + 1)), [weaves]);
  // The notice as well as the signal: `leavingIsSafe` below — and in every My Weaves row — reads
  // the page's latch, and a failed write raises it without necessarily touching an entry anyone is
  // listing. `PersistenceBar` has its own subscription for its own rendering; this one is for the
  // links, and one bump here re-renders the rows too.
  useEffect(() => notice.subscribe(() => setVersion((n) => n + 1)), [notice]);

  useEffect(() => {
    let live = true;
    client.getLobby().then(
      (lobby) => { if (live) setCell({ kind: "lobby", lobby }); },
      (e: unknown) => {
        if (!live) return;
        setCell(e instanceof LoomClientError && e.code === "weave_not_found"
          ? { kind: "none" }
          : { kind: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => { live = false; };
  }, [client]);

  // Once per page load, not once per render: a bump re-renders My Weaves and can re-render this
  // component, and a second pass would re-walk keys the first is still writing. `onChanged` is what
  // turns a legacy row on screen into a resolved one without the human doing anything (spec §4.2).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void migrateLegacy(storage, notice, (s) => client.lookupWeave(s), () => weaves.bump());
  }, []);

  const lobby = cell.kind === "lobby" ? cell.lobby : undefined;
  const entry = lobby ? readWeaveEntry(storage, lobby.weaveId) : undefined;
  const joined = hasIdentity(entry);
  // The name this browser joined under, cached in the entry by the join itself. `undefined` for an
  // entry written before that was kept, which the greeting below is written to survive.
  const joinedAs = hasIdentity(entry) ? entry.name : undefined;
  // "Joined once, and it stopped working" is not "never joined": §4.1 shows the form for both and
  // says which of the two this is.
  const wasInvalid = entry?.identity === "invalid";
  // The one full-page-load helper this page owns. Most navigation here is an ordinary `<a href>`;
  // this one exists because a form has no destination until it has one, and where it goes is
  // decided here rather than inside the form (spec §3.1).
  const navigate = (path: string) => { location.href = path; };
  /**
   * Where a **successful** form exit goes. The write's own verdict is not the question: a join or a
   * creation that persisted perfectly well can still be standing on a page holding some *other*
   * entry that did not, and a full page load takes that one with it. So the destination is chosen
   * by the same `leavingIsSafe` the links use — and chosen **here, at the moment of leaving**, not
   * at the moment of the write: the latch can trip in between, while the save-this-link panel is
   * still on screen and a My Weaves refresh fails behind it.
   */
  const leaveFor = (weaveId: string, path: string) => {
    if (leavingIsSafe(storage, notice, weaveKey(weaveId))) navigate(path);
    else openInPlace(weaveId);
  };
  // …and the same question for the Lobby link, asked through the one helper (spec §3.1): an
  // identity that exists only as a pending override is one full page load from gone — and so is
  // every other memory-only entry on this page, which is why a degraded notice keeps this link in
  // place too, even when the Lobby's own entry is perfectly durable.
  const lobbyInMemoryOnly = !!lobby && joined && !leavingIsSafe(storage, notice, weaveKey(lobby.weaveId));
  const openLobby = lobby && (lobbyInMemoryOnly
    ? <button type="button" class="lobby-open-inplace" onClick={() => openInPlace(lobby.weaveId)}>Open the Lobby</button>
    : <a href="/lobby">Open the Lobby</a>);

  return (
    <div class="main-page">
      <PersistenceBar notice={notice} />
      <h1>Loom</h1>
      <InstanceGuidelines client={client} />
      <LobbySummary client={client} storage={storage} lobby={lobby}
        error={cell.kind === "error" ? cell.message : undefined} noLobby={cell.kind === "none"} />
      {lobby && (joined ? (
        joinedAs !== undefined
          ? <p class="lobby-open">You are in the Lobby as <strong>{joinedAs}</strong>. {openLobby}</p>
          : <p class="lobby-open">You are already in the Lobby. {openLobby}</p>
      ) : (
        <>
          {wasInvalid && <p class="muted">The identity this browser had in the Lobby stopped working — join again.</p>}
          {/* Both callbacks leave this page, which is why the form takes no `WeavesSignal`. The
              form reports what its own write did; this page decides what that means for the page,
              so even the durable hand-over goes through `leaveFor` (spec §3.1). */}
          <JoinLobbyForm client={client} storage={storage} notice={notice}
            lobby={{ weaveId: lobby.weaveId, title: lobby.title }}
            onJoined={(id) => leaveFor(id, "/lobby")} onJoinedInPlace={openInPlace} />
        </>
      ))}
      <MyWeaves client={client} storage={storage} weaves={weaves} onWrite={notice.note} notice={notice}
                openInPlace={openInPlace} lobbyWeaveId={lobby?.weaveId} />
      <CreateWeaveForm client={client} storage={storage} notice={notice} weaves={weaves}
                       defaultName={joinedAs} open={(id) => leaveFor(id, `/weave/${id}`)} />
    </div>
  );
}
