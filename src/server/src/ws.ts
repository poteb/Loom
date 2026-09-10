import type { ServerType } from "@hono/node-server";
import type { Core } from "@loom/core";
import type { TicketStore } from "./tickets.js";

export function attachWebSocket(_server: ServerType, _deps: { core: Core; tickets: TicketStore; beforeReplay?: () => Promise<void> }): void {}
