import type { Profile } from "@loom/client";

/**
 * The ordering-and-ownership rule the Lobby's two side reads are under (spec §3.3, §5.1), on its
 * own so that `session.ts` gains wiring rather than policy.
 *
 * Both reads start from three call sites and can therefore be in flight at the same time **inside
 * one generation**, which the generation counter says nothing about: it answers "is this session
 * still the one that asked?", never "is this the newest answer?".
 */

/** What a read captured when it **started**: whose read it is, and which read it is. */
export type Stamp = { id: string; token: string; generation: number; n: number };
/** What the session is when an answer — or a rejection — asks to be acted on. */
export type Now = { generation: number; meId?: string; meToken?: string; applied: number };

/** The one ownership-and-ordering rule (spec §3.3): may this answer — or this rejection — be acted on? */
export function isCurrent(stamp: Stamp, now: Now): boolean {
  // Four questions, and each one has bitten this design: is this session still the one that asked
  // (generation); is this still the identity it was asked for (id, token); and is this the newest
  // answer (n)? A generation guard alone orders nothing within a generation.
  return stamp.generation === now.generation
    && stamp.id === now.meId && stamp.token === now.meToken
    && stamp.n > now.applied;
}

/**
 * The request numbers of one kind of side read: `next()` when a read starts, `markApplied()` when
 * its answer is acted on. **One watermark for answers and rejections alike**, because the two are
 * evidence about the same question and ordering them apart would let a stale failure overtake a
 * fresh success.
 */
export function createCounter(): { next(): number; applied(): number; markApplied(n: number): void } {
  let seq = 0;
  let applied = 0;
  return { next: () => ++seq, applied: () => applied, markApplied: (n) => { applied = n; } };
}

/**
 * The profile cache, **owned by an identity**: it is only ever applied to the participant and token
 * it was read for, and it retires with them (spec §3.3).
 */
export type OwnProfile = { participantId: string; token: string; profile: Profile | null };
