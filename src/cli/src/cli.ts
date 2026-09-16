import { Command, CommanderError } from "commander";
import { buildContext, CliError, isClientError, type CliContext, type CliIo, type GlobalOpts } from "./context.js";
import { registerWeaveCommands } from "./commands/weave.js";
import { registerMessageCommands } from "./commands/messages.js";
import { registerThreadCommands } from "./commands/thread.js";
import { registerAdminCommands } from "./commands/admin.js";
import { registerInviteCommands } from "./commands/invite.js";
import { registerGuidelinesCommands } from "./commands/guidelines.js";
import { registerLobbyCommands } from "./commands/lobby.js";
import { registerRequestCommands } from "./commands/request.js";

export type { CliIo } from "./context.js";

/**
 * Takes the base-URL option out of argv, reading it only from the options that precede the command
 * name. Commander recognises an option declared on the program *wherever* it appears — including
 * after a subcommand — so leaving `--url` declared there would make `loom thread new "PR 1" --url
 * <artefact>` set the server address instead of the thread's artefact link. Handling it here keeps
 * `loom --url <base> ...` working and leaves every `--url` after the command name to the subcommand.
 * A `--url` with no value is left in place so commander reports it as the usage error it is.
 */
function takeBaseUrl(argv: string[], commandNames: Set<string>): { argv: string[]; url?: string } {
  const cut = argv.findIndex((a) => commandNames.has(a));
  const head = cut === -1 ? argv : argv.slice(0, cut);
  const tail = cut === -1 ? [] : argv.slice(cut);
  const kept: string[] = [];
  let url: string | undefined;
  for (let i = 0; i < head.length; i++) {
    const a = head[i] as string;
    if (a === "--url") {
      const v = head[i + 1];
      if (v !== undefined && !v.startsWith("-")) { url = v; i++; continue; }
    } else if (a.startsWith("--url=")) {
      url = a.slice("--url=".length);
      continue;
    }
    kept.push(a);
  }
  return { argv: [...kept, ...tail], url };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  // Scanned before parsing: commander can throw a CommanderError (a missing required option, a bad
  // argParser value, an unknown option) before --json would ever be readable from program.opts(), so
  // whether to emit the JSON error shape has to be known up front.
  const jsonMode = argv.includes("--json");
  // Commander writes its own human-readable diagnostic straight to writeErr as it throws; in --json
  // mode that diagnostic is buffered here instead of reaching stderr, so the caller sees exactly one
  // JSON object on stderr rather than that diagnostic plus a JSON object appended after it.
  let errBuf = "";
  // Whether commander has rendered a diagnostic of its own. A CommanderError thrown from inside an
  // action rather than by the parser is never rendered, and the catch below would otherwise exit
  // mute; this is the belt to that braces (actions throw CliError instead).
  let wroteErr = false;
  const program = new Command("loom");
  program
    .description("Loom command line: create and join Weaves, read and post messages")
    .option("--weave <id>", "Weave id (default: the last one created/joined)")
    .option("--json", "Print JSON")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => { wroteErr = true; if (jsonMode) errBuf += s; else io.stderr.write(s); },
    });

  program.addHelpText("after", "\nGlobal option --url <url> (Loom base URL, default: $LOOM_URL) must be given before the command.");

  let baseUrlOpt: string | undefined;
  let ctxCache: CliContext | undefined;
  const ctx = () => (ctxCache ??= buildContext({ ...program.opts<GlobalOpts>(), url: baseUrlOpt }, io));

  registerWeaveCommands(program, ctx, io);
  registerMessageCommands(program, ctx);
  registerThreadCommands(program, ctx);
  registerAdminCommands(program, ctx);
  registerInviteCommands(program, ctx);
  registerGuidelinesCommands(program, ctx, io);
  registerLobbyCommands(program, ctx, io);
  registerRequestCommands(program, ctx, io);

  const commandNames = new Set(program.commands.flatMap((c) => [c.name(), ...c.aliases()]));
  const stripped = takeBaseUrl(argv, commandNames);
  baseUrlOpt = stripped.url;

  try {
    await program.parseAsync(stripped.argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return 0;
      if (jsonMode) {
        const raw = (errBuf.length > 0 ? errBuf : e.message).trim();
        const message = (raw.split("\n")[0] ?? raw).trim();
        io.stderr.write(JSON.stringify({ code: "validation", message }) + "\n");
      } else if (!wroteErr) {
        io.stderr.write(`error: ${e.message} (validation)\n`);
      }
      return 2;
    }
    const json = program.opts<GlobalOpts>().json === true;
    const { code, message } = isClientError(e) || e instanceof CliError
      ? { code: e.code, message: e.message }
      : { code: "internal", message: e instanceof Error ? e.message : String(e) };
    io.stderr.write(json ? JSON.stringify({ code, message }) + "\n" : `error: ${message} (${code})\n`);
    return e instanceof CliError ? e.exitCode : 1;
  }
}
