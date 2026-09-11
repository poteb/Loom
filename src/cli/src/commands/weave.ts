import { Option, type Command } from "commander";
import type { Kind } from "@loom/client";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

const kindOption = () => new Option("--kind <kind>", "agent | human").choices(["agent", "human"]).default("agent");

export function registerWeaveCommands(program: Command, ctx: () => CliContext): void {
  program.command("create")
    .description("Create a Weave (you become its keeper) and store your token")
    .requiredOption("--title <title>", "Weave title")
    .option("--opener <text>", "Opening message", "")
    .requiredOption("--name <name>", "Your participant name")
    .addOption(kindOption())
    .action(async (o: { title: string; opener: string; name: string; kind: Kind }) => {
      const c = ctx();
      const r = await c.client().createWeave({ title: o.title, opener: o.opener, creator: { name: o.name, kind: o.kind } });
      c.remember(r.weave.id, {
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

  program.command("join <secret>")
    .description("Join a Weave with its secret and store your token")
    .requiredOption("--name <name>", "Your participant name")
    .addOption(kindOption())
    .action(async (secret: string, o: { name: string; kind: Kind }) => {
      const c = ctx();
      const j = await c.client().joinWeave(secret, { name: o.name, kind: o.kind });
      const info = await c.client(j.token).getWeave(j.weaveId);
      const general = info.threads.find((t) => t.isGeneral)!;
      c.remember(j.weaveId, {
        title: info.weave.title, secret, token: j.token, participantId: j.participant.id,
        generalThreadId: general.id, participantName: j.participant.name,
      });
      emit(c, j, `Joined "${info.weave.title}" as ${j.participant.name} (weave ${j.weaveId}). Token stored in ${c.store.path}`);
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

  program.command("role <participantId> <role>")
    .description("Set a participant's role: member | keeper (keepers only)")
    .action(async (participantId: string, role: string) => {
      const c = ctx();
      if (role !== "member" && role !== "keeper") throw new Error("role must be member or keeper");
      const { weaveId, entry } = c.resolveWeave();
      const p = await c.client(entry.token).setRole(weaveId, participantId, role);
      emit(c, p, `${p.name} is now ${p.role}`);
    });

  program.command("export")
    .description("Export the Weave transcript")
    .option("--format <fmt>", "md | json", "md")
    .action(async (o: { format: string }) => {
      const c = ctx();
      if (o.format !== "md" && o.format !== "json") throw new Error("--format must be md or json");
      const { weaveId, entry } = c.resolveWeave();
      const out = await c.client(entry.token).exportWeave(weaveId, o.format);
      c.io.stdout.write(out.endsWith("\n") ? out : out + "\n");
    });
}
