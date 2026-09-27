/** Which of the Lobby page's two things the main area is showing (spec §3.1). A string union rather
 *  than a boolean, because the main area is one slot showing one thing and a name reads better at
 *  every call site than `listenersOpen`. */
export type MainArea = "thread" | "listeners";

/** `undefined` when this is not one of the Lobby's four addresses — which is also the first half of
 *  the push rule (spec §4.2): a Lobby rendered in place sits on another page's path and writes nothing. */
export function viewOfPath(pathname: string): MainArea | undefined {
  if (pathname === "/lobby/listeners" || pathname === "/lobby/listeners/") return "listeners";
  if (pathname === "/lobby" || pathname === "/lobby/") return "thread";
  return undefined;
}

/** The canonical spelling this app writes, never a trailing slash. */
export function pathForView(view: MainArea): string {
  return view === "listeners" ? "/lobby/listeners" : "/lobby";
}

/** Whether `pathname` is `/weave/<weaveId>`, either spelling. For the Lobby's id that is an old
 *  spelling of `/lobby`, which the Lobby page replaces with its own (amended 2026-09-27). */
export function isWeavePathOf(pathname: string, weaveId: string): boolean {
  return pathname === `/weave/${weaveId}` || pathname === `/weave/${weaveId}/`;
}
