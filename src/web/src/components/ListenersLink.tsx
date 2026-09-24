import type { SessionState } from "../session.js";

/**
 * The Lobby sidebar's way into the listeners directory (spec §8): the `Listeners` section header and
 * its `View all <n>` toggle, in the file position the stack of
 * profile cards used to hold. `getWeave` carries no Lobby profile at all now (§3.1), so the sidebar
 * has nothing left to stack — what it has is a number, and a toggle for the region of this page
 * that can search, filter and page through the listeners behind it.
 *
 * The Lobby gate is the cards' own, unchanged: id-based, so it needs nothing from this work. It is
 * asked together with the status because neither count cell is cleared by a load — a reload keeps
 * the Weave, the pointer and the last number on screen while it runs, and a page that is not
 * actually showing the Lobby has no directory to offer a way into.
 */
export function ListenersLink({ state, active, onToggle }: {
  state: SessionState;
  /** `showListeners` — the *effective* view, never the raw one (spec §8): the line says what is on
   *  screen, and it is the same predicate that put it there. */
  active: boolean;
  onToggle: () => void;
}) {
  if (state.status !== "ready" || !state.lobby || state.lobby.weaveId !== state.weave?.id) return null;
  // `listenerCount` alone cannot say whether the number is missing because nothing has answered yet
  // or because the read failed, and spec §5.1 words those two states differently. A known number
  // always wins: a failed refresh behind a number that is on screen is a stale number, not a
  // missing one, and saying "count unavailable" beside it would be a worse answer than saying
  // nothing. And there is no `(0)` branch here at all — an absent count is an absent number, while
  // a zero the Lobby actually answered is a number like any other.
  // "View all", then the number when there is one: the section label beside it already says what.
  const label = state.listenerCount !== undefined
    ? `View all ${state.listenerCount.toLocaleString()}`
    : "View all";
  // A `div`, not a `section`: a region with no accessible name is one more thing to step through on
  // the way past a single line, and the name a `section` would want is already on the control.
  return (
    <div class="nav-section listeners-line">
      <div class="nav-head">
        <span class="sec">Listeners</span>
        {/* Always a button, never an anchor: it toggles a region of the page it is already on, and an
            anchor could be middle-clicked into a full page load. The address bar is put right by the
            push of spec §4.2, which is the only place that knows whether this browser may have one.
            `aria-current` rather than `aria-pressed`, to match `ThreadList`'s thread buttons beside
            it: one convention for "this is the one you are looking at". */}
        <button type="button" class="listeners-line-link" aria-current={active ? "true" : undefined}
          onClick={() => onToggle()}>{label}</button>
      </div>
      {state.listenerCount === undefined && state.listenerCountError && <span class="muted nav-note">count unavailable</span>}
    </div>
  );
}
