import { InvalidArgumentError, type Command } from "commander";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";
import { formatEvent } from "./messages.js";

export function registerInviteCommands(program: Command, ctx: () => CliContext): void {
  program.command("invite <threadId> <participantId>")
    .description("Invite a participant into a thread (thread creator or keeper)")
    .action(async (threadId: string, participantId: string) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const r = await c.client(entry.token).inviteParticipant(threadId, participantId);
      emit(c, r, r.created ? `Invited ${participantId} to thread ${threadId} (seq ${r.seq})` : `Already invited (seq ${r.seq})`);
    });

  program.command("remove <threadId> <participantId>")
    .description("Take a participant off a thread (thread creator or keeper); on a Lobby request's thread it also removes that acceptance")
    .addHelpText("after", "\nThe credential is the one stored for the current Weave (--weave <id>): for a Lobby request's thread pass the Lobby's weave id, or set LOOM_AGENT_KEY.")
    .action(async (threadId: string, participantId: string) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const r = await c.client(entry.token).removeParticipant(threadId, participantId);
      emit(c, r, r.created
        ? `Removed ${participantId} from thread ${threadId} (seq ${r.seq})${r.acceptanceRemoved ? "; its acceptance is removed" : ""}${r.targetRemoved ? "; removed from the work thread too" : ""}`
        : `Already removed (seq ${r.seq})`);
    });

  program.command("inbox")
    .description("What is addressed to you in the current Weave: invites, removals, mentions, and in the Lobby the request events and your own removal from the Listeners")
    // InvalidArgumentError (not a plain Error) is what commander turns into a usage error and exit 2,
    // matching `read --since` / `read --count`.
    .option("--since <seq>", "Only events after this seq (omit for the most recent)", (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be an integer >= 0"); return n; })
    .option("--limit <n>", "Max events (1-1000)", (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 1000) throw new InvalidArgumentError("must be an integer between 1 and 1000"); return n; })
    .action(async (o: { since?: number; limit?: number }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const client = c.client(entry.token);
      const events = await client.inbox(weaveId, { since: o.since, limit: o.limit });
      // Each item already carries its Thread's name and artefact URL. Actor names still need the
      // Weave, so that lookup is made only for the human rendering: --json no longer pays for a
      // round-trip whose result it never printed.
      const human = async () => {
        const info = await client.getWeave(weaveId);
        const name = (id: string) => info.participants.find((p) => p.id === id)?.name ?? id;
        const where = (e: { threadName: string; threadUrl: string | null }) => `[${e.threadName}]${e.threadUrl ? ` ${e.threadUrl}` : ""}`;
        // Everything that is neither an invite nor a message (a removal, the Lobby's events) is a
        // system line in `loom read`'s words, falling back to the type name there.
        const lines = events.map((e) => e.type === "thread.invited"
          ? `#${e.seq} ${where(e)} invited by ${name(e.actor)}`
          : e.type === "message"
            ? `#${e.seq} ${where(e)} ${name(e.actor)}: ${String(e.payload.text ?? "")}`
            : formatEvent(e, info.threads, info.participants));
        return lines.join("\n") || "(nothing addressed to you)";
      };
      emit(c, { events }, c.opts.json ? "" : await human());
    });
}
