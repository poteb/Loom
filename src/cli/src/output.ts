import type { CliContext } from "./context.js";

/** Prints JSON (one document) when --json, otherwise the human text. Always newline-terminated. */
export function emit(ctx: CliContext, json: unknown, human: string): void {
  ctx.io.stdout.write(ctx.opts.json ? JSON.stringify(json) + "\n" : human.replace(/\n?$/, "\n"));
}
