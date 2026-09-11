import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { closeDb, createCore, createDb, runMigrations } from "@loom/core";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { TicketStore } from "./tickets.js";
import { logError } from "./log.js";
import { attachWebSocket } from "./ws.js";

async function main() {
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  await runMigrations(db);
  const core = createCore(db);
  await core.seedKeepers(config.keeperTokens);
  const tickets = new TicketStore();
  const defaultWebDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const webDist = config.webDist ?? (existsSync(path.join(defaultWebDist, "index.html")) ? defaultWebDist : undefined);
  console.log(webDist ? `serving web UI from ${webDist}` : "web UI not built; /w/* disabled");
  const app = buildApp({ core, tickets, webDist });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`loom server listening on http://${config.host}:${info.port} (keepers seeded: ${config.keeperTokens.length})`);
  });
  attachWebSocket(server, { core, tickets });

  const shutdown = async () => {
    console.log("shutting down");
    tickets.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => { logError("startup", e); process.exit(1); });
