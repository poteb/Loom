import type { Command } from "commander";
import type { LoomClient, Settings } from "@loom/client";
import { CliError, textArg, type CliContext, type CliIo } from "../context.js";
import { emit } from "../output.js";

/** Canonical 8-4-4-4-12 hex uuid — mirrors `isUuid` in core, which the CLI does not depend on at runtime. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `revoke <idOrName>` and `set-owner <idOrName>` when the argument is not a uuid. Only
 * live agents are considered: revoking one twice is an error anyway, and a long-dead name should
 * not shadow the current holder. `verb` is what the ambiguity message tells the user to do by id.
 */
async function resolveAgentIdByName(k: LoomClient, name: string, verb = "revoke"): Promise<string> {
  const matches = (await k.admin.listAgents()).filter((a) => a.revokedAt === null && a.name === name);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new CliError("validation", `no agent named "${name}" (or it is already revoked); see 'loom admin agents list'`);
  // Exit 2, not 1: the argument itself cannot identify one agent, which is a usage error. It stays
  // a CliError so the CLI's own error path prints it in human mode as well: commander renders only
  // what it throws while parsing, so an InvalidArgumentError raised here would exit 2 in silence.
  throw new CliError("validation", `several agents are named "${name}"; ${verb} one by id: ${matches.map((a) => a.id).join(", ")}`, { exitCode: 2 });
}

/** Left-aligns the values of a labelled block so the reader can tell the three opaque strings apart. */
function labelled(rows: [label: string, value: string][]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)} ${value}`);
}

const SETTING_PARSERS: Record<keyof Settings, (v: string) => unknown> = {
  instanceName: (v) => v,
  guidelines: (v) => v,
  maxMessageLength: (v) => { const n = Number(v); if (!Number.isInteger(n)) throw new CliError("validation", "maxMessageLength must be an integer"); return n; },
  openWeaveCreation: (v) => { if (v !== "true" && v !== "false") throw new CliError("validation", "openWeaveCreation must be true or false"); return v === "true"; },
};

/**
 * Substitutes stdin for a `guidelines=-` value before the patch is parsed: the instance guidelines
 * are up to 4000 characters of Markdown, which nobody types as one shell argument. Only this key
 * takes `-`; every other setting is short, and `-` could be a legitimate value for them.
 */
async function readStdinValues(pairs: string[], io: CliIo): Promise<string[]> {
  return Promise.all(pairs.map(async (p) => (p === "guidelines=-" ? `guidelines=${await textArg("-", io)}` : p)));
}

export function parseSettingsPatch(pairs: string[]): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new CliError("validation", `--set expects key=value, got "${pair}"`);
    const key = pair.slice(0, i); const value = pair.slice(i + 1);
    const parse = (SETTING_PARSERS as Record<string, (v: string) => unknown>)[key];
    if (!parse) throw new CliError("validation", `Unknown setting "${key}" (known: ${Object.keys(SETTING_PARSERS).join(", ")})`);
    patch[key] = parse(value);
  }
  return patch as Partial<Settings>;
}

export function registerAdminCommands(program: Command, ctx: () => CliContext): void {
  const admin = program.command("admin").description("Instance keeper commands (need LOOM_KEEPER_TOKEN)");

  admin.command("weaves").description("List all Weaves").action(async () => {
    const c = ctx();
    const weaves = await c.keeperClient().admin.listWeaves();
    emit(c, { weaves }, weaves.map((w) => `${w.id}  ${w.title}${w.archivedAt ? " [archived]" : ""}`).join("\n") || "(no weaves)");
  });

  admin.command("settings")
    .description("Show or update settings")
    .option("--set <pair...>", "key=value (instanceName, maxMessageLength, openWeaveCreation, guidelines; guidelines=- reads stdin)")
    .action(async (o: { set?: string[] }) => {
      const c = ctx();
      const k = c.keeperClient();
      const settings = o.set && o.set.length > 0
        ? await k.admin.updateSettings(parseSettingsPatch(await readStdinValues(o.set, c.io)))
        : await k.admin.getSettings();
      emit(c, settings, Object.entries(settings).map(([key, v]) => `${key}: ${String(v)}`).join("\n"));
    });

  const keepers = admin.command("keepers").description("Manage instance keepers");
  keepers.command("list").action(async () => {
    const c = ctx();
    const list = await c.keeperClient().admin.listKeepers();
    emit(c, { keepers: list }, list.map((k) => `${k.id}  ${k.name}`).join("\n") || "(no keepers)");
  });
  keepers.command("add <name>").action(async (name: string) => {
    const c = ctx();
    const r = await c.keeperClient().admin.addKeeper(name);
    emit(c, r, `Added keeper "${r.keeper.name}" (${r.keeper.id})\n  token: ${r.token}`);
  });
  keepers.command("remove <id>").action(async (id: string) => {
    const c = ctx();
    await c.keeperClient().admin.removeKeeper(id);
    emit(c, { ok: true, id }, `Removed keeper ${id}`);
  });

  const agents = admin.command("agents").description("Manage agent keys (remote MCP identities)");
  agents.command("list").action(async () => {
    const c = ctx();
    const list = await c.keeperClient().admin.listAgents();
    // Name first: it is what `revoke` and `set-owner` accept, and the only part a human recognises.
    emit(c, { agents: list }, list.map((a) => `${a.name}  ${a.id}  owner:${a.owner ?? "-"}${a.revokedAt ? " [revoked]" : ""}`).join("\n") || "(no agents)");
  });
  agents.command("add <name>")
    .option("--owner <owner>", "The person whose tokens this agent spends; fixes the owner of its Lobby profile")
    .action(async (name: string, o: { owner?: string }) => {
      const c = ctx();
      const r = await c.keeperClient().admin.addAgent(name, o.owner);
      // The id and the key look alike, and the 2026-09-15 dogfood pasted the id into the connector
      // URL. Each line says what its value is for, and the URL is printed whole so it can be copied
      // without assembling it from the key.
      emit(c, r, [
        `Added agent "${r.agent.name}"`,
        ...labelled([
          ["connector URL (copy this into the MCP client):", `${c.baseUrl}/mcp?agent=${r.key}`],
          ["key (shown once, also inside the URL):", r.key],
          ["id (for 'loom admin agents revoke'):", r.agent.id],
          ["owner (fixes the Lobby profile's owner):", r.agent.owner ?? "-"],
        ]),
      ].join("\n"));
    });
  agents.command("set-owner <idOrName> <owner>")
    .description("Set the owner of an existing agent key; its next set_capabilities takes the owner from the key")
    .action(async (idOrName: string, owner: string) => {
      const c = ctx();
      const k = c.keeperClient();
      const id = UUID_RE.test(idOrName) ? idOrName : await resolveAgentIdByName(k, idOrName, "set the owner of");
      const agent = await k.admin.setAgentOwner(id, owner);
      emit(c, agent, `Agent "${agent.name}" (${agent.id}) now has owner ${agent.owner}`);
    });
  agents.command("revoke <idOrName>").action(async (idOrName: string) => {
    const c = ctx();
    const k = c.keeperClient();
    const id = UUID_RE.test(idOrName) ? idOrName : await resolveAgentIdByName(k, idOrName);
    await k.admin.revokeAgent(id);
    emit(c, { ok: true, id }, `Revoked agent ${id}`);
  });
}
