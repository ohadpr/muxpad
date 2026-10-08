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
  isAgentLaunchTool,
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
 * — as opposed to the messages MUXPAD injects, which are also user-role but
 * which nobody is sitting there waiting on.
 *
 * Each of those is split by the normalizer into an adjacent pair: a `notice`
 * carrying the marker, immediately followed by the bubble it delivered (see
 * `expandCronFire` and `expandSpawnDelivery`). That adjacency is the only signal
 * in the event stream, and it is the same division `isMachineMessage` draws off
 * the raw text server-side, so the two agree.
 *
 * THE SET IS THE THING THAT GETS FORGOTTEN — this read `variant === 'cron'` and
 * nothing else, so when the join landed, a batch of sub-chat reports counted as
 * a person starting a turn. In Chat mode that promotes the reply to a bubble
 * addressed to a reader who never asked anything.
 */
const MACHINE_TURN_VARIANTS = new Set(['cron', 'report']);

function isHumanTurnStart(events: readonly ChatEvent[], i: number): boolean {
  if (events[i]?.kind !== 'user') return false;
  const prev = events[i - 1];
  return !(prev?.kind === 'notice' && MACHINE_TURN_VARIANTS.has(prev.variant));
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
/**
 * A FOLDED cron's whole turn is plumbing, not just its prompt.
 *
 * `--fold` hides the instruction the schedule injected. It did not hide what
 * the agent then DID about it, so an hourly job still printed a tool row and a
 * one-word reply into the conversation every time it ran: six rows a day saying
 * "closed", in a chat whose actual content is one card. Reported as wanting
 * "all these instructions folded into a default collapsed list, just like chat
 * mode does for things the agent does which are not meant to communicate to us".
 *
 * That machinery already exists — `voice: 'private'` drops an assistant message
 * into the "N actions" run beside the tool calls — and chat mode already applies
 * it to any turn a human did not start. It simply never ran here, because an
 * agent-mode pane does not apply the chat voice at all. The author of a folded
 * cron has said this output is plumbing; that is a statement about the SCHEDULE,
 * not about the pane's mode, so it holds either way.
 *
 * The turn is the span from the fire to the next thing a person or another
 * schedule started — the same segmentation `applyChatVoice` uses, and the same
 * adjacency (`notice` then its bubble) that identifies a fire at all.
 */
/**
 * Is the fire announced by the `cron` notice at `i` a FOLDED one?
 *
 * Read off the bubble that follows, because that is where the fact now lives.
 * `expandCronFire` emits one of three shapes, and only the middle one is new:
 *
 *   unfolded          [notice, user]                  ← a visible prompt bubble
 *   folded + prompt   [notice, user {folded: true}]   ← the prompt, collapsed
 *   folded, no prompt [notice]                        ← nothing to collapse
 *
 * So the question is answered by ABSENCE: a fire is folded unless it is
 * followed by a bubble that is not marked folded.
 *
 * This asked the notice's own `body` instead, which was true when the chip
 * carried the prompt behind a caret. Making the chip a mark moved the prompt
 * into the following bubble and left the notice with no `body` at all — so the
 * test read false for every fire and the fold silently stopped running. What
 * that looked like: an hourly schedule printing the word "closed" into the
 * conversation six times a day, which is the exact output this exists to hide.
 */
export function cronFireIsFolded(events: readonly ChatEvent[], i: number): boolean {
  const next = events[i + 1];
  return !(next?.kind === 'user' && next.folded !== true);
}

export function foldCronTurns(events: readonly ChatEvent[]): ChatEvent[] {
  let inFold = false;
  let changed = false;
  const out = events.map((e, i) => {
    if (e.kind === 'notice') {
      inFold = e.variant === 'cron' && cronFireIsFolded(events, i);
      return e;
    }
    // Any other turn start ends the fold: a person typing, a different
    // schedule, a message delivered from another chat.
    if (e.kind === 'user') {
      const prev = events[i - 1];
      const belongsToFire = prev?.kind === 'notice' && prev.variant === 'cron';
      if (!belongsToFire) inFold = false;
      return e;
    }
    if (!inFold || e.kind !== 'assistant' || e.voice === 'reply') return e;
    // `reply` is exempt above: a cron that deliberately called the reply tool
    // was told to say something, and folding that would hide the one part the
    // author meant you to read.
    if (e.voice === 'private') return e;
    changed = true;
    return { ...e, voice: 'private' as const };
  });
  return changed ? out : (events as ChatEvent[]);
}

/**
 * Does this event belong INSIDE a collapsed "N actions" run, rather than
 * getting a row of its own?
 *
 * Lifted out of ChatPane's renderer so the fold rules all sit in one file: the
 * coalescer below has to ask exactly this question to know whether a stretch of
 * transcript is silent, and a second, slightly-different copy of it in a lib
 * would decide a chip was unnecessary over something the reader can plainly see.
 */
export function isAction(e: ChatEvent): boolean {
  // Agent launches break runs like prose does, so each renders as its own
  // launch bubble rather than being buried in "5 actions · Agent ×5".
  if (e.kind === 'tool_use' && isAgentLaunchTool(e.name)) return false;
  return (
    e.kind === 'tool_use' ||
    e.kind === 'tool_result' ||
    e.kind === 'thinking' ||
    // A folded cron's injected instruction. A real delivered message, but
    // nobody typed it and nobody rereads it, so it belongs in the run with the
    // work it caused rather than as a bubble of its own.
    (e.kind === 'user' && e.folded === true) ||
    isPrivateReasoning(e)
  );
}

/** Time-of-day in the VIEWER's zone. The cron's own zone is the scheduling
 *  truth; this answers "when did it land for me". Shared with NoticeCard so a
 *  coalesced chip and a lone one cannot format the same instant two ways. */
export function fireTime(ts: number | null): string {
  if (ts === null) return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * ONE CHIP PER QUIET STRETCH, NOT ONE PER FIRE.
 *
 * ── THE COMPLAINT, WHICH IS ABOUT A RATE ────────────────────────────────────
 * "An hourly refresh is going to cause 24 chips a day — that's crazy versus a
 * daily cron which produces a chip a day, which is reasonable."
 *
 * Both of those are the same code. `--fold` says the fire's PROMPT is plumbing
 * and the fold then demotes the whole turn, so a card-refresh cron already
 * costs no bubble and no tool row — but it still costs a chip and a collapsed
 * run, every single fire, because a `notice` is not an action and therefore
 * breaks the run either side of it. 24 fires is 48 rows, in a chat whose actual
 * content is one card that updates in place.
 *
 * ── WHY COALESCING AND NOT A "SILENT" FLAG ──────────────────────────────────
 * The obvious alternative is a per-cron switch that emits no chip at all. It is
 * worse on both counts: a schedule with no trace in the chat is unauditable
 * exactly when it breaks, and it asks the author to re-declare something they
 * already said — `--fold` IS the statement that this fire is plumbing. The
 * primitive is right; what was wrong is that plumbing cost a row per occurrence
 * instead of a row per stretch.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * Consecutive folded fires with nothing VISIBLE between them keep the first
 * chip and drop the rest; the survivor says how many and when the last one
 * landed. Dropping the notices also merges what used to be N separate action
 * runs into one, because the chips were the only thing separating them — so the
 * whole quiet stretch collapses to two rows however long it runs.
 *
 * What ends a stretch is precisely what a reader can SEE: a person typing, a
 * deliberate `reply`, a different schedule, a promoted fallback, any notice
 * that is not another folded fire of the same cron. So the fire that actually
 * says something keeps its own chip, directly above the message it explains,
 * which is the one case the chip was always for.
 *
 * Two fires are never merged across a NAME boundary — a chip that averaged two
 * schedules together would be answering a question nobody asked — and a fire
 * carrying its own `detail` (missed fires collapsed into it) is left alone,
 * since that detail is the unusual thing worth a row.
 */
export function coalesceCronFires(events: readonly ChatEvent[]): ChatEvent[] {
  /** The chip currently absorbing fires, if a quiet stretch is open. */
  let open: { at: number; name: string; fires: number; lastTs: number | null } | null = null;
  /** The actions seen since that chip — see the `foldsAsActionRun` check below. */
  let since: ChatEvent[] = [];
  const absorbed = new Set<number>();
  const counts = new Map<number, { fires: number; lastTs: number | null }>();

  for (let i = 0; i < events.length; i++) {
    const e = events[i] as ChatEvent;
    if (e.kind === 'notice' && e.variant === 'cron' && !e.detail && cronFireIsFolded(events, i)) {
      // Actions are plumbing only when they actually COLLAPSE. A run that does
      // not meet `foldsAsActionRun` is rendered inline, as visible rows — so
      // absorbing the chip above it would leave work on screen with nothing
      // saying a schedule caused it. Rare (a fire's own demoted prose folds a
      // run of one), but the predicate is cheap and the alternative is a rule
      // that is right by luck.
      const quiet = since.length === 0 || foldsAsActionRun(since);
      if (open && open.name === e.text && quiet) {
        absorbed.add(i);
        open.fires++;
        open.lastTs = e.ts;
        counts.set(open.at, { fires: open.fires, lastTs: open.lastTs });
      } else {
        open = { at: i, name: e.text, fires: 1, lastTs: e.ts };
      }
      since = [];
      continue;
    }
    // Anything the reader can see closes the stretch.
    if (isAction(e)) since.push(e);
    else {
      open = null;
      since = [];
    }
  }

  if (absorbed.size === 0) return events as ChatEvent[];
  // One pass, by ORIGINAL index — the counts are keyed on it, and a filter-then-map
  // would have to find each survivor's old position again.
  const out: ChatEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    if (absorbed.has(i)) continue;
    const e = events[i] as ChatEvent;
    const c = counts.get(i);
    if (!c || e.kind !== 'notice') {
      out.push(e);
      continue;
    }
    const last = fireTime(c.lastTs);
    out.push({ ...e, detail: last ? `${c.fires} fires · last ${last}` : `${c.fires} fires` });
  }
  return out;
}

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
