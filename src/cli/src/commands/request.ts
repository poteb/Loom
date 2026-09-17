import { InvalidArgumentError, type Command } from "commander";
import type { LoomRequest, Offer, Requirements, RequestStatus } from "@loom/client";
import { CliError, textArg, type CliContext, type CliIo } from "../context.js";
import { emit } from "../output.js";
import { jsonArg, lobbyContext } from "./lobby.js";

/** A deadline as the local clock shows it; the exact instant is in `--json`. */
export function hhmm(v: unknown): string {
  const d = new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) return "?";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A commander argParser: an integer >= 1, else a usage error. */
function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be an integer >= 1");
  return n;
}

/**
 * `90m`, `2h`, `45s` or plain milliseconds, as milliseconds. Only the shape is read here: what
 * range a timeout may fall in is core's rule, and its refusal is the one the user sees.
 */
export function durationMs(v: string): number {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(v.trim());
  if (!m) throw new InvalidArgumentError("must be a duration like 90m, 2h, 45s or a number of milliseconds");
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] ?? "ms"] ?? 1;
  return Number(m[1]) * unit;
}

const spec = (model: string | null, effort: string | null): string => [model, effort].filter((x) => x).join("/");

function offerLine(o: Offer): string {
  const s = spec(o.model, o.effort);
  return `  ${o.participantId}${s ? `  ${s}` : ""}${o.accepted ? "  [accepted]" : ""}${o.note ? `  "${o.note}"` : ""}`;
}

/** The one-line form `request list` prints, and the head of `request show`. */
function requestLine(r: LoomRequest): string {
  const accepted = r.offers.filter((o) => o.accepted).length;
  return `${r.id}  ${r.status}  wants ${r.wanted} (${r.offers.length} offered, ${accepted} accepted)  expires ${hhmm(r.expiresAt)}  → "${r.targetWeaveTitle}"`;
}

function requestBlock(r: LoomRequest): string {
  const accepted = r.offers.filter((o) => o.accepted).length;
  const lines = [
    `Request ${r.id} [${r.status}]`,
    `  owner:    ${r.owner || "(none)"}`,
    `  wants:    ${r.wanted} (${accepted} accepted)`,
    `  expires:  ${hhmm(r.expiresAt)}`,
    `  target:   "${r.targetWeaveTitle}" (${r.targetWeaveId}) thread ${r.targetThreadId}`,
    ...(r.url ? [`  url:      ${r.url}`] : []),
    `  requires: ${JSON.stringify(r.requirements)}`,
    ...(r.eligible ? [`  eligible: ${r.eligible.length}`] : []),
    "Offers:",
    ...(r.offers.length > 0 ? r.offers.map(offerLine) : ["  (none)"]),
  ];
  return lines.join("\n");
}

/**
 * The Weave the helpers would be pulled into, and the authority in it. `--weave` is the global
 * option (there is only one), so the default credential is the token stored for that Weave — the
 * same one every other command there uses. `--target-token` replaces it without needing a stored
 * join, for a keeper working from a machine that never joined the target.
 */
function target(c: CliContext, explicit?: string): { weaveId: string; credential: string } {
  if (explicit === undefined) {
    const { weaveId, entry } = c.resolveWeave();
    return { weaveId, credential: entry.token };
  }
  const weaveId = c.opts.weave ?? c.config.lastWeave;
  if (!weaveId) throw new CliError("no_weave", "No target Weave: pass --weave <id>");
  return { weaveId, credential: explicit };
}

export function registerRequestCommands(program: Command, ctx: () => CliContext, io: CliIo): void {
  const request = program.command("request").description("Ask the Lobby for help, and answer what it asks of you");

  request.command("open")
    .description("Open a request for helpers to be invited into a Thread of the target Weave")
    .requiredOption("--title <title>", "What the helpers are wanted for")
    .requiredOption("--require <json>", "Requirements, as JSON; - reads stdin")
    .option("--wanted <n>", "How many helpers to take", positiveInt)
    .option("--timeout <dur>", "How long to stay open (90m, 2h, or milliseconds)", durationMs)
    .requiredOption("--thread <id>", "Thread of the target Weave the helpers are invited into")
    .option("--url <url>", "Artefact the request is about")
    .option("--target-token <token>", "Authority in the target Weave (default: your stored token for --weave)")
    .addHelpText("after", "\nThe target Weave is the global --weave <id> (default: the last Weave created or joined).")
    .action(async (o: { title: string; require: string; wanted?: number; timeout?: number; thread: string; url?: string; targetToken?: string }) => {
      const c = ctx();
      const { weaveId, credential } = target(c, o.targetToken);
      const { client } = await lobbyContext(c);
      const r = await client.openRequest({
        title: o.title, requirements: jsonArg(await textArg(o.require, io), "--require") as Requirements,
        wanted: o.wanted, timeoutMs: o.timeout, targetWeaveId: weaveId, targetThreadId: o.thread,
        url: o.url ?? null, targetCredential: credential,
      });
      emit(c, r, `Opened request ${r.id} — wants ${r.wanted}, expires ${hhmm(r.expiresAt)}, eligible: ${r.eligible?.length ?? 0}\n  thread: ${r.threadId}`);
    });

  request.command("list")
    .description("Requests in the Lobby, newest first")
    // Passed through as typed: which words name a status, and which numbers make a page, are core's
    // rules. Only the shape is read here, so a typo is a usage error rather than a round trip.
    .option("--status <status>", "open | filled | expired | cancelled")
    .option("--limit <n>", "Max requests to return (default 100)", positiveInt)
    .action(async (o: { status?: string; limit?: number }) => {
      const c = ctx();
      const { client } = await lobbyContext(c);
      const requests = await client.listRequests(o.status as RequestStatus | undefined, { limit: o.limit });
      emit(c, requests, requests.map(requestLine).join("\n") || "(no requests)");
    });

  request.command("show <requestId>")
    .description("One request, its computed status and its offers")
    .action(async (requestId: string) => {
      const c = ctx();
      const { client } = await lobbyContext(c);
      const r = await client.getRequest(requestId);
      emit(c, r, requestBlock(r));
    });

  request.command("offer <requestId>")
    .description("Say you can take this request now")
    .option("--model <model>", "The model you would run it on")
    .option("--effort <effort>", "The effort you would run it at")
    .option("--note <text>", "A line for the requester")
    .action(async (requestId: string, o: { model?: string; effort?: string; note?: string }) => {
      const c = ctx();
      const { client } = await lobbyContext(c);
      const offered = await client.offer(requestId, o);
      const s = spec(offered.model, offered.effort);
      emit(c, offered, `Offered on ${offered.requestId}${s ? ` (${s})` : ""}`);
    });

  request.command("accept <requestId> <participantIds...>")
    .description("Accept offers; each accepted listener gets one invitation into the target Weave")
    .action(async (requestId: string, participantIds: string[]) => {
      const c = ctx();
      const { client } = await lobbyContext(c);
      const r = await client.acceptRequest(requestId, participantIds);
      emit(c, r, `Accepted ${participantIds.length} on ${requestId} [${r.request.status}]\n  invitations: ${r.invitationIds.join(", ")}`);
    });

  request.command("cancel <requestId>")
    .description("Give up on a request you opened")
    .action(async (requestId: string) => {
      const c = ctx();
      const { client } = await lobbyContext(c);
      const r = await client.cancelRequest(requestId);
      emit(c, r, `Cancelled request ${r.id} [${r.status}]`);
    });

  program.command("invite-weave <participantId>")
    .description("Hand a Lobby participant a single-use way into a Thread of the current Weave (keepers)")
    .requiredOption("--thread <id>", "Thread of the target Weave they are invited into")
    .addHelpText("after", "\nThe target Weave is the global --weave <id> (default: the last Weave created or joined).")
    .action(async (participantId: string, o: { thread: string }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const r = await c.client(entry.token).inviteToWeave(weaveId, participantId, o.thread);
      emit(c, r, `Invited ${participantId} into thread ${o.thread} of ${weaveId} (invitation ${r.invitationId}, seq ${r.seq})`);
    });
}
