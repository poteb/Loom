import type { Command } from "commander";
import type { LoomEvent, Thread, Participant } from "@loom/client";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

export function formatEvent(e: LoomEvent, threads: Thread[], participants: Participant[]): string {
  const thread = threads.find((t) => t.id === e.threadId)?.name ?? e.threadId;
  const who = e.actor.startsWith("keeper:") ? "Keeper" : (participants.find((p) => p.id === e.actor)?.name ?? e.actor);
  if (e.type === "message") return `#${e.seq} [${thread}] ${who}: ${String(e.payload.text ?? "")}`;
  return `#${e.seq} [${thread}] * ${e.type}`;
}

export function registerMessageCommands(program: Command, ctx: () => CliContext): void {
  program.command("post <text...>")
    .description("Post a message (default: the General thread of the current Weave)")
    .option("--thread <id>", "Thread id")
    .action(async (words: string[], o: { thread?: string }) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const ev = await c.client(entry.token).postMessage(o.thread ?? entry.generalThreadId, words.join(" "));
      emit(c, ev, `#${ev.seq} posted`);
    });

  program.command("read")
    .description("Read events of the current Weave")
    .option("--since <seq>", "Only events after this seq", (v) => Number(v))
    .option("--thread <id>", "Only this thread")
    .option("--limit <n>", "Max events", (v) => Number(v))
    .action(async (o: { since?: number; thread?: string; limit?: number }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const client = c.client(entry.token);
      const [info, events] = await Promise.all([
        client.getWeave(weaveId),
        client.readEvents(weaveId, { since: o.since, threadId: o.thread, limit: o.limit }),
      ]);
      emit(c, { events }, events.map((e) => formatEvent(e, info.threads, info.participants)).join("\n"));
    });
}
