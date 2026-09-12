import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

export function registerThreadCommands(program: Command, ctx: () => CliContext): void {
  const thread = program.command("thread").description("Manage threads of the current Weave");

  thread.command("new <name>")
    .description("Create a thread")
    .option("--url <url>", "Artefact the thread is about (e.g. a PR link)")
    .action(async (name: string, o: { url?: string }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const t = await c.client(entry.token).createThread(weaveId, name, o.url ?? null);
      emit(c, t, `Created thread "${t.name}" (${t.id})${t.url ? `\n  url: ${t.url}` : ""}`);
    });

  thread.command("url <threadId> <url>")
    .description("Set the thread's artefact URL, or clear it with -")
    .action(async (threadId: string, url: string) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const t = await c.client(entry.token).setThreadUrl(threadId, url === "-" ? null : url);
      emit(c, t, t.url ? `Thread "${t.name}" now links to ${t.url}` : `Thread "${t.name}" no longer links to an artefact`);
    });

  thread.command("close <threadId>")
    .description("Close a thread (keepers only)")
    .action(async (threadId: string) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      await c.client(entry.token).closeThread(threadId);
      emit(c, { ok: true, threadId }, `Closed thread ${threadId}`);
    });
}
