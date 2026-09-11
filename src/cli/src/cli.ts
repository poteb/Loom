import { Command, CommanderError } from "commander";
import { buildContext, CliError, isClientError, type CliContext, type CliIo, type GlobalOpts } from "./context.js";
import { registerWeaveCommands } from "./commands/weave.js";
import { registerMessageCommands } from "./commands/messages.js";
import { registerThreadCommands } from "./commands/thread.js";
import { registerAdminCommands } from "./commands/admin.js";

export type { CliIo } from "./context.js";

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  // Scanned before parsing: commander can throw a CommanderError (a missing required option, a bad
  // argParser value, an unknown option) before --json would ever be readable from program.opts(), so
  // whether to emit the JSON error shape has to be known up front.
  const jsonMode = argv.includes("--json");
  // Commander writes its own human-readable diagnostic straight to writeErr as it throws; in --json
  // mode that diagnostic is buffered here instead of reaching stderr, so the caller sees exactly one
  // JSON object on stderr rather than that diagnostic plus a JSON object appended after it.
  let errBuf = "";
  const program = new Command("loom");
  program
    .description("Loom command line: create and join Weaves, read and post messages")
    .option("--url <url>", "Loom base URL (default: $LOOM_URL)")
    .option("--weave <id>", "Weave id (default: the last one created/joined)")
    .option("--json", "Print JSON")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => { if (jsonMode) errBuf += s; else io.stderr.write(s); },
    });

  let ctxCache: CliContext | undefined;
  const ctx = () => (ctxCache ??= buildContext(program.opts<GlobalOpts>(), io));

  registerWeaveCommands(program, ctx);
  registerMessageCommands(program, ctx);
  registerThreadCommands(program, ctx);
  registerAdminCommands(program, ctx);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return 0;
      if (jsonMode) {
        const raw = (errBuf.length > 0 ? errBuf : e.message).trim();
        const message = (raw.split("\n")[0] ?? raw).trim();
        io.stderr.write(JSON.stringify({ code: "validation", message }) + "\n");
      }
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
