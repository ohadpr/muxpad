// WHEN TO SAY IT, which is a different question from what to say.
//
// speak-bridge.ts decides WHAT is worth saying. This decides WHEN it reaches
// the model — and the difference matters because an agent answers on its own
// schedule, which is reliably the moment the user has started a new sentence.
//
// THE FAILURE THIS PREVENTS. A commentary append is handed to the model and the
// model says it, promptly. An answer that lands mid-utterance therefore talks
// over the user, who is now competing with a machine for the floor while the
// machine reads out an answer to something they asked ninety seconds ago. That
// is worse than a two-second delay by a wide margin.
//
// THREE POLICIES, AND WHY THESE THREE. Gemini Live ships
// `INTERRUPT | WHEN_IDLE | SILENT`; Deepgram ships the same three as
// `interrupt | queue | default`. Two independent products converging on one
// taxonomy is the strongest signal available that the taxonomy is right, so it
// is copied rather than re-derived. Deepgram's refusal semantics come with it:
// when the floor is busy, REQUEUE — do not talk over, and do not drop.
//
// THE DEFAULT IS `when_idle`, and interrupting is a deliberate escalation
// reserved for things that are worthless late: the agent blocked on a question
// it needs a human to answer, and hard failures. McFarlane's 2002 study of
// interruption coordination found this negotiated style best overall on every
// measure except when timeliness dominates — which is exactly the carve-out.
//
// IDLE MEANS "THE USER IS NOT MID-SENTENCE", and nothing more. It deliberately
// does NOT wait for the model to stop speaking: an append is context, not
// speech, and the model owns its own turn-taking. Gating on the model's voice
// as well would stall every answer behind whatever filler it was saying.
//
// Pure except for the clock it is handed. No transport, no ids, no delegation
// knowledge — it queues opaque items and tells you which are ready.

import type { AppendIntent } from './protocol';

/**
 * When an append may reach the model.
 *
 *   interrupt  — now, regardless of who is talking. Worthless late.
 *   when_idle  — the default. Held until the user has stopped speaking.
 *   silent     — thinking appends: they are folded into the model's context
 *                without being spoken, so they cannot interrupt anyone and are
 *                never held. Holding them would be actively harmful — they are
 *                how the model knows what is going on, and late context is how
 *                it ends up answering from a stale picture.
 */
export type DeliveryPolicy = 'interrupt' | 'when_idle' | 'silent';

/** Quiet on the input transcript after which the floor is the model's. */
export const IDLE_QUIET_MS = 600;

/**
 * How often to re-test the floor while something is waiting.
 *
 * A held item cannot rely on another transcript delta arriving to wake it — the
 * common case is the user stopping mid-thought and saying nothing more, which
 * produces no event at all. Without a poll, an answer waits forever.
 */
export const FLOOR_POLL_MS = 200;

export interface Held<T> {
  item: T;
  intent: AppendIntent;
  policy: DeliveryPolicy;
  queuedAt: number;
  /** Is this the RESULT, or progress about it? Only a result is re-anchored
   *  when the conversation has moved on — see {@link conversationMovedOn}. */
  final?: boolean;
}

/**
 * A FIFO of appends waiting for the floor.
 *
 * Order is preserved across policies — an `interrupt` does not jump the queue,
 * it simply is not held in the first place, and the caller emits it directly.
 * Anything that reaches this queue is by definition waiting on the same
 * condition, so reordering it would only scramble the narration.
 */
export class DeliveryQueue<T> {
  private held: Array<Held<T>> = [];

  get size(): number {
    return this.held.length;
  }

  push(entry: Held<T>): void {
    this.held.push(entry);
  }

  /**
   * Take everything the floor is now free for, in order.
   *
   * Returns nothing at all while the user is still speaking — including for
   * items behind the head, because narration that arrives out of order is worse
   * than narration that arrives late.
   */
  release(now: number, lastInputDeltaAt: number, idleQuietMs: number): Array<Held<T>> {
    if (this.held.length === 0) return [];
    if (now - lastInputDeltaAt < idleQuietMs) return [];
    const out = this.held;
    this.held = [];
    return out;
  }

  clear(): void {
    this.held = [];
  }
}

/**
 * Has the conversation moved on since this task was asked for?
 *
 * THE TEST THAT STOPS A NON-SEQUITUR. A result that arrives while the user is
 * still sitting in the same beat of conversation can just be said. A result
 * that arrives after they have said something else, after the model has said
 * something else, or after we have already given a progress update, cannot —
 * it needs re-anchoring, or the model blurts an answer to a question nobody
 * remembers asking.
 *
 * PROTOCOL BOOKKEEPING DOES NOT COUNT. A `queued` frame, a `turn-start`, a
 * subagent roster update — none of those are things the CONVERSATION did, and
 * treating them as movement makes every single result re-anchored, which reads
 * as a model that has lost the thread.
 */
export function conversationMovedOn(opts: {
  dispatchedAt: number;
  intermediatesSent: number;
  lastInputDeltaAt: number;
  lastOutputAt: number;
}): boolean {
  if (opts.intermediatesSent > 0) return true;
  if (opts.lastInputDeltaAt > opts.dispatchedAt) return true;
  return Number.isFinite(opts.lastOutputAt) && opts.lastOutputAt > opts.dispatchedAt;
}

/**
 * The instruction handed to the model, silently, in front of a late result.
 *
 * Near-verbatim from Pipecat, which arrived at this wording after shipping the
 * bug it prevents: an agent announcing "by the way, your party size has been
 * noted" into the middle of an unrelated exchange. Telling the model to FINISH
 * what it is doing first is what turns a non-sequitur into a normal human
 * "…oh, and that thing you asked about — it's done".
 *
 * It is a THINKING append, never commentary: it is an instruction about how to
 * speak, and a model handed it as commentary will read the instruction out.
 */
export function reanchorInstruction(request: string): string {
  const asked = request.length > 160 ? `${request.slice(0, 157)}…` : request;
  return [
    'The conversation has moved on since the user asked for this.',
    'Finish responding to whatever the user is talking about now, then deliver',
    'the result below at the end of your response — do not cut them off with it.',
    `It answers their earlier request: "${asked}"`,
  ].join(' ');
}
