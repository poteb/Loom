/**
 * Logs an error as one line, carrying only its identity: name, code, message and a short stack.
 *
 * Postgres driver errors hang the offending statement and its bound values off the error
 * (`query`, `parameters`, `detail`, `hint`, `where`) — that is where keeper tokens, weave secrets
 * and participant tokens live, so nothing but the fields below is ever written out.
 */
export function logError(context: string, err: unknown): void {
  const parts = [context];
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
    if (typeof e.name === "string") parts.push(e.name);
    if (typeof e.code === "string") parts.push(e.code);
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.stack === "string") parts.push(e.stack.split("\n").slice(0, 5).map((l) => l.trim()).join(" | "));
  } else {
    parts.push(`thrown ${typeof err}`);   // could be anything, including a credential; do not print it
  }
  console.error(parts.join(" "));
}
