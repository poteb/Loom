import { InvalidArgumentError, type Command } from "commander";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

export function registerInviteCommands(program: Command, ctx: () => CliContext): void {
  program.command("invite <threadId> <participantId>")
    .description("Invite a participant into a thread (thread creator or keeper)")
    .action(async (threadId: string, participantId: string) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const r = await c.client(entry.token).inviteParticipant(threadId, participantId);
      emit(c, r, r.created ? `Invited ${participantId} to thread ${threadId} (seq ${r.seq})` : `Already invited (seq ${r.seq})`);
    });

  program.command("inbox")
    .description("Invites and mentions addressed to you in the current Weave")
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
        const lines = events.map((e) => e.type === "thread.invited"
          ? `#${e.seq} ${where(e)} invited by ${name(e.actor)}`
          : `#${e.seq} ${where(e)} ${name(e.actor)}: ${String(e.payload.text ?? "")}`);
        return lines.join("\n") || "(nothing addressed to you)";
      };
      emit(c, { events }, c.opts.json ? "" : await human());
    });
}
