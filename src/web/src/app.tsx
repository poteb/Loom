import { useState } from "preact/hooks";
import type { LoomClient } from "@loom/client";
import type { KeyValueStorage } from "./storage.js";
import type { PersistenceNotice } from "./persistence.js";
import type { WeavesSignal } from "./weaves-signal.js";
import { MainPage } from "./components/main/MainPage.js";
import { WeaveRoute } from "./components/WeaveRoute.js";
import type { MainArea } from "./lobby-view.js";

export type Route =
  | { kind: "main" }
  /** `view` is the area the page **opened** on, never a live value: the view itself lives in
   *  `WeaveSession` (spec §3.1), and after a `pushState` this field is deliberately not updated. */
  | { kind: "lobby"; view?: MainArea }
  | { kind: "weave"; weaveId: string } | { kind: "secret"; secret: string } | { kind: "unknown" };

const SECRET_RE = /^\/w\/([A-Za-z0-9_-]{43})\/?$/;
const WEAVE_RE = /^\/weave\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/**
 * Hand-rolled matching, as ARCHITECTURE §9 asks for ("Preact, no router"): these are exactly the
 * paths the server serves `index.html` for (spec §3.2), so anything else reaching this function is
 * a path this app was never asked to render.
 */
export function routeOf(pathname: string): Route {
  if (pathname === "/") return { kind: "main" };
  // Before `/lobby`, which is an exact-match comparison and therefore shadows nothing: the order is
  // for the reader, who checks the longer path first.
  if (pathname === "/lobby/listeners" || pathname === "/lobby/listeners/") return { kind: "lobby", view: "listeners" };
  if (pathname === "/lobby" || pathname === "/lobby/") return { kind: "lobby" };
  const w = WEAVE_RE.exec(pathname);
  if (w) return { kind: "weave", weaveId: w[1]! };
  const s = SECRET_RE.exec(pathname);
  if (s) return { kind: "secret", secret: s[1]! };
  return { kind: "unknown" };
}

/**
 * Everything the page is given once, at the root (`main.tsx`), and hands down: the client, the one
 * storage instance (§2.4a) and the two page-scoped companions of that instance — the persistence
 * notice (§6) and the "stored Weaves changed" signal (§4.2).
 */
export type AppDeps = {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice; weaves: WeavesSignal;
};

/** What every route is handed: the app-owned trio, plus the two ways to change the view in place. */
export type RouteDeps = {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice;
  /** Renders a Weave here, in this JS context, without touching the URL (spec §3.1). */
  openInPlace: (weaveId: string) => void;
  /**
   * The mirror of `openInPlace`: renders the main page here, for a Weave page whose credentials
   * would not survive leaving this JS context (spec §3.1). The URL is left alone for the same
   * reason it is on the way in — a pushed `/` would be an address that comes back empty-handed.
   */
  openMainInPlace: () => void;
};

export function App({ client, storage, notice, weaves }: AppDeps) {
  // The route is state, not just a parsed path: a join or a creation whose credential could not be
  // persisted switches the view here, in this JS context, rather than navigating away from the only
  // copy of that credential (spec §3.1). The URL is deliberately left alone — a pushed /lobby would
  // be an address this browser cannot honour after a reload.
  const [route, setRoute] = useState<Route>(() => routeOf(location.pathname));
  const openInPlace = (weaveId: string) => setRoute({ kind: "weave", weaveId });
  const openMainInPlace = () => setRoute({ kind: "main" });
  const deps: RouteDeps = { client, storage, notice, openInPlace, openMainInPlace };
  switch (route.kind) {
    // `weaves` goes to the main page only: it is the one place a list of stored Weaves stays on
    // screen while something writes to storage. A Weave page never renders one.
    case "main":   return <MainPage {...deps} weaves={weaves} />;
    // One element for both of the Lobby's addresses, which is the invariant of spec §3.2: a view
    // flip changes a prop and never the component at this position, so the session below it is
    // updated rather than unmounted.
    case "lobby":  return <WeaveRoute {...deps} lobbyRoute initialView={route.view} />;
    case "weave":  return <WeaveRoute {...deps} target={{ kind: "id", weaveId: route.weaveId }} />;
    case "secret": return <WeaveRoute {...deps} target={{ kind: "secret", secret: route.secret }} />;
    default:       return <div class="center"><h1>Loom</h1><p>No such page. <a href="/">Go to the main page</a>.</p></div>;
  }
}
