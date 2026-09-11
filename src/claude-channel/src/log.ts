/** Diagnostics must never contain tokens or secrets: strip 43-char base64url runs (participant/keeper tokens) and URL credentials before anything reaches stderr. */
export function redact(s: string): string {
  return s.replace(/[A-Za-z0-9_-]{43}/g, "[redacted]").replace(/:\/\/[^\s/@]+@/g, "://[redacted]@");
}

export function log(msg: string): void {
  process.stderr.write(`loom channel: ${redact(msg)}\n`);
}
