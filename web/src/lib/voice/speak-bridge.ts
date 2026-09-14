// WHAT GETS SPOKEN, AND — MUCH MORE IMPORTANTLY — WHAT NEVER DOES.
//
// The agent side of voice mode is a stream of frames on the EXISTING chat
// socket. This module is the one place that decides which of them become
// speech. It is pure: frames in, append intents out, no transport, no ids, no
// clock. That is what lets the whole delegation loop be tested without a
// browser or a model.
//
// THE ALLOW-LIST, and why it is an allow-list:
//
//   speak / speak-delta   SPOKEN. These are the agent's `reply` calls, put on
//                         the wire by da6d476 the instant they exist. They are
//                         the agent's chosen voice and the ONLY thing that is
//                         a real answer.
//   question              SPOKEN. An `ask_user`, or a reversibility gate that
//                         stopped on `git push`. The agent is blocked and
//                         needs a human; a voice session that stays silent
//                         here has hung, from the user's point of view.
//   turn-done (failed)    SPOKEN. A failure the user is waiting on.
//   turn-start/subagent/  SILENT (thinking). Progress, not answers.
//   queued/notice
//   stream                NOTHING. NOT SILENT-BUT-FORWARDED — NOTHING. In Chat
//                         mode a `stream` frame is the model's PRIVATE
//                         scratchpad (voice: 'private', see lib/chat-voice.ts):
//                         deliberation the user is promised they will never be
//                         shown. Speaking it would break that promise out loud,
//                         and even routing it to `thinking` would leak it into
//                         the model's context where it can be paraphrased into
//                         speech later. Progress comes from thinking appends
//                         that this module SYNTHESISES instead.
//   everything else       NOTHING.
//
// DEDUPE BETWEEN speak AND speak-delta. Both carry the same reply under the
// same id: the deltas stream as the reply generates, and `speak` lands with
// the authoritative full text when the tool_use block closes. Speaking both
// would say every answer twice. Per id we track exactly how much raw text has
// already been emitted and, on `speak`, emit only the tail past the longest
// common prefix. That handles the normal case (exact prefix), the reordered
// case (`speak` first, deltas after — nothing left to say), and the drifted
// case (a delta lost in transit) without a rule the two ends have to agree on.

import type { AppendIntent } from './protocol';

/** Flush accumulating deltas at a sentence boundary, so the model is handed
 *  whole thoughts to paraphrase rather than half-words. */
const SENTENCE_END = /[.!?。！？]["')\]]?\s$|[.!?。！？]["')\]]?$|\n/;

/** …but never sit on more than this without flushing. A reply with no
 *  punctuation for two hundred characters is still something the user is
 *  waiting to hear; silence while it accumulates reads as a dead session. */
const MAX_PENDING_CHARS = 220;

/** The chat frames this module reacts to. Deliberately a narrow, explicit
 *  union rather than a re-export of ChatPane's ServerMsg: the whole point is
 *  that adding a frame to the chat protocol does NOT silently start speaking
 *  it. Parsed from unknown at the boundary (`parseChatFrame`). */
export type VoiceChatFrame =
  /**
   * `text` is the CORRELATION IDENTIFIER: the message that started this turn,
   * stamped by the server. Chat frames carry no task id — this stream is flat,
   * one per pane — so with two voice tasks overlapping, this field is the only
   * thing that says which one's answer is about to arrive. Optional because an
   * older server does not send it and a turn nobody sent (cron, wakeup) has no
   * message to name; both cases are handled in session.ts.
   */
  | { t: 'turn-start'; text?: string }
  | { t: 'speak'; id: string; text: string; n: number }
  | { t: 'speak-delta'; id: string; delta: string }
  | { t: 'turn-done'; ok: boolean; error?: string }
  | { t: 'question'; qid: string; questions: VoiceQuestion[] }
  | { t: 'question-done'; qid: string }
  | { t: 'queued'; id: string; text: string }
  | { t: 'subagent'; progress: { label?: string; lastTool?: string; done?: boolean } }
  | { t: 'error'; message: string }
  | { t: 'notice'; message: string }
  | { t: 'stream'; delta: string };

export interface VoiceQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

const FRAME_KINDS = new Set([
  'turn-start',
  'speak',
  'speak-delta',
  'turn-done',
  'question',
  'question-done',
  'queued',
  'subagent',
  'error',
  'notice',
  'stream',
]);

/** Narrow an arbitrary chat frame to one this module handles. Anything
 *  unrecognised — including future frames — returns null and is ignored. */
export function parseChatFrame(u: unknown): VoiceChatFrame | null {
  if (!u || typeof u !== 'object') return null;
  const t = (u as { t?: unknown }).t;
  if (typeof t !== 'string' || !FRAME_KINDS.has(t)) return null;
  return u as VoiceChatFrame;
}

/**
 * Turn an agent question into something worth hearing.
 *
 * Options are read out because a voice user cannot see the chips, and the
 * header is dropped — it is a two-word UI label that adds nothing aloud.
 * Capped at a handful of options: past that, listing them is worse than
 * asking the user to look at the screen, which the chat pane is showing.
 *
 * IT ASKS FOR THE LABEL BY NAME, and that is load-bearing rather than fussy.
 * The answer is matched against the option labels EXACTLY (question.ts), because
 * anything looser approves things the user refused — "Don't do it" contains "Do
 * it". Exact matching is only usable if the user knows which words to say, so
 * the question tells them. An answer in any other form still works; it just
 * travels as free text, which for a gate means "no, and here is why".
 */
export function describeQuestion(questions: readonly VoiceQuestion[]): string {
  const parts: string[] = [];
  for (const q of questions) {
    const opts = q.options.slice(0, 5).map((o) => o.label);
    const more =
      q.options.length > opts.length ? ` (and ${q.options.length - opts.length} more)` : '';
    parts.push(opts.length ? `${q.question} Options: ${opts.join('; ')}${more}.` : q.question);
  }
  const labels = questions[0]?.options.slice(0, 5).map((o) => `"${o.label}"`) ?? [];
  const how =
    labels.length >= 2
      ? ` Answer by saying one of those words exactly — ${labels.join(' or ')}.`
      : '';
  return `The agent is waiting on you. ${parts.join(' ')}${how}`;
}

/** The longest common prefix of two strings. */
function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

interface ReplyState {
  /** Raw text already handed out as commentary, for prefix comparison. */
  emitted: string;
  /** Raw text accumulated but not yet at a flushable boundary. */
  pending: string;
  /**
   * The authoritative `speak` has landed for this id.
   *
   * Frame ORDER is not guaranteed, and when `speak` wins the race its deltas
   * arrive afterwards carrying the very same sentences. Without this flag they
   * look like brand-new text — the reply gets spoken, and then spoken again.
   * `speak` carries the WHOLE reply, so after it there is by definition
   * nothing left for a delta to add.
   */
  finalized: boolean;
}

export interface SpeakBridgeOpts {
  /** Override the sentence-flush threshold (tests). */
  maxPendingChars?: number;
}

/**
 * Stateful only in the way it must be: it remembers, per reply id, how much of
 * that reply has already been spoken. Everything else about it is a pure
 * function of the frame.
 */
export class SpeakBridge {
  private readonly replies = new Map<string, ReplyState>();
  private readonly maxPending: number;
  /** Does the agent currently owe us an answer? Drives the "still working"
   *  heartbeat the session schedules. */
  private turnRunning = false;

  constructor(opts: SpeakBridgeOpts = {}) {
    this.maxPending = opts.maxPendingChars ?? MAX_PENDING_CHARS;
  }

  isTurnRunning(): boolean {
    return this.turnRunning;
  }

  /**
   * Drop per-reply state.
   *
   * Called on an explicit cancel and on teardown — NOT, as it once was, on
   * every new delegation. Tasks overlap now, and wiping this mid-turn would
   * discard the pending tail of a reply that is still streaming for work the
   * user has not abandoned. Reply ids are the agent's `toolu_*` tool-use ids,
   * which are unique per call, so nothing collides across turns either way.
   */
  reset(): void {
    this.replies.clear();
    this.turnRunning = false;
  }

  onFrame(frame: VoiceChatFrame): AppendIntent[] {
    switch (frame.t) {
      case 'turn-start':
        this.turnRunning = true;
        return [{ kind: 'thinking', text: 'The agent has started working on this.' }];

      case 'speak-delta':
        return this.onDelta(frame.id, frame.delta);

      case 'speak':
        return this.onFinal(frame.id, frame.text);

      case 'question':
        return [{ kind: 'commentary', text: describeQuestion(frame.questions) }];

      case 'turn-done': {
        this.turnRunning = false;
        // Anything still pending is the tail of a reply whose `speak` never
        // arrived. Say it — a dropped final frame must not eat the answer.
        const tail = this.flushAll();
        if (frame.ok) return tail;
        return [
          ...tail,
          {
            kind: 'commentary',
            text: frame.error
              ? `The agent's turn failed: ${frame.error}`
              : "The agent's turn failed without saying why.",
          },
        ];
      }

      case 'subagent': {
        const p = frame.progress;
        if (p.done)
          return [{ kind: 'thinking', text: `Subagent finished: ${p.label ?? 'subagent'}.` }];
        const what = p.lastTool ? ` — ${p.lastTool}` : '';
        return [{ kind: 'thinking', text: `Subagent working: ${p.label ?? 'subagent'}${what}.` }];
      }

      case 'queued':
        return [
          {
            kind: 'thinking',
            text: 'The agent is busy; this request is queued and will run next.',
          },
        ];

      case 'error':
        this.turnRunning = false;
        return [{ kind: 'commentary', text: `Something went wrong: ${frame.message}` }];

      case 'notice':
        return [{ kind: 'thinking', text: frame.message }];

      // `stream` and `question-done` are handled by falling through to
      // nothing, and that is the decision, not an omission — see the header.
      default:
        return [];
    }
  }

  private state(id: string): ReplyState {
    let s = this.replies.get(id);
    if (!s) {
      s = { emitted: '', pending: '', finalized: false };
      this.replies.set(id, s);
    }
    return s;
  }

  private onDelta(id: string, delta: string): AppendIntent[] {
    const s = this.state(id);
    if (s.finalized) return [];
    s.pending += delta;
    if (!SENTENCE_END.test(s.pending) && s.pending.length < this.maxPending) return [];
    // Long unpunctuated run: break at the last word boundary so we never cut a
    // word in half, but only if there IS one to break at.
    let take = s.pending;
    if (!SENTENCE_END.test(s.pending)) {
      const cut = s.pending.lastIndexOf(' ');
      if (cut <= 0) return [];
      take = s.pending.slice(0, cut + 1);
    }
    s.pending = s.pending.slice(take.length);
    s.emitted += take;
    const text = take.trim();
    return text ? [{ kind: 'commentary', text }] : [];
  }

  /**
   * The authoritative full reply. Emit only what the deltas have not already
   * said — by longest common prefix, so a lost or reordered delta degrades to
   * "say a little more than needed" rather than "say it twice" or "say
   * nothing".
   */
  private onFinal(id: string, full: string): AppendIntent[] {
    const s = this.state(id);
    const seen = s.emitted + s.pending;
    const keep = commonPrefixLength(seen, full);
    // The prefix matched everything we emitted AND everything pending: the
    // pending part is now accounted for by `full`, so retire it.
    s.pending = '';
    s.emitted = full.length > keep ? full : seen;
    s.finalized = true;
    const tail = full.slice(keep).trim();
    return tail ? [{ kind: 'commentary', text: tail }] : [];
  }

  private flushAll(): AppendIntent[] {
    const out: AppendIntent[] = [];
    for (const s of this.replies.values()) {
      const text = s.pending.trim();
      s.emitted += s.pending;
      s.pending = '';
      if (text) out.push({ kind: 'commentary', text });
    }
    return out;
  }
}
