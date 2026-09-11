import { Command, CommanderError } from "commander";
import { buildContext, CliError, isClientError, type CliContext, type CliIo, type GlobalOpts } from "./context.js";
import { registerWeaveCommands } from "./commands/weave.js";
import { registerMessageCommands } from "./commands/messages.js";

export type { CliIo } from "./context.js";

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const program = new Command("loom");
  program
    .description("Loom command line: create and join Weaves, read and post messages")
    .option("--url <url>", "Loom base URL (default: $LOOM_URL)")
    .option("--weave <id>", "Weave id (default: the last one created/joined)")
    .option("--json", "Print JSON")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) });

  let ctxCache: CliContext | undefined;
  const ctx = () => (ctxCache ??= buildContext(program.opts<GlobalOpts>(), io));

  registerWeaveCommands(program, ctx);
  registerMessageCommands(program, ctx);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return 0;
      return 2;
    }
    const json = program.opts<GlobalOpts>().json === true;
    const { code, message } = isClientError(e) || e instanceof CliError
      ? { code: e.code, message: e.message }
      : { code: "internal", message: e instanceof Error ? e.message : String(e) };
    io.stderr.write(json ? JSON.stringify({ code, message }) + "\n" : `error: ${message} (${code})\n`);
    return 1;
  }
}
