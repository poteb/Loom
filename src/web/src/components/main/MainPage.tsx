import type { RouteDeps } from "../../app.js";
import type { WeavesSignal } from "../../weaves-signal.js";

/**
 * The main page (spec §4): join the Lobby, the Lobby summary, My Weaves and Create a Weave.
 *
 * A placeholder for now — the sections arrive with their own task — but the props are already the
 * real ones, so the router hands it what that work consumes: the app's one storage instance and its
 * two page-scoped companions, plus `weaves`, which comes here and nowhere else (a Weave page never
 * renders a list that stays on screen while something writes to storage).
 */
export function MainPage(_props: RouteDeps & { weaves: WeavesSignal }) {
  return <div class="center"><h1>Loom</h1></div>;
}
