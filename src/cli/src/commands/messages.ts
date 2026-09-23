import { InvalidArgumentError, type Command } from "commander";
import type { LoomEvent, StreamHandle, Thread, Participant } from "@loom/client";
import { CliError, type CliContext } from "../context.js";
import { emit } from "../output.js";
import { hhmm } from "./request.js";

/** A non-empty string out of a payload field, else "". */
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function formatEvent(e: LoomEvent, threads: Thread[], participants: Participant[]): string {
  const thread = threads.find((t) => t.id === e.threadId)?.name ?? e.threadId;
  const who = e.actor.startsWith("keeper:") ? "Keeper" : (participants.find((p) => p.id === e.actor)?.name ?? e.actor);
  const name = (id: unknown) => participants.find((p) => p.id === id)?.name ?? str(id);
  const names = (v: unknown) => (Array.isArray(v) ? v.map(name).join(", ") : "");
  if (e.type === "message") return `#${e.seq} [${thread}] ${who}: ${String(e.payload.text ?? "")}`;
  // --- Lobby. One system line each; a request's title is its Thread's name, which core gives it.
  const head = `#${e.seq} [${thread}] *`;
  if (e.type === "request.opened") {
    const eligible = Array.isArray(e.payload.eligible) ? e.payload.eligible.length : 0;
    // "?" rather than a default: a payload without `wanted` is one this CLI does not understand,
    // and inventing "wants 1" would read as the request having asked for exactly one helper.
    const wanted = typeof e.payload.wanted === "number" ? e.payload.wanted : "?";
    return `${head} request opened: ${thread} (wants ${wanted}, expires ${hhmm(e.payload.expiresAt)}) — eligible: ${eligible}`;
  }
  if (e.type === "request.offered") {
    const s = [str(e.payload.model), str(e.payload.effort)].filter((v) => v).join("/");
    const note = str(e.payload.note);
    return `${head} request offered by ${name(e.payload.participantId)}${s ? ` (${s})` : ""}${note ? `: "${note}"` : ""}`;
  }
  if (e.type === "request.accepted") {
    return `${head} request accepted: ${names(e.payload.participantIds) || "nobody"} → "${str(e.payload.targetWeaveTitle)}"`;
  }
  if (e.type === "request.closed") {
    const accepted = names(e.payload.accepted);
    return `${head} request closed (${str(e.payload.reason) || "closed"}): ${accepted ? `accepted ${accepted}` : "nobody accepted"}`;
  }
  if (e.type === "weave.invited") {
    return `${head} invited ${name(e.payload.participantId)} to "${str(e.payload.targetWeaveTitle)}" (invite ${str(e.payload.invitationId)})`;
  }
  if (e.type === "request.completed") return `${head} ${name(e.payload.participantId)} finished "${thread}"`;
  if (e.type === "request.overdue") {
    const seen = typeof e.payload.lastSeenAt === "string" ? hhmm(e.payload.lastSeenAt) : "never";
    return `${head} ${name(e.payload.participantId)} missed the deadline of "${thread}" (due ${hhmm(e.payload.dueAt)}, last seen ${seen})`;
  }
  if (e.type === "thread.removed") {
    const by = str(e.payload.removedBy).startsWith("keeper:") ? "Keeper" : name(e.payload.removedBy);
    return `${head} ${name(e.payload.participantId)} was removed from this Thread by ${by}`;
  }
  if (e.type === "participant.capabilities_changed") {
    return `${head} profile ${e.payload.capabilities ? "set" : "cleared"} by ${name(e.payload.participantId)}`;
  }
  if (e.type === "weave.guidelines_changed") {
    // The payload carries the new rules, so print them: a reader catching up must not have to run a
    // second command to learn what the Weave now expects. Indented four spaces to mark the text as
    // the event's body rather than more log lines (and, in Markdown, as a block).
    const text = String(e.payload.guidelines ?? "");
    if (text === "") return `#${e.seq} [${thread}] * guidelines cleared by ${who}`;
    return `#${e.seq} [${thread}] * guidelines changed by ${who}\n${text.split("\n").map((l) => "    " + l).join("\n")}`;
  }
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
      const { weaveId, entry } = c.resolveWeave();
      const client = c.client(entry.token);
      // An agent key is an identity, not a stored join, so it carries no General thread id: ask the
      // Weave which of its threads is the General one instead.
      const threadId = o.thread ?? (entry.generalThreadId || (await client.getWeave(weaveId)).threads.find((t) => t.isGeneral)?.id);
      if (!threadId) throw new CliError("thread_not_found", `Weave ${weaveId} has no General thread; pass --thread <id>`);
      const ev = await client.postMessage(threadId, words.join(" "));
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
        // Declared before settle() can be called (SIGINT can fire the instant the listener is
        // installed, before client.stream() returns) so settle() never touches it uninitialized.
        let handle: StreamHandle | undefined;
        // Centralizes settlement: every path that ends the follow loop (count reached, SIGINT,
        // a closed-with-error stream status, or a handler throwing) goes through here exactly
        // once, so the stream handle and SIGINT listener are always released together.
        const settle = (err?: unknown) => {
          if (stopped) return;
          stopped = true;
          handle?.close();
          process.off("SIGINT", onSigint);
          if (err !== undefined) reject(err); else resolve();
        };
        const onSigint = () => settle();
        // Installed before client.stream() so a SIGINT arriving during connection setup is never
        // dropped on the floor.
        process.once("SIGINT", onSigint);
        handle = client.stream(weaveId, {
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
        // A synchronous onEvent/onStatus callback (or the SIGINT listener) may have already
        // called settle() during client.stream(), before `handle` was assigned above.
        if (stopped) handle.close();
      });
    });
}
