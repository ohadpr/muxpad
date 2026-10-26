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
  parseSpawnDelivery,
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
/**
 * A CRON IS UNSOLICITED. A REPORT IS THE ANSWER TO SOMETHING YOU ASKED FOR.
 *
 * Both arrive as muxpad-injected user messages, which is why they were one
 * set — and treating them the same cost a user a day of work.
 *
 * Measured, in the "signal archive" chat: the user asked it to cross-check 20
 * transcripts with sub-agents. Three workers ran, reported at 04:37:14, and
 * the chat wrote a 1,998-character consolidated verdict at 04:38:45 — which
 * nobody ever saw. The turn was started by the DELIVERY, so it was not a
 * "human turn start", so the reply fallback below was skipped, so the verdict
 * stayed `private`: muted scratchpad treatment, folded inside an action run.
 * Reported as "a day ago it said it's going to check stuff with sub agents,
 * hasn't returned yet".
 *
 * A delivery exists ONLY because this conversation dispatched the work. Its
 * arrival is the continuation of a request a person made, and bringing the
 * result back to them is the entire point of the join. A cron is the opposite
 * — nobody asked, today — and that one stays excluded, which is what the
 * original note about "a bubble addressed to a reader who never asked
 * anything" was actually protecting.
 */
const MACHINE_TURN_VARIANTS = new Set(['cron']);

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
 * A CRON'S TURN IS MACHINERY UNLESS THE SCHEDULE SAYS OTHERWISE.
 *
 * ── THE RULE ALREADY EXISTED. IT WAS BEHIND A MODE CHECK ───────────────────
 * `applyChatVoice` demotes everything the model wrote as prose and promotes it
 * back only inside a segment a HUMAN started — `isHumanTurnStart` explicitly
 * excludes a `user` event preceded by a machine notice, which is exactly a
 * cron fire. So in Chat mode a schedule's prose has always been plumbing, with
 * no flag and no list of words.
 *
 * It never ran in an agent-mode pane, because `applyChatVoice` returns its
 * input untouched when the voice is not in force. That is the whole bug: the
 * default was wrong only in the half of the product that had no opinion, and
 * the Investing chat is an agent session.
 *
 * ── THE ESCAPE HATCH IS PER FIRE, NOT PER SCHEDULE ─────────────────────────
 * Chat mode's is the `reply` tool: an agent that means to address the person
 * calls it, and `voice: 'reply'` is exempt everywhere. Agent mode registers no
 * muxpad tools at all ("AGENT MODE IS RAW" — claude.ts), so it gets the same
 * distinction through the CLI: `muxpad say` prints a marker that the
 * normalizer lifts into a `reply`-voiced message. Nothing here special-cases
 * it; it was already exempt.
 *
 * ── TWO WRONG ANSWERS CAME FIRST, AND THEY WERE WRONG THE SAME WAY ─────────
 * `--fold` (then `--speak`) put the switch on the SCHEDULE, and a schedule
 * cannot answer the question. `net-watch` is "silent unless a trigger fires":
 * declared quiet it hides the one message that matters, declared speaking it
 * prints "net: no" every weekday. Only the fire knows.
 *
 * Worse was the attempt in between — a hardcoded list of acknowledgement words
 * ("ok", "done", "closed") matched against the reply text, so a chatty cron
 * saying nothing would fold itself. Overfitting a guess about English onto a
 * question the agent can simply answer outright, and wrong the first time a
 * job replies "no change since yesterday".
 *
 * The turn is the span from the fire to the next thing a person or another
 * schedule started — the same segmentation `applyChatVoice` uses, and the same
 * adjacency (`notice` then its bubble) that identifies a fire at all.
 */

export function foldCronTurns(events: readonly ChatEvent[]): ChatEvent[] {
  let quiet = false;
  let changed = false;
  const out = events.map((e, i) => {
    if (e.kind === 'notice') {
      // The flag rides on the notice — see NoticeEvent.speak. It used to be
      // read off the SHAPE of the next event, which stopped being able to tell
      // the two apart the moment every fire's prompt became folded.
      quiet = e.variant === 'cron';
      return e;
    }
    // Any other turn start ends it: a person typing, a different schedule, a
    // message delivered from another chat.
    if (e.kind === 'user') {
      const prev = events[i - 1];
      const belongsToFire = prev?.kind === 'notice' && prev.variant === 'cron';
      if (!belongsToFire) quiet = false;
      return e;
    }
    if (!quiet || e.kind !== 'assistant' || e.voice === 'reply') return e;
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
 * A FIRE WHOSE OUTPUT IS A CARD, AND WHICH SAID NOTHING, RENDERS NOTHING.
 *
 * ── THE PRIMITIVE THIS FIXES ────────────────────────────────────────────────
 * A cron already said where it RUNS. It could not say where its OUTPUT GOES, so
 * that fact was being expressed with a rendering flag — which is why the flag
 * kept needing re-explaining, and why a card refresher still cost a chip and a
 * fold per quiet stretch in a chat whose entire content is the card. The
 * author's actual knowledge is "this job's output is the `market` card";
 * `--card` lets them say it, and then the rule writes itself.
 *
 * ── WHY DROPPING IS NOT THE DISAPPEARANCE THIS CODEBASE AVOIDS ──────────────
 * "Collapse, never drop" has been the rule everywhere else, and it still is for
 * anything anybody SAID. What goes here is muxpad's own annotation (the chip is
 * synthesised from a marker, not a message), muxpad's own injected prompt, and
 * the tool calls of a turn that produced no words at all. The harness
 * transcript and the FTS archive are untouched — `muxpad agent transcript` and
 * `muxpad search` still find every one of them.
 *
 * And the liveness signal does not go away, it moves somewhere better: the
 * card's freshness rail fades across its cadence and turns amber when the
 * writer stops. "Did it run?" is answered on the thing you are looking at
 * rather than by a chip six screens up the log.
 *
 * ── THE SILENCE IS LOAD-BEARING, AND IT STOPPED BEING ───────────────────────
 * Only a turn that said NOTHING is dropped. That used to follow from prose
 * being visible: a fire that hit an error explained itself, the explanation
 * was an ordinary message, and the span was no longer silent.
 *
 * Then every cron turn's prose became machinery, and this comment quietly
 * became false. Measured after that change: a card fire whose script was
 * missing, which then said "the card script is missing — I could not update
 * it", rendered ZERO rows. The job failed, said so, and the chat showed
 * nothing. Found by an adversarial review of the change that caused it.
 *
 * So a FAILED tool result now breaks the span by itself, without needing
 * anybody to say anything about it. That is the right signal anyway: it is the
 * machine's own account of what happened rather than the model's, and a job
 * that fails silently is the one case where a disappearing row is a bug rather
 * than a tidy-up. A fire that wants to explain the failure in words uses
 * `muxpad say`, which also breaks it.
 */
/**
 * ONE FINISHED WORKER SHOULD NOT BE THREE ROWS.
 *
 * A sub-chat that ran and reported drew: a LAUNCH card, a COMPLETION card
 * carrying its report, and a "⇤ 1 sub-agent reported" chip for the delivery that
 * brought the same words into this chat. Reported as exactly that — "one sub
 * chat yielded three messages" — and the third is the one with nothing of its
 * own to say: the card above it already has the name, the state and the text.
 *
 * So the chip is dropped WHEN THE CARDS COVER IT, and kept when they do not.
 * That is not a formality: spawn cards are capped (MAX_SPAWN_CARDS), so a big
 * fan-out has children with no card at all, and for those this chip is the only
 * thing in the log saying their result arrived.
 *
 * It drops only the CHIP. The delivery's body is a folded run either way
 * (`expandSpawnDelivery`), so the full text stays one disclosure away even for
 * a child whose card was capped out.
 */
/**
 * Is this raw outgoing text a DELIVERY — muxpad handing a worker's result to
 * this chat — rather than something a person is sending?
 *
 * The QUEUE and the optimistic ECHO render a message before it is a transcript
 * event, and for a delivery they should render NOTHING. Not "nothing when the
 * cards cover it", which is what this asked first and what produced a chip
 * that appeared for a few seconds and then vanished: the card and the delivery
 * arrive on two different signals (a `tab.updated` and a turn start), so
 * whichever lands first decides, and the answer changes under the reader.
 *
 * Unconditional here is also correct on its own terms. The echo is transient
 * by construction — the transcript event replaces it seconds later — so the
 * question "is this worth a row?" belongs to the row that PERSISTS, and
 * `dropCardedDeliveries` still asks it there, where a capped fan-out keeps its
 * chip. A preview that is gone before it can be read is not a preview.
 */
export function isDeliveryText(text: string): boolean {
  return parseSpawnDelivery(text) !== null;
}

export function dropCardedDeliveries(
  events: readonly ChatEvent[],
  carded: ReadonlySet<string>,
): ChatEvent[] {
  if (carded.size === 0) return events as ChatEvent[];
  let changed = false;
  const out = events.filter((e) => {
    if (e.kind !== 'notice' || e.variant !== 'report') return true;
    const from = e.from ?? [];
    // No ids (an older transcript, before the delivery carried them) means we
    // cannot prove the cards cover it — keep the chip. A silent drop on a
    // guess is how a result goes missing from a log.
    if (from.length === 0) return true;
    if (!from.every((id) => carded.has(id))) return true;
    changed = true;
    return false;
  });
  return changed ? out : (events as ChatEvent[]);
}

export function dropSilentCardFires(events: readonly ChatEvent[]): ChatEvent[] {
  const drop = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as ChatEvent;
    if (e.kind !== 'notice' || e.variant !== 'cron' || !e.card) continue;
    // A fire that collapsed MISSED fires has something unusual to report and
    // keeps its row whatever its output target is.
    if (e.detail) continue;
    const span: number[] = [];
    let silent = true;
    for (let j = i + 1; j < events.length; j++) {
      const n = events[j] as ChatEvent;
      // The next fire, or a person typing, ends this turn. Neither counts
      // against it — somebody else's message is not this job's output.
      if (n.kind === 'notice' && n.variant === 'cron') break;
      if (n.kind === 'user' && n.folded !== true) break;
      // A failure is never silent, whatever the model did or did not say
      // about it — see the header.
      if (n.kind === 'tool_result' && n.ok === false) {
        silent = false;
        break;
      }
      if (!isAction(n)) {
        silent = false;
        break;
      }
      span.push(j);
    }
    if (!silent) continue;
    drop.add(i);
    for (const j of span) drop.add(j);
  }
  if (drop.size === 0) return events as ChatEvent[];
  return events.filter((_, i) => !drop.has(i));
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
  // ── PASS 1: find the fires, and decide for each whether its TURN was silent.
  // Deciding per TURN rather than as we walk is what keeps a fire that spoke
  // from being swallowed. Judged on the way past, the last fire of a run is
  // absorbed before anyone knows what it went on to say — and then its message
  // appears with no chip above it, which is the one case the chip exists for.
  const fires: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as ChatEvent;
    // EVERY cron notice is a candidate now, folded or not. `sep` and `mute`
    // below do the real work — they ask whether anything VISIBLE happened, and a
    // fire that produced nothing visible has nothing to anchor a chip to
    // whatever its flag says.
    if (e.kind === 'notice' && e.variant === 'cron' && !e.detail) {
      fires.push(i);
    }
  }
  if (fires.length === 0) return events as ChatEvent[];

  /**
   * Did the turn starting at fire `n` produce nothing a reader can see?
   *
   * Its span runs to the next fire, or to the end. "Nothing visible" means
   * every event in it is an action AND the run of them actually COLLAPSES — a
   * run that fails `foldsAsActionRun` is rendered inline as visible rows, so
   * absorbing the chip above it would leave work on screen with nothing saying
   * a schedule caused it.
   */
  /** The events between fire `n` and the next fire (or the end). */
  const between = (n: number): ChatEvent[] => {
    const from = fires[n] as number;
    const to = n + 1 < fires.length ? (fires[n + 1] as number) : events.length;
    return events.slice(from + 1, to) as ChatEvent[];
  };

  /**
   * TWO DIFFERENT QUESTIONS, and collapsing them into one got this wrong in
   * both directions — first a stretch that stopped a chip early, then one that
   * swallowed a person's message whole.
   *
   * `sep` asks whether anything VISIBLE lies between two fires. That is about
   * adjacency: a reader's message sitting between them means the later chip has
   * to stay where it is, or it ends up above text nobody has read yet.
   */
  const sep = (n: number): boolean => {
    const span = between(n);
    if (!span.every(isAction)) return false;
    // A run that fails `foldsAsActionRun` renders INLINE as visible rows, so
    // absorbing the chip above it would leave work on screen with nothing
    // saying a schedule caused it.
    return span.length === 0 || foldsAsActionRun(span);
  };

  /**
   * …and `mute` asks whether a fire's own turn said anything. Same span, one
   * difference: a real user message ENDS the turn without counting against it.
   * Somebody typing is not this schedule's output, and whatever follows belongs
   * to them.
   *
   * This is the half that keeps a fire that SPOKE from being swallowed. Judged
   * only on the way past, the last fire of a run is absorbed before anyone
   * knows what it goes on to say — and its message then appears with no chip
   * above it, which is the one case the chip exists for.
   */
  const mute = (n: number): boolean => {
    for (const e of between(n)) {
      if (e.kind === 'user' && e.folded !== true) return true;
      if (!isAction(e)) return false;
    }
    return true;
  };

  const absorbed = new Set<number>();
  const counts = new Map<number, { fires: number; names: string[]; lastTs: number | null }>();
  let n = 0;
  while (n < fires.length) {
    const head = fires[n] as number;
    const headEv = events[head] as Extract<ChatEvent, { kind: 'notice' }>;
    const group = { fires: 1, names: [headEv.text], lastTs: headEv.ts };
    let m = n;
    // `sep(m)`: nothing visible separates this fire from the next.
    // `mute(m + 1)`: the next one has no message of its own to be left chipless.
    while (m + 1 < fires.length && sep(m) && mute(m + 1)) {
      m++;
      const idx = fires[m] as number;
      const ev = events[idx] as Extract<ChatEvent, { kind: 'notice' }>;
      absorbed.add(idx);
      group.fires++;
      group.lastTs = ev.ts;
      if (!group.names.includes(ev.text)) group.names.push(ev.text);
    }
    if (group.fires > 1) counts.set(head, group);
    n = m + 1;
  }

  if (absorbed.size === 0) return events as ChatEvent[];
  // One pass, by ORIGINAL index — the counts are keyed on it, and a
  // filter-then-map would have to find each survivor's old position again.
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
    // Name the schedules while naming them still fits — two is a list, four is
    // a count. Past that the chip says how many there were and the run says
    // which.
    const text = c.names.length <= 2 ? c.names.join(' · ') : `${c.names.length} schedules`;
    const detail = last ? `${c.fires} fires · last ${last}` : `${c.fires} fires`;
    out.push({ ...e, text, detail });
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
  return run.length >= MIN_GROUP || run.some(isPrivateReasoning) || run.some(isCronPrompt);
}

/**
 * A cron's injected prompt — the second exception to the length rule, and for
 * the same reason as the first.
 *
 * A lone tool row inline is a nicety. A lone INJECTED PROMPT inline is six
 * lines of "Run: python3 … On error print+push 'NW close snapshot failed'"
 * printed into the conversation, which is the exact thing folding it was for.
 *
 * It takes a turn that produced nothing else to hit this: the fire, its prompt,
 * and then no tool calls at all. Observed on a fire that died at the weekly
 * limit — the run was one event long, so the length rule rendered it inline and
 * the prompt came back.
 */
function isCronPrompt(e: ChatEvent): boolean {
  return e.kind === 'user' && e.folded === true;
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
