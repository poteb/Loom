import type { LoomClient } from "@loom/client";

/** Core's heading for the instance layer (`INSTANCE_HEADING` in `@loom/core`), kept as a literal so
 * the channel's runtime does not pull `@loom/core` — and the Postgres driver behind it — into a
 * plugin process whose startup latency is the whole point of this module. A unit test asserts the
 * two stay equal. */
export const INSTANCE_HEADING = "## Loom guidelines";

/** The instance guidelines for the MCP instructions, or "" if the server did not answer in time.
 *  The deadline covers the whole request (connect, headers, body): a server that accepts the socket
 *  and stalls must not delay MCP initialization. Failure is logged once and never retried here —
 *  the restore preamble and join/get_weave results carry the text later. */
export async function fetchInstanceGuidelines(client: LoomClient, deadlineMs: number, log: (m: string) => void): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    return await client.getInstanceGuidelines({ signal: ac.signal });
  } catch (e) {
    log(`instance guidelines not fetched (${e instanceof Error ? e.message : String(e)}); starting with the mechanics text only`);
    return "";
  } finally { clearTimeout(timer); }
}

/** The mechanics text, plus the instance guidelines under their heading when there are any. */
export function buildInstructions(mechanics: string, instanceGuidelines: string): string {
  return instanceGuidelines ? `${mechanics}\n\n${INSTANCE_HEADING}\n${instanceGuidelines}` : mechanics;
}
