/**
 * One scheduler, shared by every render of one mounted list. Not a component, not Preact-aware, and
 * with no imports at all — so the bound of spec §4.2 can be tested without a DOM.
 */
export type RefreshQueue<T> = {
  /** Appends items to the FIFO and starts work up to the limit. A no-op after `dispose()`. */
  enqueue(items: T[]): void;
  /** Drops everything not yet started. Runs already in flight finish; nothing new begins. */
  dispose(): void;
};

/**
 * A FIFO with a cap on how many `run` calls are in flight at once — **the** bound of spec §4.2.
 *
 * It exists as a long-lived object rather than an `await`-all-the-batches helper because the bound
 * is on the browser, not on one batch: `MyWeaves` recomputes its visible slice on "Show more", on
 * each filter keystroke and on every `WeavesSignal` bump, and a per-batch helper would start a
 * fresh `limit` of work for each of those while the previous batch was still running. One queue per
 * mounted list keeps `active` honest across all of them.
 *
 * Generic in `T` rather than typed to a row: the row type lives in `MyWeaves.tsx`, which imports
 * this module, so naming it here would be a cycle.
 */
export function createRefreshQueue<T>(limit: number, run: (item: T) => Promise<void>): RefreshQueue<T> {
  const waiting: T[] = [];
  let active = 0;
  let disposed = false;

  const pump = (): void => {
    while (!disposed && active < limit && waiting.length > 0) {
      const item = waiting.shift()!;
      active += 1;
      void (async () => {
        try {
          await run(item);
        } catch {
          // Deliberately swallowed. `run` is `refreshRow`, which already records a failed row for
          // the human (`markRow`); anything that still escapes it is a bug in that function, not a
          // reason to strand this slot. Rethrowing here would skip the `finally` of every caller
          // there is (there is none — nobody awaits this), leave `active` counted up forever, and
          // starve every row behind it. It would also be an unhandled rejection in the page.
        } finally {
          active -= 1;
          pump();   // a freed slot immediately takes the next item, if any and if still alive
        }
      })();
    }
  };

  return {
    enqueue: (items) => {
      if (disposed) return;          // after unmount nothing new starts, including a late enqueue
      waiting.push(...items);        // appended: rows that arrive later wait behind earlier rows
      pump();
    },
    // Drops what has not started. What *has* started cannot be cancelled — `LoomClient` offers no
    // abort — so those requests finish and their results are discarded by the caller's own
    // mounted-check (`alive` in `MyWeaves`), which is why this needs no callback.
    dispose: () => { disposed = true; waiting.length = 0; },
  };
}
