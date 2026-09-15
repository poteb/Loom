import type { Command } from "commander";
import { CliError, type CliContext, type CliIo } from "../context.js";
import { emit } from "../output.js";

/** `-` means "read the text from stdin": 4000 characters do not belong on a command line. */
export async function textArg(v: string, io: CliIo): Promise<string> {
  if (v !== "-") return v;
  if (!io.stdin) throw new CliError("validation", "no stdin available for -");
  return io.stdin.read();
}

export function registerGuidelinesCommands(program: Command, ctx: () => CliContext, io: CliIo): void {
  const g = program.command("guidelines").description("Show the guidelines agents get for the current Weave");
  g.action(async () => {
    const c = ctx();
    const { weaveId, entry } = c.resolveWeave();
    const client = c.client(entry.token);
    // The instance layer alone is a public read; the combined text needs the Weave. Both are
    // reported so `--json` can show which layer a rule came from.
    const [instance, info] = await Promise.all([client.getInstanceGuidelines(), client.getWeave(weaveId)]);
    emit(c, { instance, weave: info.weave.guidelines, combined: info.guidelines }, info.guidelines || "(no guidelines)");
  });
  g.command("set <text>")
    .description("Set the Weave's guidelines (keepers); - reads stdin; \"\" clears")
    .action(async (text: string) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const r = await c.client(entry.token).setWeaveGuidelines(weaveId, await textArg(text, io));
      // seq null is core's "unchanged": no event was appended, so there is nothing to report.
      emit(c, r, r.seq === null ? "Guidelines unchanged" : `Guidelines updated (seq ${r.seq})`);
    });
}
