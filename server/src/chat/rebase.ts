import { readFileSync } from 'node:fs';
import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { identityNormalize } from './TranscriptReader.js';
import { transcriptForPane } from './transcript-access.js';

/**
 * REBASE A STALE CHAT — a fresh context, seeded from the transcript on disk.
 *
 * ── THE PROBLEM, IN THE OWNER'S WORDS ────────────────────────────────────
 * "A long running chat that has likely been compacted several times — not only
 * does it degrade in quality, but its system instructions and information on
 * muxpad tools become stale as we continue developing the system."
 *
 * Two faults wearing one coat, and they want opposite fixes:
 *
 *   STALE INSTRUCTIONS are fixed by restarting the runner: the generated
 *   instructions are rewritten on every boot (agent-files.ts), so a respawned
 *   pane wakes up knowing today's tools. Nothing here is needed for that.
 *
 *   COMPACTION DECAY is not fixed by compacting again. Each pass summarises the
 *   previous summary, so detail is lost for good and small errors ratchet into
 *   confident ones. Another /compact makes it worse.
 *
 * ── WHY THIS CAN DO BETTER THAN A /compact ───────────────────────────────
 * muxpad still has the WHOLE TRANSCRIPT on disk. So a rebase summarises from
 * SOURCE rather than from the degraded chain — it can recover detail the chain
 * already dropped, which is the one thing an in-session compaction can never
 * do, because by then the originals are out of the window.
 *
 * ── WHAT IT DELIBERATELY THROWS AWAY ─────────────────────────────────────
 * Every fact about tools, flags, environment and house rules. Those are exactly
 * the stale half, they are re-injected in full by the new session's system
 * prompt, and carrying a sentence about how `muxpad cron` used to work is worse
 * than carrying nothing: the model has no way to know which of two instructions
 * is older. So the briefing is the part of a conversation a system prompt can
 * never supply — what we are doing, what we decided and why, what is still
 * open.
 *
 * Best-effort by contract, like {@link summarizePane}: every failure returns
 * null and the caller must read that as "do not rebase", never as "rebase into
 * an empty session". Losing the context of a 40-day conversation is not
 * recoverable, and a blank agent that believes it has been briefed is worse
 * than a stale one.
 */

/** How much of each end of the transcript is read. A long chat is a story with
 *  a beginning that set the goal and an end that holds the state; the middle is
 *  where the compaction chain already lives, and reading all of a 130 MB
 *  transcript is neither affordable nor more informative. */
export const HEAD_LINES = 400;
export const TAIL_LINES = 2400;
/** Model input ceiling per end, in characters. */
const HEAD_CHARS = 12_000;
const TAIL_CHARS = 40_000;

export interface RebaseCorpus {
  /** The opening turns — the original ask and the first decisions. */
  head: string;
  /** The recent turns — where the work actually stands. */
  tail: string;
  /** The conversation's first user turn, trimmed, as a label. */
  title: string;
  /** Did the two ends meet? A short chat has no gap, and saying so stops the
   *  model inventing a bridge over a middle that does not exist. */
  whole: boolean;
  /** The conversation goes on, VERBATIM, after this text. Set by the
   *  transcript rebase, which briefs only the span too old to replay and keeps
   *  the recent turns whole — so "where things stand" is the recent turns'
   *  job, not the briefing's. */
  continues?: boolean;
}

/**
 * Split a raw transcript into the two ends worth summarising.
 *
 * Pure and exported for its own tests: what goes INTO a briefing decides what
 * the next session believes, and that is worth checking against fixtures rather
 * than against a live model.
 */
export function rebaseCorpus(raw: string, assistant: string): RebaseCorpus {
  return rebaseCorpusOfLines(
    raw.split('\n').filter((l) => l.trim()),
    assistant,
  );
}

/**
 * The same, from lines already in hand. `total` is how many lines the
 * conversation really has when the caller passes only its two ends — the
 * transcript rebase reads just the first HEAD_LINES and last TAIL_LINES of a
 * span that can be hundreds of megabytes, and the gap must still be reported.
 */
export function rebaseCorpusOfLines(
  lines: string[],
  assistant: string,
  total = lines.length,
): RebaseCorpus {
  const normalize = assistant === 'claude' ? normalizeTranscriptLine : identityNormalize;
  const turnsIn = (slice: string[]): string[] => {
    const out: string[] = [];
    for (const line of slice) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      for (const ev of normalize(obj) as ChatEvent[]) {
        if ((ev.kind !== 'user' && ev.kind !== 'assistant') || !ev.text) continue;
        out.push(`${ev.kind}: ${ev.text}`);
      }
    }
    return out;
  };

  const whole = total <= HEAD_LINES + TAIL_LINES;
  const headTurns = turnsIn(lines.slice(0, HEAD_LINES));
  // A whole transcript is NOT read twice: with no gap the tail already contains
  // the head, and a model shown the same turns under two headings reports the
  // opening as if it had happened again at the end.
  const tailTurns = whole ? turnsIn(lines) : turnsIn(lines.slice(-TAIL_LINES));
  const first = headTurns.find((t) => t.startsWith('user: '))?.slice(6) ?? '';
  return {
    head: whole ? '' : headTurns.join('\n').slice(0, HEAD_CHARS),
    tail: tailTurns.join('\n').slice(-TAIL_CHARS),
    title: first.replace(/\s+/g, ' ').trim().slice(0, 80),
    whole,
  };
}

/** The instruction the whole feature turns on. Exported so a test can assert
 *  the two halves are actually asked for — a briefing that keeps the tool talk
 *  would re-stale the chat on the first message. */
export function rebasePrompt(c: RebaseCorpus): string {
  return [
    'You are preparing a HANDOFF BRIEFING so a fresh session can continue this exact piece of work.',
    '',
    'INCLUDE, in this order, as terse prose under short headings:',
    '  1. The goal — what the user is trying to achieve, in their terms.',
    '  2. State — what is done, what is in progress, what is verified vs assumed.',
    '  3. Decisions and their REASONS, including options rejected and why. A decision',
    '     whose reason is lost gets relitigated.',
    '  4. Constraints the user has stated, in their words where you can.',
    '  5. Open threads — what was about to happen next, and anything waiting on the user.',
    '',
    'EXCLUDE, and this is the point of the exercise:',
    '  · Anything about tools, commands, flags, file layout, environment or house rules.',
    '    The new session receives all of that fresh and in full. Your copy is older than',
    '    its copy, and it cannot tell which is which — so a sentence about how a tool',
    '    works is worse than silence.',
    '  · The narrative of how the conversation went, who said what when, and any praise,',
    '    apology or process talk.',
    '  · Anything you are not confident actually happened. Say "unclear" instead.',
    '',
    'Write for someone who will act on it immediately and cannot ask follow-ups. No',
    'preamble, no sign-off. Under 500 words.',
    '',
    ...(c.continues
      ? [
          'This is only the EARLIER part of a conversation. The turns after it are kept',
          'verbatim and the reader will see them right after your briefing, so do not',
          'describe them, and treat "state" as of the end of this part — later turns may',
          'have changed it.',
          '',
        ]
      : []),
    c.whole
      ? 'The complete conversation follows.'
      : 'The conversation is long, so you are given its OPENING and its MOST RECENT part, with a gap between them. Do not invent what happened in the gap; where the two ends disagree, the recent part is current.',
    '',
    ...(c.head ? ['=== OPENING ===', c.head, ''] : []),
    '=== RECENT ===',
    c.tail,
  ].join('\n');
}

/**
 * Build the briefing for a pane, or null.
 *
 * Reads through the transcript chokepoint, so a pane living on another machine
 * resolves to that host rather than searching this disk (transcript-access.ts).
 * A remote pane returns null today: the rebase has to be performed where the
 * conversation is, and offering it from here would brief the wrong machine.
 */
export async function rebaseBriefing(
  db: Database.Database,
  paneId: string,
): Promise<string | null> {
  const sessions = new AgentSessionStore(db);
  const sess = sessions.getByPane(paneId);
  const sid = sess?.current_sid;
  if (!sid) return null;
  const access = transcriptForPane(db, paneId, sid, sess.assistant);
  if (access.kind !== 'local') return null;

  let raw: string;
  try {
    raw = readFileSync(access.path, 'utf8');
  } catch {
    return null;
  }
  const corpus = rebaseCorpus(raw, sess.assistant);
  if (!corpus.tail) return null;
  const text = await writeBriefing(corpus);
  if (!text) return null;
  return corpus.title ? `Ongoing thread: ${corpus.title}\n\n${text}` : text;
}

/**
 * The model call alone: corpus in, briefing out, null on any failure.
 *
 * Split out of {@link rebaseBriefing} so the transcript rebase can brief the
 * span it is dropping without re-reading the file or re-deciding which pane it
 * is — it already holds both.
 */
export async function writeBriefing(corpus: RebaseCorpus): Promise<string | null> {
  if (!corpus.tail) return null;
  const abort = new AbortController();
  // Longer than the deliverable summary's 30s: this reads both ends of a long
  // conversation and is user-initiated, so it is allowed to take a moment.
  const timeout = setTimeout(() => abort.abort(), 120_000);
  let text = '';
  try {
    const { accountCompletion: query } = await import('../claude-accounts/completion.js');
    const one = query({
      prompt: rebasePrompt(corpus),
      options: {
        // NOT haiku. A deliverable summary is one sentence and forgiving; this
        // one decides what a long piece of work believes about itself, and a
        // dropped constraint here is a constraint the next session breaks.
        model: 'sonnet',
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        abortController: abort,
      },
    });
    for await (const m of one) {
      if (m.type === 'result' && m.subtype === 'success') text = m.result;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
  text = text.trim();
  return text || null;
}

/**
 * Wrap a briefing for delivery into the rebased session.
 *
 * Delimited and explicit about its own provenance, like every muxpad-authored
 * block. It says the history is NOT in the window and that the tools in force
 * are the ones in the system prompt — because the single failure mode of this
 * feature is a fresh agent that half-remembers the old build.
 */
export function wrapRebase(text: string): string {
  return ['<muxpad-rebase>', REBASE_PREAMBLE, '', text.trim(), '</muxpad-rebase>'].join('\n');
}

/** The fixed text around a briefing-only rebase's briefing. One constant, so
 *  {@link briefingOf} strips exactly what {@link wrapRebase} wrote. */
export const REBASE_PREAMBLE = [
  'This chat has been REBASED at the user’s request: same conversation, fresh context.',
  'The earlier history is NOT in your window — it is on disk and searchable, and the',
  'briefing below was written from it. Treat the briefing as established background and',
  'say so plainly if you need detail it does not cover; do not guess at what came before.',
  '',
  'Your tools, rules and environment are whatever your CURRENT instructions say. The',
  'old session was running an older build of muxpad and anything it believed about',
  'tooling was deliberately left out of the briefing.',
].join('\n');

/**
 * The HISTORY a transcript rebase puts in front of the turns it kept.
 *
 * A different tag from `<muxpad-rebase>` on purpose. A rebase strips every
 * muxpad-authored block because those are instructions, and instructions go
 * stale — but this one is not an instruction, it is the only remaining copy of
 * the older half of the conversation. A second rebase that stripped it would
 * delete history, so it is the one muxpad tag the transform keeps.
 */
export function wrapHistory(text: string): string {
  return [
    '<muxpad-history>',
    'The EARLIER part of this conversation, summarised from its transcript when the chat',
    'was rebased onto current instructions. Everything after this message is verbatim.',
    '',
    text.trim(),
    '</muxpad-history>',
  ].join('\n');
}

/**
 * The briefing inside an earlier rebase or carryover block, without the
 * instruction prose around it — or null when the block is not one of those.
 *
 * Those blocks hold the only copy of the history before them, so the transform
 * keeps the briefing (re-wrapped as `<muxpad-history>`) and drops only the
 * paragraphs about tools and windows, which are exactly the stale part.
 */
export function briefingOf(tag: string, inner: string): string | null {
  const t = inner.trim();
  if (tag === 'muxpad-rebase') {
    return (t.startsWith(REBASE_PREAMBLE) ? t.slice(REBASE_PREAMBLE.length) : t).trim() || null;
  }
  if (tag === 'muxpad-carryover') {
    // summarize.ts: one fixed paragraph, then the briefing.
    const gap = t.indexOf('\n\n');
    return (gap >= 0 && t.startsWith('You are continuing work') ? t.slice(gap) : t).trim() || null;
  }
  return null;
}
