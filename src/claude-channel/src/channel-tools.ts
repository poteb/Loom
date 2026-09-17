import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoomClientError, type LoomClient } from "@loom/client";
import { fail, ok } from "@loom/mcp-tools";
import type { ChannelState, Prefs } from "./state.js";
import { redact } from "./log.js";

export type ChannelHooks = { onLeave(weaveId: string): void; onPrefsChanged(weaveId: string, prefs: Prefs): void };

/** How long one Weave's guidelines read may take before `list_joined` answers without it. The same
 *  budget the startup instance-guidelines fetch uses: a listing an agent is waiting on must come
 *  back, and the text is reachable afterwards through the per-Weave resource. */
const GUIDELINES_DEADLINE_MS = 2000;
/** How many of those reads run at once. A machine joined to a few dozen Weaves would otherwise open
 *  a socket per Weave in one burst, against a server that is answering the session's own traffic. */
const GUIDELINES_CONCURRENCY = 4;

/** Maps `items` with at most `limit` calls in flight, preserving input order. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function registerChannelTools(server: McpServer, state: ChannelState, client: LoomClient, hooks: ChannelHooks): void {
  server.registerTool("list_joined", {
    description: "List the Weaves this machine's Loom channel is joined to (the identity is shared by every Claude Code session here), with your participant name, this session's wake mode and invites flag, guidelines (the instance's and that Weave's rules as they stand now — read them before posting), and lastSeq: the last event this session's stream has processed (in 'mentions' mode that includes events it did not wake you for; use read_events to see them).",
    inputSchema: {},
  }, async () => ok(await pooled(Object.entries(state.load().weaves), GUIDELINES_CONCURRENCY, async ([weaveId, w]) => {
    const entry = {
      weaveId, title: w.title, participantName: w.participantName, participantId: w.participantId, generalThreadId: w.generalThreadId, ...state.prefs(weaveId), lastSeq: state.cursor(weaveId),
    };
    // One Weave's guidelines are a fetch that can fail (a revoked token, a server that is down) or
    // never answer at all; reporting that per Weave, under a deadline, beats failing or stalling the
    // whole listing, which is how a session finds its way back to everything else it is joined to.
    try {
      return { ...entry, guidelines: (await client.withToken(w.token).getWeave(weaveId, { signal: AbortSignal.timeout(GUIDELINES_DEADLINE_MS) })).guidelines };
    } catch (e) {
      // The message goes into the agent's transcript: a server that echoes the token it rejected
      // would otherwise put it there verbatim.
      return { ...entry, guidelines: null, guidelinesError: redact(e instanceof Error ? e.message : String(e)) };
    }
  })));

  server.registerTool("set_wake", {
    description: "Preferences for this session only. wake: 'all' (every message and system event) or 'mentions' (only messages that @mention you). invites: whether an invite addressed to you wakes this session (default true; it wakes even in 'mentions' mode). requests: whether a new Lobby request you are eligible for wakes this session (default true); turning it off never silences a request you are already part of — an offer on your own request, its closure, or an acceptance naming you still wakes you. Other Claude Code sessions keep their own settings.",
    inputSchema: { weaveId: z.string(), wake: z.enum(["all", "mentions"]).optional(), invites: z.boolean().optional(), requests: z.boolean().optional() },
  }, async ({ weaveId, wake, invites, requests }) => {
    if (!state.load().weaves[weaveId]) return fail("no_weave", "Not joined to that Weave");
    if (wake === undefined && invites === undefined && requests === undefined) return fail("validation", "Pass wake, invites and/or requests");
    const prefs = await state.setPrefs(weaveId, {
      ...(wake !== undefined ? { wake } : {}), ...(invites !== undefined ? { invites } : {}), ...(requests !== undefined ? { requests } : {}),
    });
    hooks.onPrefsChanged(weaveId, prefs);
    return ok({ weaveId, ...prefs });
  });

  server.registerTool("leave_weave", {
    description: "Stop receiving events from a Weave and forget the stored participant token. (The participant stays in the Weave; joining again creates a new participant.) Leaving the Lobby is a two-step: your Lobby profile is cleared on the server first, because a profile with nobody behind it stays eligible for work nobody will answer. If that call fails the leave fails and nothing is removed — retry when the server is reachable, or pass force: true to drop the credential anyway and be told the profile may still be live.",
    inputSchema: { weaveId: z.string(), force: z.boolean().optional().describe("Leave the Lobby even if the profile could not be cleared") },
  }, async ({ weaveId, force }) => {
    const w = state.load().weaves[weaveId];
    if (!w) return fail("no_weave", "Not joined to that Weave");
    let profileMayRemain = false;
    // An entry without the flag is not proof this is not the Lobby: it may have been joined by
    // secret, or stored before the flag existed. Ask, and treat a match as the Lobby. Not being able
    // to ask is the same situation as not being able to clear the profile — the credential a retry
    // needs is what is about to be dropped — so it is refused the same way.
    let isLobby = w.isLobby === true;
    if (!isLobby) {
      try {
        isLobby = (await client.getLobby()).weaveId === weaveId;
      } catch (e) {
        // `weave_not_found` is an answer rather than a failure: this instance has no Lobby at all,
        // so this Weave is certainly not it and an ordinary leave proceeds.
        if (!(e instanceof LoomClientError && e.code === "weave_not_found")) {
          const why = redact(e instanceof Error ? e.message : String(e));
          if (!force) return fail("network", `Could not check whether this Weave is the Lobby, so nothing was removed — you are still joined. Retry when the server is reachable, or pass force: true to drop the credential anyway (a Lobby profile, if this is the Lobby, stays live until someone clears it): ${why}`);
          profileMayRemain = true;
        }
      }
    }
    if (isLobby) {
      try {
        await client.withToken(w.token).setCapabilities(null);
      } catch (e) {
        // Nothing local is touched: the credential is what a retry needs, and the profile is
        // authoritative on the server until it is cleared with it.
        const why = redact(e instanceof Error ? e.message : String(e));
        if (!force) return fail("network", `Could not clear your Lobby profile, so nothing was removed — you are still joined. Retry when the server is reachable, or pass force: true to drop the credential anyway (the profile stays live until someone clears it): ${why}`);
        profileMayRemain = true;
      }
    }
    hooks.onLeave(weaveId);
    await state.removeWeave(weaveId);
    return ok({ weaveId, left: true, ...(profileMayRemain ? { profileMayRemain: true } : {}) });
  });
}
