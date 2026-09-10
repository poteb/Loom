import { serve } from "@hono/node-server";
import { createCore, createDb, runMigrations } from "@loom/core";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { TicketStore } from "./tickets.js";
import { attachWebSocket } from "./ws.js";

async function main() {
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  await runMigrations(db);
  const core = createCore(db);
  await core.seedKeepers(config.keeperTokens);
  const tickets = new TicketStore();
  const app = buildApp({ core, tickets });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(`loom server listening on http://0.0.0.0:${info.port} (keepers seeded: ${config.keeperTokens.length})`);
  });
  attachWebSocket(server, { core, tickets });

  const shutdown = () => { console.log("shutting down"); tickets.stop(); server.close(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
