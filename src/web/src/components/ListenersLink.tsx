import type { SessionState } from "../session.js";

/**
 * The Lobby sidebar's way into the listeners directory (spec §5.1), in the file position the stack
 * of profile cards used to hold. `getWeave` carries no Lobby profile at all now (§3.1), so the
 * sidebar has nothing left to stack — what it has is a number, and a way to the page that can
 * search, filter and page through the listeners behind it.
 *
 * The Lobby gate is the cards' own, unchanged: id-based, so it needs nothing from this work. It is
 * asked together with the status because neither count cell is cleared by a load — a reload keeps
 * the Weave, the pointer and the last number on screen while it runs, and a page that is not
 * actually showing the Lobby has no directory to offer a way into.
 */
export function ListenersLink({ state, openListenersInPlace }: {
  state: SessionState;
  /**
   * Given only when leaving this JS context would lose the credential this page holds (spec §5.1),
   * and then the line is a button rather than an `<a href>`. The route asks `leavingIsSafe` on
   * every render and hands down the answer; this component renders it.
   */
  openListenersInPlace?: () => void;
}) {
  if (state.status !== "ready" || !state.lobby || state.lobby.weaveId !== state.weave?.id) return null;
  // `listenerCount` alone cannot say whether the number is missing because nothing has answered yet
  // or because the read failed, and spec §5.1 words those two states differently. A known number
  // always wins: a failed refresh behind a number that is on screen is a stale number, not a
  // missing one, and saying "count unavailable" beside it would be a worse answer than saying
  // nothing. And there is no `(0)` branch here at all — an absent count is an absent number, while
  // a zero the Lobby actually answered is a number like any other.
  const label = state.listenerCount !== undefined
    ? `Listeners (${state.listenerCount.toLocaleString()})`
    : "Listeners";
  return (
    <section class="listeners-line">
      {/* A button rather than an anchor with a handler: an anchor can be middle-clicked or opened
          in a new tab, and either one is the full page load that drops an in-memory credential. */}
      {openListenersInPlace
        ? <button type="button" class="listeners-line-link" onClick={() => openListenersInPlace()}>{label}</button>
        : <a class="listeners-line-link" href="/lobby/listeners">{label}</a>}
      {state.listenerCount === undefined && state.listenerCountError && <span class="muted">count unavailable</span>}
    </section>
  );
}
