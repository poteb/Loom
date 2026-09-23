/** A 43-character base64url run: the shape of every keeper token, weave secret and participant token. */
const TOKEN_RUN = /[A-Za-z0-9_-]{43}/g;
/** The `user:password@` segment of a URL — the other place a credential can appear. */
const URL_CREDENTIALS = /:\/\/[^\s\/@]+@/g;
/** The shape of a stable driver error code (e.g. Postgres SQLSTATE `23505`) — never token-shaped. */
const STABLE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Blanks out anything secret-shaped. Every secret in this system is either a 43-char base64url
 * token or a credential embedded in a URL, so redacting those two shapes lets messages be kept.
 */
export function redact(s: string): string {
  return s.replace(TOKEN_RUN, "[redacted]").replace(URL_CREDENTIALS, "://[redacted]@");
}

/** One informational line on stdout, redacted like everything else this server writes (spec §4.4). */
export function logInfo(line: string): void {
  process.stdout.write(`${redact(line)}\n`);
}

/**
 * Logs an error as one line, carrying only its identity: name, code, a redacted message and a
 * short stack.
 *
 * Postgres driver errors hang the offending statement and its bound values off the error
 * (`query`, `parameters`, `detail`, `hint`, `where`) — that is where keeper tokens, weave secrets
 * and participant tokens live, so nothing but the fields below is ever written out. The stack is
 * cut down to its frames because its first line repeats the message unredacted.
 */
export function logError(context: string, err: unknown): void {
  const parts = [redact(context)];
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
    if (typeof e.name === "string") parts.push(redact(e.name));
    if (typeof e.code === "string" && STABLE_CODE.test(e.code)) parts.push(redact(e.code));
    if (typeof e.message === "string") parts.push(redact(e.message));
    if (typeof e.stack === "string") {
      const frames = e.stack.split("\n").filter((l) => l.startsWith("    at ")).slice(0, 5).map((l) => redact(l.trim()));
      if (frames.length > 0) parts.push(frames.join(" | "));
    }
  } else {
    parts.push(`thrown ${typeof err}`);   // could be anything, including a credential; do not print it
  }
  console.error(parts.join(" "));
}
