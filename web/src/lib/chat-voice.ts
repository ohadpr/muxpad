// CHAT MODE'S VOICE, as a pure transform over the rendered event list.
//
// In Chat mode the agent's plain assistant text is an inner monologue the user
// never sees, and muxpad's `reply` tool is its only voice (see
// shared/chat-events.ts for the contract, and backends/claude.ts for the tool).
// The runner enforces that at the SOURCE — it registers the tool and decides,
// at the turn-result boundary, whether a human was left in silence. This
// enforces it at the SURFACE: which events the chat shows as messages and which
// it folds away.
//
// TWO RULES, AND ONE THING THAT IS NOT A RULE:
//
//   1. Demote. Plain assistant text becomes `voice: 'private'`, which the chat
//      renders inside the same collapsed "N actions" rows tool calls already
//      get. COLLAPSE, NEVER DROP. Hiding machinery with no audit trail is
//      exactly what made Instinct's security backlash unanswerable; the
//      transcript on disk and the FTS archive are untouched, every word is one
//      tap away, and a search can still jump into a folded run (ChatPane forces
//      a group open around a highlight).
//   2. Promote. If a turn a human was waiting on ends with NO reply call at
//      all, its final assistant text is promoted back to a real message. This
//      is the render half of the harness guard: the runner half owns the log
//      line and the push body, this half owns the bubble, and both ask the same
//      predicate (needsReplyFallback) of the same transcript so a reload can
//      never disagree with the notification that announced it.
//   3. NOT a rule: summarising. Nothing here rewrites, shortens or generates
//      text. Deliberation is hidden, not summarised — the only text a user sees
//      is text the agent chose to say (or, in the guard's case, text it
//      actually wrote).
//
// Pure and synchronous by design: it runs inside a render memo on every
// transcript change, and it is the one piece of this feature a test can drive
// without a live model.

import {
  type AgentMode,
  type ChatEvent,
  backendSupportsChatMode,
  needsReplyFallback,
} from '@muxpad/shared';

export interface ChatVoiceOpts {
  /** The PANE's mode. null = the server hasn't said yet → change nothing. */
  mode: AgentMode | null;
  /**
   * Is a turn in flight? The trailing run of a LIVE turn is deliberately left
   * alone: the agent may still call `reply`, and promoting its scratchpad
   * mid-turn would flash private reasoning into the conversation and then have
   * to take it back. While a turn runs the user sees the working indicator;
   * the guard applies the moment it ends.
   */
  turnActive: boolean;
  /**
   * The `user` event that started the last turn we saw FINISH.
   *
   * ── WHY "IS A TURN RUNNING" IS NOT "IS THE LAST SEGMENT LIVE" ───────────────
   * `turnActive` answers the first question, and this pass used to read it as
   * the answer to the second — the last segment is exempt whenever a turn is
   * running. Those two come apart at the start of EVERY turn, because the flag
   * arrives before the transcript does: `turn-start` is a socket frame, the
   * user's message is a line the harness appends to a file that is then tailed
   * and normalised. (A composer send flips it even earlier, optimistically.)
   * For that window the PREVIOUS, finished turn is "the last segment" and gets
   * handed an exemption it outgrew when it ended.
   *
   * It is not a subtle window. Measured on the real stack, one send: 123 rows
   * → 124 → 123, the last turn's already-dropped sign-off popping back as a
   * folded action row and the document growing 91 px under the reader's cursor
   * before collapsing again. On a turn that produced no reply it is the
   * promoted `fallback` bubble that blinks out and returns — a message
   * visibly un-saying itself every time you type.
   *
   * Comparing the last segment's own start event against the last one we saw
   * CLOSE settles it with no clock and no timer:
   *
   *   equal     → the running turn has not written anything yet; the last
   *               segment is the closed one, and it stays closed.
   *   different → the last segment really is the turn that is running.
   *
   * It reads the right answer for the awkward cases too. A mid-turn runner
   * reconnect re-broadcasts `turn-start` for a turn already in flight (see
   * ws.ts): that turn's user message landed long ago, but no `turn-done` ever
   * did, so it is NOT the last closed turn and stays protected. A client that
   * mounts into a running turn has seen nothing close — null, which compares
   * unequal to everything and therefore protects, which is the safe direction:
   * the cost of being wrong here is a delayed promotion, where the cost of
   * being wrong the other way is words appearing and disappearing.
   */
  closedTurnStartId: string | null;
  /**
   * Which harness is running. Chat mode is Claude-only (modeForBackend) and
   * every door enforces it, but a codex/cursor row can still read 'chat' for
   * the instant before its runner hellos and the server corrects it. Hiding
   * plain text there would blank a chat that has no other voice, so the
   * backend is checked as well as the mode.
   */
  assistant: string | null | undefined;
}

/** Is Chat mode's voice actually in force for this pane? */
export function chatVoiceActive(opts: ChatVoiceOpts): boolean {
  return opts.mode === 'chat' && backendSupportsChatMode(opts.assistant);
}

/**
 * A `user` event that a PERSON (or another agent's `muxpad agent send`) caused
 * — as opposed to a cron fire, which is also a user-role message but which
 * nobody is sitting there waiting on.
 *
 * A cron fire is split by the normalizer into an adjacent pair: a `notice` with
 * variant 'cron' immediately followed by its prompt bubble (see expandCronFire).
 * That adjacency is the only signal in the event stream, and it is the same one
 * ws.ts reads off the raw text, so the two agree.
 */
function isHumanTurnStart(events: readonly ChatEvent[], i: number): boolean {
  if (events[i]?.kind !== 'user') return false;
  const prev = events[i - 1];
  return !(prev?.kind === 'notice' && prev.variant === 'cron');
}

/**
 * The `user` event that starts the transcript's LAST segment — the one a
 * caller latches as `closedTurnStartId` whenever no turn is running.
 *
 * Exported because the segmentation rule has to be the same one `applyChatVoice`
 * uses below (a `user` event, every `user` event, nothing else); a component
 * re-deriving "the last turn" by any other reading would hand this file an
 * answer to a slightly different question. Backwards scan — the answer is
 * within a handful of events of the tail in every real transcript.
 */
export function lastTurnStartId(events: readonly ChatEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === 'user') return e.id;
  }
  return null;
}

/**
 * Apply Chat mode's voice to a transcript. Returns the input array unchanged
 * (same identity) when the voice is not in force, so Agent mode costs nothing
 * and its rendering is byte-for-byte what it was before this existed.
 */
export function applyChatVoice(events: readonly ChatEvent[], opts: ChatVoiceOpts): ChatEvent[] {
  if (!chatVoiceActive(opts)) return events as ChatEvent[];

  // Pass 1 — demote. A reply keeps its own voice; everything else the model
  // wrote as prose becomes private reasoning.
  const out: ChatEvent[] = events.map((e) =>
    e.kind === 'assistant' && e.voice !== 'reply' ? { ...e, voice: 'private' as const } : e,
  );

  // Pass 2 — promote, per turn. Turns are segmented by user messages: a
  // segment runs from one user message up to the next. Events BEFORE the first
  // user message belong to no human turn (a resumed session's replayed tail, a
  // cron that fired before you said anything) and are never promoted.
  const starts: number[] = [];
  for (let i = 0; i < events.length; i++) if (events[i]?.kind === 'user') starts.push(i);

  /**
   * Is the segment starting at `from` the turn that is running RIGHT NOW —
   * i.e. the one to leave alone? Only the last segment can be, and only when
   * it isn't the turn we already watched close. See `closedTurnStartId`.
   */
  const isLiveSegment = (from: number, to: number): boolean =>
    to === events.length &&
    opts.turnActive &&
    (events[from] as ChatEvent).id !== opts.closedTurnStartId;

  for (let s = 0; s < starts.length; s++) {
    const from = starts[s] as number;
    const to = s + 1 < starts.length ? (starts[s + 1] as number) : events.length;
    // The live segment may still call `reply`. Leave it alone until it closes.
    if (isLiveSegment(from, to)) continue;
    if (!isHumanTurnStart(events, from)) continue;

    let replies = 0;
    let lastProse = -1;
    // Did the user press Stop inside this turn? The harness writes
    // "[Request interrupted by user]" into the transcript and the normalizer
    // turns it into an `interrupted` notice — the only durable signal a
    // RELOADED client has. Without it this pass promoted the scratchpad of a
    // turn the user deliberately cut short, putting words on screen the agent
    // never chose to say while the runner (which knows) stayed silent.
    let interrupted = false;
    for (let i = from + 1; i < to; i++) {
      const e = out[i];
      if (e?.kind === 'notice' && e.variant === 'interrupted') interrupted = true;
      if (e?.kind !== 'assistant') continue;
      if (e.voice === 'reply') replies++;
      else lastProse = i;
    }
    if (!needsReplyFallback({ mode: 'chat', humanInitiated: true, replies, interrupted })) continue;
    // Nothing the agent actually wrote → nothing to promote. The harness logs
    // the miss; inventing a sentence here would be the one thing this whole
    // mechanism exists to avoid.
    if (lastProse < 0) continue;
    const e = out[lastProse] as Extract<ChatEvent, { kind: 'assistant' }>;
    out[lastProse] = { ...e, voice: 'fallback' };
  }

  // Pass 3 — drop the sign-off. A model that has already replied very often
  // adds one last line of prose restating what it just said: after a 188-char
  // reply, an 89-char "4 markdown files at the top level of ~; largest is
  // onboarding-goal-plan.md". It is written to an audience it knows cannot
  // read it, and it is documented as NOT promptable — an explicit rule against
  // it moved zero of seven live turns.
  //
  // Folding it was the containment, and the containment was the problem: a
  // crisp note sitting under a longer reply reads as "the good answer is the
  // hidden one", which is exactly how this was reported. Nothing is lost —
  // the transcript and the FTS archive are untouched, this only declines to
  // give it a row.
  //
  // Strictly bounded: only prose AFTER the turn's last reply, only with no
  // action between them, and never when the turn produced no reply at all
  // (that text is the fallback the guard just promoted, and dropping it would
  // reinstate the silence this whole mechanism exists to prevent).
  const drop = new Set<number>();
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s] as number;
    const to = s + 1 < starts.length ? (starts[s + 1] as number) : events.length;
    if (isLiveSegment(from, to)) continue;
    let lastReply = -1;
    for (let i = from + 1; i < to; i++) {
      const e = out[i];
      if (e?.kind === 'assistant' && e.voice === 'reply') lastReply = i;
    }
    if (lastReply < 0) continue;
    for (let i = lastReply + 1; i < to; i++) {
      const e = out[i] as ChatEvent;
      if (!e) continue;
      if (e.kind === 'assistant' && e.voice === 'private') drop.add(i);
      else break; // an action after the reply means work continued — keep it all
    }
  }
  return drop.size > 0 ? out.filter((_, i) => !drop.has(i)) : out;
}

/** Is this event one the chat shows as a MESSAGE, or private machinery that
 *  belongs in a folded action run? One predicate so the fold and the render
 *  can't disagree about a given row. */
export function isPrivateReasoning(e: ChatEvent): boolean {
  return e.kind === 'assistant' && e.voice === 'private';
}

/** Real transcripts are full of 2–3 action stretches between prose, and
 *  leaving those inline read as "folding doesn't work". A lone action stays
 *  inline. */
const MIN_GROUP = 2;

/**
 * Does this run of consecutive actions collapse behind an "N actions" header?
 *
 * Length is the ordinary rule — and Chat mode's demoted prose is the
 * exception that overrides it. A lone tool row rendered inline is a nicety; a
 * lone scratchpad block rendered inline is a broken promise. Chat mode tells
 * the model its plain text is "a private scratchpad the user never sees", and
 * a live Opus ends nearly every turn with exactly one trailing self-narration
 * ("Done — 848 words total, reported to the user…"). Measured: EVERY live
 * Chat-mode turn that spoke wrote one, and the length rule left it sitting
 * visible right under the reply.
 */
export function foldsAsActionRun(run: readonly ChatEvent[]): boolean {
  return run.length >= MIN_GROUP || run.some(isPrivateReasoning);
}

/**
 * Is this action run the one the reader opened?
 *
 * ── WHY MEMBERSHIP, NOT A CHOSEN END ─────────────────────────────────────────
 * Expansion used to be remembered by ONE event id, and which end of the run
 * supplied it depended on where the run sat: a still-growing TRAILING run was
 * keyed by its first event (its tail moves), a closed one by its last (an
 * older-history prepend can extend its head). Both halves of that are true,
 * and together they are a bug, because a run does not stay trailing. The
 * instant the turn's `reply` lands, the run the reader is looking at stops
 * being last and its key flips from first-event to last-event — a key nobody
 * ever wrote — so the chat quietly re-collapses a block the reader explicitly
 * opened, right as the answer they were waiting for arrives. Measured on the
 * real stack: a run expanded mid-turn went 292 px → 26 px the moment the reply
 * appeared, with no input from the reader.
 *
 * A run has no stable single identity, so it is not asked for one. The
 * expansion is remembered by the ids of the events that were IN the run when
 * it was opened, and a run counts as expanded if it still contains any of
 * them. Events are only ever appended to a run's tail or prepended to its
 * head, never removed from the middle, so growth at either end preserves the
 * answer — which is exactly the property neither end alone had.
 */
export function actionRunExpanded(
  run: readonly ChatEvent[],
  expanded: ReadonlySet<string>,
): boolean {
  return run.some((e) => expanded.has(e.id));
}

/** The expansion set after tapping this run's header. Collapsing forgets every
 *  id the run currently carries, so a run that grew while open leaves nothing
 *  behind to re-open it. */
export function toggleActionRun(
  run: readonly ChatEvent[],
  expanded: ReadonlySet<string>,
): Set<string> {
  const next = new Set(expanded);
  const open = actionRunExpanded(run, expanded);
  for (const e of run) {
    if (open) next.delete(e.id);
    else next.add(e.id);
  }
  return next;
}
