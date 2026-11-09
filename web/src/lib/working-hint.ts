import type { ChatEvent } from '@muxpad/shared';
import { isPrivateReasoning, lastTurnStartId } from './chat-voice';

/**
 * WHAT THE AGENT LAST SAID IT WAS DOING — one line, in the working indicator.
 *
 * ── THE PROBLEM, IN THE OWNER'S WORDS ────────────────────────────────────
 * "When a chat goes through a long period of making Bash calls… it collapses
 * these intermediate thinking blocks and makes them invisible. I think it
 * would be useful… if there is an informative string about what's going on…
 * perhaps the working indicator should show the last string or part of the
 * last string — without contributing to a fixed growing verbose log."
 *
 * Both halves of that matter. During a ten-minute tool stretch the indicator
 * says `Running Bash…` and nothing about WHY, while the agent has usually
 * just written the answer ("Critical clue: the transcript's model is…"). And
 * the reason that text is not already on screen is deliberate: chat-voice
 * demotes it to `voice: 'private'` and folds it, "collapse, never drop".
 *
 * ── WHY THIS IS NOT THE THING THAT WAS REFUSED ───────────────────────────
 * ChatPane declines to stream the scratchpad live, for a stated reason:
 * doing so would "put reasoning on screen live and then take it back at turn
 * end". That objection is about PERSISTENCE AND RETRACTION — text that
 * becomes a message and then vanishes.
 *
 * This never becomes a message. It occupies the indicator's own row, is
 * replaced by the next one rather than appended, and dies with the turn. The
 * log does not grow by a single line, and nothing is taken back because
 * nothing was given.
 *
 * ── AND ONLY WHEN IT IS NOT ALREADY ON SCREEN ────────────────────────────
 * In agent mode this narration renders inline as ordinary messages — the
 * italic blocks between tool rows. Repeating the latest one in the indicator
 * would print the same sentence twice, a few pixels apart. So the hint is
 * taken ONLY from text the chat has hidden, which is exactly
 * `isPrivateReasoning`.
 */

/** Longer than a glance, shorter than a paragraph. The clamp is a fallback —
 *  the sentence cut below is what usually ends it. */
const MAX = 120;

/**
 * Strip the markdown that makes a sentence unreadable at indicator size.
 *
 * Deliberately shallow: emphasis, code ticks, headings and link syntax, which
 * is what this text actually contains ("the model is **`ivrit-ai/…`**"). It is
 * not a parser and must not become one — anything it does not understand is
 * left alone rather than mangled.
 */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*>]\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first sentence, not the first N characters.
 *
 * These lines open with the load-bearing clause — "Sweep only alerts — it
 * doesn't re-record", "Critical clue: the transcript's model is X" — so a
 * sentence boundary keeps a whole thought where a character count gives you
 * half a word. The clamp still applies, for a sentence that never ends.
 */
function firstSentence(text: string): string {
  const stop = /[.!?](?:\s|$)/.exec(text);
  const head = stop ? text.slice(0, stop.index + 1) : text;
  if (head.length <= MAX) return head;
  const cut = head.lastIndexOf(' ', MAX);
  return `${head.slice(0, cut > 40 ? cut : MAX).trimEnd()}…`;
}

/**
 * The hint for the turn in progress, or null.
 *
 * Scoped to THIS TURN: `lastTurnStartId` is the same boundary the rest of the
 * chat uses, so a hint can never be left over from the previous one — which
 * would be worse than no hint, since it would describe work already finished.
 */
export function workingHint(events: readonly ChatEvent[]): string | null {
  const turnStart = lastTurnStartId(events);
  const from = turnStart ? events.findIndex((e) => e.id === turnStart) : 0;
  if (from < 0) return null;
  for (let i = events.length - 1; i >= from; i--) {
    const e = events[i];
    if (!e || e.kind !== 'assistant') continue;
    // Only text the chat is HIDING. Anything visible is already on screen,
    // directly above this indicator.
    if (!isPrivateReasoning(e)) return null;
    const text = firstSentence(plain(e.text ?? ''));
    return text.length > 1 ? text : null;
  }
  return null;
}
