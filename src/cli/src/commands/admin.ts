import { InvalidArgumentError, type Command } from "commander";
import type { LoomClient, Settings } from "@loom/client";
import { CliError, type CliContext } from "../context.js";
import { emit } from "../output.js";

/** Canonical 8-4-4-4-12 hex uuid — mirrors `isUuid` in core, which the CLI does not depend on at runtime. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `revoke <idOrName>` when the argument is not a uuid. Only live agents are considered:
 * revoking one twice is an error anyway, and a long-dead name should not shadow the current holder.
 */
async function resolveAgentIdByName(k: LoomClient, name: string): Promise<string> {
  const matches = (await k.admin.listAgents()).filter((a) => a.revokedAt === null && a.name === name);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new CliError("validation", `no agent named "${name}" (or it is already revoked); see 'loom admin agents list'`);
  // InvalidArgumentError, not CliError: the argument itself cannot identify one agent, which is the
  // usage error commander turns into exit 2 (see cli.ts).
  throw new InvalidArgumentError(`several agents are named "${name}"; revoke one by id: ${matches.map((a) => a.id).join(", ")}`);
}

/** Left-aligns the values of a labelled block so the reader can tell the three opaque strings apart. */
function labelled(rows: [label: string, value: string][]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)} ${value}`);
}

const SETTING_PARSERS: Record<keyof Settings, (v: string) => unknown> = {
  instanceName: (v) => v,
  maxMessageLength: (v) => { const n = Number(v); if (!Number.isInteger(n)) throw new CliError("validation", "maxMessageLength must be an integer"); return n; },
  openWeaveCreation: (v) => { if (v !== "true" && v !== "false") throw new CliError("validation", "openWeaveCreation must be true or false"); return v === "true"; },
};

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
    .option("--set <pair...>", "key=value (instanceName, maxMessageLength, openWeaveCreation)")
    .action(async (o: { set?: string[] }) => {
      const c = ctx();
      const k = c.keeperClient();
      const settings = o.set && o.set.length > 0 ? await k.admin.updateSettings(parseSettingsPatch(o.set)) : await k.admin.getSettings();
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
    // Name first: it is what `revoke` now accepts, and the only part a human recognises.
    emit(c, { agents: list }, list.map((a) => `${a.name}  ${a.id}${a.revokedAt ? " [revoked]" : ""}`).join("\n") || "(no agents)");
  });
  agents.command("add <name>").action(async (name: string) => {
    const c = ctx();
    const r = await c.keeperClient().admin.addAgent(name);
    // The id and the key look alike, and the 2026-09-15 dogfood pasted the id into the connector
    // URL. Each line says what its value is for, and the URL is printed whole so it can be copied
    // without assembling it from the key.
    emit(c, r, [
      `Added agent "${r.agent.name}"`,
      ...labelled([
        ["connector URL (copy this into the MCP client):", `${c.baseUrl}/mcp?agent=${r.key}`],
        ["key (shown once, also inside the URL):", r.key],
        ["id (for 'loom admin agents revoke'):", r.agent.id],
      ]),
    ].join("\n"));
  });
  agents.command("revoke <idOrName>").action(async (idOrName: string) => {
    const c = ctx();
    const k = c.keeperClient();
    const id = UUID_RE.test(idOrName) ? idOrName : await resolveAgentIdByName(k, idOrName);
    await k.admin.revokeAgent(id);
    emit(c, { ok: true, id }, `Revoked agent ${id}`);
  });
}
