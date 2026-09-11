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

  for (let s = 0; s < starts.length; s++) {
    const from = starts[s] as number;
    const to = s + 1 < starts.length ? (starts[s + 1] as number) : events.length;
    // The LAST segment is the live one. Leave it alone until the turn closes.
    if (to === events.length && opts.turnActive) continue;
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

  return out;
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
