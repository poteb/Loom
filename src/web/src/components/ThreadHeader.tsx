import type { Thread } from "@loom/client";
import { isHttpUrl, shortUrl } from "./artefact.js";

/**
 * The center column's header over a Thread: its name and status, what it is about, the fold switch
 * for system events and the toggle for the details panel. Both switches are state the page holds;
 * this only draws them and reports a change. Not drawn while the listeners directory is the main
 * area, which has a heading of its own.
 */
export function ThreadHeader({ thread, fold, onFold, detailsOpen, onToggleDetails }: {
  thread: Thread;
  /** Whether runs of system events are folded in the stream below. */
  fold: boolean;
  onFold: (next: boolean) => void;
  /** Whether the details panel is on screen, which the toggle reports as `aria-expanded`. */
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <div class="thread-header">
      {/* <h2>: the page's <h1> is the Weave title in the top bar. */}
      <h2><span class="muted" aria-hidden="true">#</span> {thread.name}</h2>
      {thread.closedAt ? <span class="pill pill-closed">closed</span> : <span class="pill pill-open">open</span>}
      {thread.isGeneral
        ? <span class="muted thread-subtitle">Weave-wide thread</span>
        : thread.url && isHttpUrl(thread.url)
          ? <a class="thread-subtitle" href={thread.url} target="_blank" rel="noreferrer">{shortUrl(thread.url)}</a>
          : null}
      <div class="spacer" />
      <label class="fold-toggle">
        <input type="checkbox" checked={fold} onChange={(e) => onFold((e.target as HTMLInputElement).checked)} />
        Fold system events
      </label>
      <button type="button" class="btn btn-ghost icon-btn" aria-label="Thread details"
        aria-expanded={detailsOpen ? "true" : "false"} onClick={() => onToggleDetails()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
      </button>
    </div>
  );
}
