import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

export function registerThreadCommands(program: Command, ctx: () => CliContext): void {
  const thread = program.command("thread").description("Manage threads of the current Weave");

  thread.command("new <name>")
    .description("Create a thread")
    .action(async (name: string) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const t = await c.client(entry.token).createThread(weaveId, name);
      emit(c, t, `Created thread "${t.name}" (${t.id})`);
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
