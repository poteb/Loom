import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { closeDb, createCore, createDb, runMigrations } from "@loom/core";
import { loadConfig, describeSeeding } from "./config.js";
import { buildApp } from "./app.js";
import { TicketStore } from "./tickets.js";
import { logError, redact } from "./log.js";
import { attachWebSocket } from "./ws.js";

async function main() {
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  await runMigrations(db);
  const core = createCore(db);
  // Say what the seed did, not what was configured: seeding is skipped whole on a non-empty table.
  const seeding = describeSeeding(await core.seedKeepers(config.keeperTokens), config.keeperTokens.length);
  console.log(redact(seeding.line));
  if (seeding.warning) console.warn(redact(seeding.warning));
  // The Lobby is created once, at the first boot that finds none; every later boot reports it.
  // Nobody created it, so nobody was ever handed its secret — hence the link, unredacted on
  // purpose, since an operator at this instance's own console is exactly who it is for. Only on the
  // boot that created it, though: a secret printed at every restart ends up in every log shipper
  // and every screen share, and from the second boot on it is a `loom lobby` away.
  const lobby = await core.ensureLobby();
  console.log(lobby.created
    ? `lobby: created  /w/${lobby.secret}`
    : "lobby: present (secret via `loom lobby` with LOOM_KEEPER_TOKEN)");
  const tickets = new TicketStore();
  const defaultWebDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const webDist = config.webDist ?? (existsSync(path.join(defaultWebDist, "index.html")) ? defaultWebDist : undefined);
  console.log(webDist ? `serving web UI from ${webDist}` : "web UI not built; /w/* disabled");
  const { app, stop: stopSweep } = buildApp({ core, tickets, webDist });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`loom server listening on http://${config.host}:${info.port}`);
  });
  attachWebSocket(server, { core, tickets });

  const shutdown = async () => {
    console.log("shutting down");
    tickets.stop();
    stopSweep();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => { logError("startup", e); process.exit(1); });
