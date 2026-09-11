import { InvalidArgumentError, type Command } from "commander";
import type { LoomEvent, Thread, Participant } from "@loom/client";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

export function formatEvent(e: LoomEvent, threads: Thread[], participants: Participant[]): string {
  const thread = threads.find((t) => t.id === e.threadId)?.name ?? e.threadId;
  const who = e.actor.startsWith("keeper:") ? "Keeper" : (participants.find((p) => p.id === e.actor)?.name ?? e.actor);
  if (e.type === "message") return `#${e.seq} [${thread}] ${who}: ${String(e.payload.text ?? "")}`;
  return `#${e.seq} [${thread}] * ${e.type}`;
}

/** A commander argParser: finite non-negative integer, throwing InvalidArgumentError (→ usage exit 2) otherwise. */
function nonNegativeInt(min: number) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
      throw new InvalidArgumentError(`must be an integer >= ${min}`);
    }
    return n;
  };
}

export function registerMessageCommands(program: Command, ctx: () => CliContext): void {
  program.command("post <text...>")
    .description("Post a message (default: the General thread of the current Weave)")
    .option("--thread <id>", "Thread id")
    .action(async (words: string[], o: { thread?: string }) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const ev = await c.client(entry.token).postMessage(o.thread ?? entry.generalThreadId, words.join(" "));
      emit(c, ev, `#${ev.seq} posted`);
    });

  program.command("read")
    .description("Read events of the current Weave; --follow streams new ones")
    .option("--since <seq>", "Only events after this seq", nonNegativeInt(0))
    .option("--thread <id>", "Only this thread")
    .option("--limit <n>", "Max events in the initial batch", nonNegativeInt(1))
    .option("--follow", "Keep streaming new events")
    .option("--count <n>", "With --follow: exit after n streamed events", nonNegativeInt(1))
    .action(async (o: { since?: number; thread?: string; limit?: number; follow?: boolean; count?: number }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const client = c.client(entry.token);
      let info = await client.getWeave(weaveId);
      const events = await client.readEvents(weaveId, { since: o.since, threadId: o.thread, limit: o.limit });
      if (!o.follow) {
        emit(c, { events }, events.map((e) => formatEvent(e, info.threads, info.participants)).join("\n"));
        return;
      }
      const json = c.opts.json === true;
      for (const e of events) c.io.stdout.write(json ? JSON.stringify(e) + "\n" : formatEvent(e, info.threads, info.participants) + "\n");
      const lastSeq = events.at(-1)?.seq ?? o.since ?? 0;
      let remaining = o.count ?? Infinity;
      await new Promise<void>((resolve, reject) => {
        let chain = Promise.resolve();
        let stopped = false;
        // Centralizes settlement: every path that ends the follow loop (count reached, SIGINT,
        // a closed-with-error stream status, or a handler throwing) goes through here exactly
        // once, so the stream handle and SIGINT listener are always released together.
        const settle = (err?: unknown) => {
          if (stopped) return;
          stopped = true;
          handle.close();
          process.off("SIGINT", onSigint);
          if (err !== undefined) reject(err); else resolve();
        };
        const onSigint = () => settle();
        const handle = client.stream(weaveId, {
          since: lastSeq,
          onEvent: (e) => {
            // Bail before even queueing when we already know we're done; this is best-effort,
            // since events that arrived while an earlier handler was still awaiting may already
            // be queued on the chain by the time `stopped` flips.
            if (stopped) return;
            chain = chain.then(async () => {
              // The authoritative check: a handler may run after settle() was called from an
              // earlier link in the chain, so never write or touch state once stopped.
              if (stopped) return;
              if (o.thread && e.threadId !== o.thread) return;
              if (e.type === "thread.created" || e.type === "participant.joined") info = await client.getWeave(weaveId);
              if (stopped) return;
              c.io.stdout.write(json ? JSON.stringify(e) + "\n" : formatEvent(e, info.threads, info.participants) + "\n");
              if (--remaining <= 0) settle();
            }).catch(settle);
          },
          onStatus: (st, d) => { if (st === "closed" && d?.error) settle(d.error); },
        });
        process.once("SIGINT", onSigint);
      });
    });
}
