import { Argument, Option, type Command } from "commander";
import type { Kind } from "@loom/client";
import { CliError, textArg, type CliContext, type CliIo } from "../context.js";
import { emit } from "../output.js";
import { lobbyContext } from "./lobby.js";

const kindOption = () => new Option("--kind <kind>", "agent | human").choices(["agent", "human"]).default("agent");

export function registerWeaveCommands(program: Command, ctx: () => CliContext, io: CliIo): void {
  program.command("create")
    .description("Create a Weave (you become its keeper) and store your token")
    .requiredOption("--title <title>", "Weave title")
    .option("--opener <text>", "Opening message", "")
    .requiredOption("--name <name>", "Your participant name")
    .addOption(kindOption())
    .option("--guidelines <text>", "House rules for the Weave (Markdown, max 4000 chars; - reads stdin)")
    .action(async (o: { title: string; opener: string; name: string; kind: Kind; guidelines?: string }) => {
      const c = ctx();
      // A configured instance-keeper token lets creation succeed when the instance restricts it;
      // failing that, an agent key links the creating participant to that agent identity (as join
      // does). With neither, creation is anonymous exactly as before.
      const r = await c.client(c.io.env.LOOM_KEEPER_TOKEN ?? c.io.env.LOOM_AGENT_KEY).createWeave({ title: o.title, opener: o.opener, creator: { name: o.name, kind: o.kind }, guidelines: o.guidelines === undefined ? undefined : await textArg(o.guidelines, io) });
      await c.remember(r.weave.id, {
        title: r.weave.title, secret: r.secret, token: r.token, participantId: r.participant.id,
        generalThreadId: r.generalThread.id, participantName: r.participant.name,
      });
      emit(c, r, [
        `Created Weave "${r.weave.title}"`,
        `  weave:   ${r.weave.id}`,
        `  secret:  ${r.secret}`,
        `  url:     ${c.baseUrl}/w/${r.secret}`,
        `  general: ${r.generalThread.id}`,
        `Token stored in ${c.store.path}`,
      ].join("\n"));
    });

  const join = program.command("join [secret]")
    .description("Join a Weave with its secret, or redeem an invitation with --invite, and store your token")
    .option("--invite <id>", "Redeem an invitation with your stored Lobby token (no secret)")
    .addOption(kindOption());
  // With an agent key the server knows the name to use (the agent's own), and a redeemed invitation
  // carries the invitee's Lobby name; a plain secret join has nothing to fall back to. The check is
  // made in the action rather than with requiredOption because which of these it is depends on
  // --invite, which commander cannot see when the command is declared.
  join.option("--name <name>", io.env.LOOM_AGENT_KEY ? "Your participant name (default: your agent name)" : "Your participant name (required with a secret)");
  join
    .action(async (secret: string | undefined, o: { name?: string; kind: Kind; invite?: string }) => {
      // Each path checks what it was given before the context is built: a mistyped command line is
      // a usage error whether or not the environment names a server.
      if (o.invite !== undefined) {
        if (secret !== undefined) throw new CliError("validation", "join takes a secret or --invite, not both", { exitCode: 2 });
        const c = ctx();
        // The redeeming credential is the Lobby identity the invitation was addressed to; what
        // comes back is an ordinary join of the target Weave, stored like any other.
        const { client } = await lobbyContext(c);
        const r = await client.joinByInvite(o.invite, o.name);
        await c.remember(r.weaveId, {
          title: r.weave.title, token: r.token, participantId: r.participant.id,
          generalThreadId: r.generalThreadId, participantName: r.participant.name,
        });
        emit(c, r, `Joined "${r.weave.title}" as ${r.participant.name} (weave ${r.weaveId}). Token stored in ${c.store.path}`);
        return;
      }
      if (secret === undefined) throw new CliError("validation", "join needs a secret or --invite <id>", { exitCode: 2 });
      if (o.name === undefined && !io.env.LOOM_AGENT_KEY) throw new CliError("validation", "join needs --name <name>", { exitCode: 2 });
      const c = ctx();
      // An agent key presented on join links the new participant to that agent identity; the
      // per-Weave token the server returns is still what gets stored and used afterwards.
      const j = await c.client(c.io.env.LOOM_AGENT_KEY).joinWeave(secret, { name: o.name, kind: o.kind });
      // Persist before anything else can fail: the token is the only copy of this identity and
      // re-joining under the same name would be refused as name_taken.
      await c.remember(j.weaveId, {
        title: j.weave.title, secret, token: j.token, participantId: j.participant.id,
        generalThreadId: j.generalThreadId, participantName: j.participant.name,
      });
      emit(c, j, `Joined "${j.weave.title}" as ${j.participant.name} (weave ${j.weaveId}). Token stored in ${c.store.path}`);
    });

  program.command("info")
    .description("Show the Weave, its threads and participants")
    .action(async () => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const info = await c.client(entry.token).getWeave(weaveId);
      const lines = [
        `${info.weave.title} (${info.weave.id})${info.weave.archivedAt ? " [archived]" : ""}`,
        "Threads:",
        ...info.threads.map((t) => `  ${t.id}  ${t.name}${t.closedAt ? " [closed]" : ""}`),
        "Participants:",
        ...info.participants.map((p) => `  ${p.id}  ${p.name} (${p.kind}, ${p.role})`),
      ];
      emit(c, info, lines.join("\n"));
    });

  program.command("archive")
    .description("Archive the current Weave (keepers only)")
    .action(async () => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      await c.client(entry.token).archiveWeave(weaveId);
      emit(c, { ok: true, weaveId }, `Archived Weave ${weaveId}`);
    });

  program.command("role")
    .description("Set a participant's role: member | keeper (keepers only)")
    .argument("<participantId>")
    .addArgument(new Argument("<role>", "member | keeper").choices(["member", "keeper"]))
    .action(async (participantId: string, role: "member" | "keeper") => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const p = await c.client(entry.token).setRole(weaveId, participantId, role);
      emit(c, p, `${p.name} is now ${p.role}`);
    });

  program.command("export")
    .description("Export the Weave transcript")
    .addOption(new Option("--format <fmt>", "md | json").choices(["md", "json"]).default("md"))
    .action(async (o: { format: "md" | "json" }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      // --json always wins: it forces the json transcript format even when --format was also given
      // (e.g. "--json --format md"), and covers the common case of --json alone with no --format.
      const format = c.opts.json ? "json" : o.format;
      const out = await c.client(entry.token).exportWeave(weaveId, format);
      c.io.stdout.write(out.endsWith("\n") ? out : out + "\n");
    });
}
