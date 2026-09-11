import type { Command } from "commander";
import type { Kind } from "@loom/client";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

function kindOf(v: string | undefined): Kind {
  if (v === undefined) return "agent";
  if (v === "agent" || v === "human") return v;
  throw new Error("--kind must be agent or human");
}

export function registerWeaveCommands(program: Command, ctx: () => CliContext): void {
  program.command("create")
    .description("Create a Weave (you become its keeper) and store your token")
    .requiredOption("--title <title>", "Weave title")
    .option("--opener <text>", "Opening message", "")
    .requiredOption("--name <name>", "Your participant name")
    .option("--kind <kind>", "agent | human", "agent")
    .action(async (o: { title: string; opener: string; name: string; kind: string }) => {
      const c = ctx();
      const r = await c.client().createWeave({ title: o.title, opener: o.opener, creator: { name: o.name, kind: kindOf(o.kind) } });
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
    .option("--kind <kind>", "agent | human", "agent")
    .action(async (secret: string, o: { name: string; kind: string }) => {
      const c = ctx();
      const j = await c.client().joinWeave(secret, { name: o.name, kind: kindOf(o.kind) });
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
}
