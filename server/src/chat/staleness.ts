/**
 * IS THIS CHAT RUNNING YESTERDAY'S MUXPAD? — and is it safe to fix?
 *
 * ─── THE MEASUREMENT THAT PRODUCED THIS ─────────────────────────────────────
 * A chat is FROZEN AT BIRTH. Its instructions are baked into the system prompt
 * the SDK recorded when the session was created, its tools are fixed when the
 * query is constructed, and a resume deliberately keeps its own model
 * (`startModel = requestedModel ?? (resumeSid ? null : DEFAULT_AGENT_MODEL)`).
 * None of that moves while the session lives, and a RESPAWN does not move it
 * either — the SDK replays the recorded prompt.
 *
 * Audited on this install on 23 November: 16 of 22 live chats were running
 * 30–83 of 86 instruction lines behind, and 6 were on a model that had stopped
 * being the default — one of them two majors back. The owner's words: "I can't
 * manage this crap. I just want all the shit to work by itself reliably."
 *
 * ─── WHY A TIMESTAMP AND NOT A HASH ─────────────────────────────────────────
 * The exact question — "is the text this session is running the text on disk
 * now" — wants a hash of what was injected, and a runner could report one.
 * But only a runner started AFTER that change could report it, so every chat
 * already running would answer "unknown" for days, which is the population the
 * signal exists for.
 *
 * A session created before the instructions were last written is running older
 * text BY CONSTRUCTION. That is cheap (two numbers), exact in the direction
 * that matters (it never claims fresh when stale), and it works on every chat
 * on disk today. It cannot say HOW far behind — the row does not need to.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * Decide anything. This module reports; the acting is the caller's, and the
 * owner asked for an indicator and a button he presses — "i want to gain
 * confidence in that first" — rather than muxpad rebasing chats behind his
 * back. {@link rebaseSafety} exists so that button can say what it will cost
 * before he presses it, because a rebase measurably kills background jobs and
 * wakeups.
 */

/** Everything the staleness answer is computed from. Passed in rather than
 *  read here, so the rule is testable without a database, a filesystem or a
 *  live runner. */
export interface StalenessFacts {
  /** `agent_sessions.created_at` — when THIS session began. Null when the pane
   *  has no session yet, which is not staleness, it is absence. */
  sessionStartedAt: number | null;
  /** The newest mtime among the generated prompt files (agent-instructions.md,
   *  chat-mode.md). Null when they cannot be read — see the note on `unknown`. */
  instructionsWrittenAt: number | null;
  /** What the runner says it is running, or null when it has not said. */
  model: string | null;
  /** What a NEW chat would get right now. */
  defaultModel: string | null;
  /** Did the user pin a model with `--model`? A pin is a decision, and a
   *  decision is never stale — this is the one input that silences the model
   *  reason entirely. */
  modelPinned: boolean;
  /** The build the runner reported, and the one the server is on. */
  reportedBuild: string | undefined;
  currentBuild: string;
}

export type StaleReason = 'instructions' | 'model' | 'build';

export interface Staleness {
  stale: boolean;
  reasons: StaleReason[];
  /**
   * The row's one-liner. Written here rather than in the component because the
   * CLI (`muxpad agent list`) and the sidebar must not describe the same chat
   * two different ways — the whole reason this lives in `shared`-shaped code
   * on the server rather than in a renderer.
   */
  summary: string | null;
}

const MODEL_WORDS: Record<string, string> = {
  instructions: 'older instructions',
  model: 'an older model',
  build: 'an older build',
};

export function staleness(f: StalenessFacts): Staleness {
  const reasons: StaleReason[] = [];
  // INSTRUCTIONS. Strictly older: a session created in the same millisecond as
  // the write is not evidence of anything, and the direction to be wrong in is
  // "says fresh" — a false stale mark trains you to ignore the mark.
  if (
    f.sessionStartedAt !== null &&
    f.instructionsWrittenAt !== null &&
    f.sessionStartedAt < f.instructionsWrittenAt
  )
    reasons.push('instructions');
  // MODEL. Only when the runner has actually said what it is running: silence
  // is not evidence, and a chat that has never reported would otherwise wear a
  // mark for the whole of its first turn.
  if (!f.modelPinned && f.model !== null && f.defaultModel !== null && f.model !== f.defaultModel)
    reasons.push('model');
  // BUILD. The one notion that already existed (runner-build.ts) and that
  // nothing ever surfaced.
  if (f.reportedBuild !== undefined && f.reportedBuild !== f.currentBuild) reasons.push('build');
  return {
    stale: reasons.length > 0,
    reasons,
    summary: reasons.length
      ? `Running ${reasons.map((r) => MODEL_WORDS[r]).join(' and ')} — rebase to refresh`
      : null,
  };
}

/** What a rebase would cost this chat RIGHT NOW. */
export interface RebaseFacts {
  /** A turn is in flight. */
  turnActive: boolean;
  /** Live background subagents. These DIE in a rebase — measured, not assumed:
   *  a probe lost a background job and a wakeup. */
  backgroundLive: number;
  /** Messages waiting in the durable queue. */
  queued: number;
  /** The chat has put a question to the user and is holding for the answer. */
  blocked: boolean;
  /** An open durable task (chat/TaskStore.ts). Work the chat itself says is
   *  unfinished. */
  openTask: boolean;
}

export type RebaseVerdict =
  /** Nothing live to lose. */
  | { safe: true }
  /** It would cost something, named. */
  | { safe: false; cost: string };

/**
 * Is this a moment when a rebase destroys nothing?
 *
 * The honest list, in the order a person would care about it. This is the
 * function an automatic rebase would one day gate on — and the reason the
 * button is manual for now is that nobody has watched it be right yet.
 */
export function rebaseSafety(f: RebaseFacts): RebaseVerdict {
  if (f.turnActive) return { safe: false, cost: 'a turn is running' };
  if (f.backgroundLive > 0)
    return {
      safe: false,
      cost: `${f.backgroundLive} background job${f.backgroundLive === 1 ? '' : 's'} would be killed`,
    };
  if (f.blocked) return { safe: false, cost: 'it is waiting on your answer' };
  if (f.queued > 0)
    return {
      safe: false,
      cost: `${f.queued} queued message${f.queued === 1 ? '' : 's'} would be dropped`,
    };
  if (f.openTask) return { safe: false, cost: 'it has an open task' };
  return { safe: true };
}
