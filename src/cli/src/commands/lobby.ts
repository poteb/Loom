import { Option, type Command } from "commander";
import type { AgentFilter, Kind, Lobby, LoomClient, Participant, Profile } from "@loom/client";
import { CliError, textArg, type CliContext, type CliIo } from "../context.js";
import { emit } from "../output.js";

/**
 * The Lobby credential and where the Lobby is, in one place: every Lobby and request command needs
 * both. The Lobby is one Weave per instance, so its token is stored under its weave id like any
 * other join — and an agent key stands in for that stored token exactly as `resolveWeave` lets it.
 */
export async function lobbyContext(c: CliContext): Promise<{ lobby: Lobby; client: LoomClient }> {
  const lobby = await c.client().getLobby();
  const token = c.io.env.LOOM_AGENT_KEY ?? c.config.weaves[lobby.weaveId]?.token;
  if (!token) throw new CliError("no_lobby_token", `No Lobby identity: run "loom lobby join --name <name>" first`);
  return { lobby, client: c.client(token) };
}

/** JSON typed on the command line (or piped in with `-`). What a legal value contains is core's rule. */
export function jsonArg(raw: string, what: string): unknown {
  try { return JSON.parse(raw); } catch { throw new CliError("validation", `${what} must be JSON`, { exitCode: 2 }); }
}

/** The models / runtime / owner / serves of a profile on one line, for the participant list. */
export function profileSummary(p: Profile | null | undefined): string {
  if (!p) return "(no profile)";
  const parts: string[] = [];
  const models = Array.isArray(p.models) ? p.models : [];
  if (models.length > 0) parts.push(`models: ${models.map((m) => [m.model, m.effort].filter(Boolean).join("/")).join(", ")}`);
  if (typeof p.runtime === "string" && p.runtime) parts.push(`runtime: ${p.runtime}`);
  if (typeof p.owner === "string" && p.owner) parts.push(`owner: ${p.owner}`);
  if (p.serves !== undefined) parts.push(`serves: ${Array.isArray(p.serves) ? p.serves.join(", ") : String(p.serves)}`);
  // A profile whose only keys are ones this summary does not name is still a profile.
  return parts.join("; ") || "(profile set)";
}

const participantLine = (p: Participant): string => `  ${p.id}  ${p.name} (${p.kind}, ${p.role})  ${profileSummary(p.capabilities)}`;

export function registerLobbyCommands(program: Command, ctx: () => CliContext, io: CliIo): void {
  const lobby = program.command("lobby").description("The Lobby: who is standing in it, and your own profile there");

  lobby.action(async () => {
    const c = ctx();
    const { lobby: where, client } = await lobbyContext(c);
    const info = await client.getWeave(where.weaveId);
    emit(c, { lobby: where, participants: info.participants }, [
      `${where.title} (${where.weaveId})`,
      "Participants:",
      ...info.participants.map(participantLine),
    ].join("\n"));
  });

  const join = lobby.command("join")
    .description("Join the Lobby (no secret) and store the token")
    .addOption(new Option("--kind <kind>", "agent | human").choices(["agent", "human"]).default("agent"));
  // As with `loom join`, an agent key supplies the agent's own registered name.
  if (io.env.LOOM_AGENT_KEY) join.option("--name <name>", "Your participant name (default: your agent name)");
  else join.requiredOption("--name <name>", "Your participant name");
  join.action(async (o: { name?: string; kind: Kind }) => {
    const c = ctx();
    const j = await c.client(c.io.env.LOOM_AGENT_KEY).joinLobby({ name: o.name, kind: o.kind });
    await c.remember(j.weaveId, {
      title: j.weave.title, token: j.token, participantId: j.participant.id,
      generalThreadId: j.generalThreadId, participantName: j.participant.name,
    });
    emit(c, j, `Joined the Lobby as ${j.participant.name} (weave ${j.weaveId}). Token stored in ${c.store.path}`);
  });

  lobby.command("me")
    .description("Set or clear your Lobby profile")
    .option("--set <json>", "The profile, as JSON; - reads stdin")
    .option("--clear", "Drop the profile, so nothing matches you")
    .action(async (o: { set?: string; clear?: boolean }) => {
      const c = ctx();
      const given = (o.set !== undefined ? 1 : 0) + (o.clear ? 1 : 0);
      if (given !== 1) throw new CliError("validation", "lobby me takes exactly one of --set <json | -> and --clear", { exitCode: 2 });
      const profile = o.set === undefined ? null : jsonArg(await textArg(o.set, io), "--set") as Profile;
      const { client } = await lobbyContext(c);
      const p = await client.setCapabilities(profile);
      emit(c, p, p.capabilities ? "Profile updated" : "Profile cleared");
    });

  lobby.command("find <json-filter>")
    .description("The agents whose profile satisfies the filter (and who serve its owner)")
    .action(async (filter: string) => {
      const c = ctx();
      const { client } = await lobbyContext(c);
      const agents = await client.findAgents(jsonArg(filter, "the filter") as AgentFilter);
      emit(c, agents, agents.map((a) => `${a.participant.id}  ${a.participant.name}  ${profileSummary(a.capabilities)}`).join("\n") || "(no agents)");
    });
}
