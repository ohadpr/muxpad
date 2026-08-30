import type { ChatEvent } from '@muxpad/shared';
import { normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { TabStore } from '../store/TabStore.js';
import { findTranscript, identityNormalize, muxpadLocate } from './TranscriptReader.js';
import { readTailLines } from './has-messages.js';

/**
 * The nav row's second line: ONE line saying what a chat is currently about.
 *
 * ─── The whole design problem is DRIFT, not generation ────────────────────
 *
 * Writing a summary is easy and a model does it well. The hard requirement is
 * that the line must be nearly still. The rail exists to be scanned, and its
 * one deliberate piece of motion is the blocked mark's breath; a summary that
 * re-worded itself every turn would be a second moving thing in the same
 * field of view, and would destroy the property the whole surface is for.
 * Worse, it would be motion that means nothing — the same chat, described
 * differently.
 *
 * So the bar for CHANGING a headline is set far above the bar for writing the
 * first one, and it is enforced in three independent places, cheapest first:
 *
 *   1. `shouldConsiderHeadline` — a pure gate that runs before any model call
 *      at all. A quiet chat costs nothing; a busy chat costs at most one call
 *      per HEADLINE_MIN_INTERVAL_MS. This is the rate limit, and it is the
 *      only one of the three that can save money.
 *   2. The prompt itself hands the model the CURRENT headline and tells it to
 *      answer `KEEP` unless the conversation has materially moved. Asking
 *      "has this changed?" is a much easier question than "what is this
 *      about?", and it biases the cheap model toward stability rather than
 *      toward writing something (models like writing something).
 *   3. `parseHeadlineReply` treats anything unparseable, empty, or
 *      insignificantly different as KEEP. The failure mode of every layer is
 *      "leave it alone", which is the correct default.
 *
 * The clock behind (1) is PERSISTED on the tab row, not held in memory: a
 * restart is exactly the moment a rate limiter must not forget itself, or a
 * crash-loop re-summarises every chat on every boot.
 *
 * Degrades silently by contract. Every failure path returns null and the rail
 * renders a one-line row. There is deliberately no error string and no
 * placeholder — a rail that says "couldn't summarise" on ten rows is worse
 * than one that says nothing, because it spends the reader's attention on the
 * tool's problems instead of their work.
 */

/** Max characters. Roughly what fits on one line of a 240px rail before the
 *  ellipsis does the rest; also a hard stop on a model that ignores the ask. */
export const HEADLINE_MAX_CHARS = 90;

/**
 * Floor between model calls for one chat. 20 minutes is long enough that an
 * agent working steadily for an hour costs three calls, not sixty, and short
 * enough that a chat you come back to after lunch is current.
 */
export const HEADLINE_MIN_INTERVAL_MS = 20 * 60_000;

/**
 * How many user/assistant turns a chat must contain before it gets a headline
 * at all. One turn is usually a greeting or a paste, and summarising it
 * produces a line that has to be replaced immediately — which is the drift we
 * are trying to avoid, self-inflicted on turn two.
 */
export const HEADLINE_MIN_TURNS = 2;

/** Bytes of transcript tail to read. Bounded so a multi-GB session log costs
 *  a seek, not a full read. */
const TAIL_BYTES = 64 * 1024;

/** Characters of conversation handed to the model. */
const MAX_PROMPT_CHARS = 4000;

/** The sentinel the model returns when the existing headline still holds. */
export const KEEP = 'KEEP';

export interface HeadlineGateInput {
  /** The headline on the row now, if any. */
  existing: string | null;
  /** When it was written (epoch ms), or null if never. */
  lastAt: number | null;
  /** User+assistant turns visible in the transcript tail. */
  turns: number;
  now: number;
}

/**
 * Is it worth spending a model call on this chat right now?
 *
 * Pure, and deliberately the FIRST thing every caller runs — the point is to
 * decide without paying. Three rules:
 *
 *   - Too few turns → no. There is nothing to summarise yet.
 *   - No headline yet → YES, unconditionally. The first one is the whole
 *     value; making a new chat wait 20 minutes for its line would mean the
 *     rail is least useful exactly when you have the most chats open.
 *   - Otherwise → only after the interval. Note this is a floor on ATTEMPTS,
 *     not on changes: an attempt that comes back KEEP still resets the clock,
 *     because the expensive thing is the call, not the write.
 */
export function shouldConsiderHeadline(i: HeadlineGateInput): boolean {
  if (i.turns < HEADLINE_MIN_TURNS) return false;
  if (!i.existing) return true;
  if (i.lastAt === null) return true;
  return i.now - i.lastAt >= HEADLINE_MIN_INTERVAL_MS;
}

/**
 * Would replacing `existing` with `next` actually tell the reader anything?
 *
 * The last line of defence against churn, and the one that catches the most
 * common failure: a model that has been told to answer KEEP, agrees nothing
 * has changed, and then helpfully rewrites the line anyway with different
 * wording. Compared case- and punctuation-insensitively on the leading words,
 * because "wiring the cron scheduler into boot" and "Wiring the cron
 * scheduler into boot." are the same sentence and neither is worth a repaint.
 */
export function isMaterialChange(existing: string | null, next: string): boolean {
  if (!existing) return true;
  return normalizeForCompare(existing) !== normalizeForCompare(next);
}

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn a model reply into a headline, or null for "keep what you have".
 *
 * Every ambiguous outcome resolves to null. A cheap model asked for one line
 * will sometimes return a code fence, a quoted string, a "Headline:" prefix,
 * a two-line answer, or an apology — none of which is a reason to overwrite a
 * line that was fine.
 */
export function parseHeadlineReply(raw: string, existing: string | null): string | null {
  let s = raw.trim();
  if (!s) return null;
  // Unwrap a code fence, keeping only its body.
  const fence = s.match(/^```[a-z]*\n?([\s\S]*?)\n?```$/i);
  if (fence?.[1] !== undefined) s = fence[1].trim();
  // One line only — a model that explained itself gets its first sentence
  // taken and the explanation dropped.
  s = (s.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  s = s.replace(/^(headline|summary|title)\s*:\s*/i, '');
  // Strip symmetric quotes.
  s = s.replace(/^["'“”](.*)["'“”]$/s, '$1').trim();
  if (!s) return null;
  if (s.toUpperCase() === KEEP) return null;
  // A reply that is mostly the sentinel plus hedging ("KEEP - still about
  // the cron scheduler") is also a keep.
  if (/^keep\b/i.test(s)) return null;
  if (s.length > HEADLINE_MAX_CHARS) s = `${s.slice(0, HEADLINE_MAX_CHARS - 1).trimEnd()}…`;
  if (!isMaterialChange(existing, s)) return null;
  return s;
}

export function buildHeadlinePrompt(conversation: string, existing: string | null): string {
  // The existing line goes in FIRST and the instruction leads with KEEP, so
  // the cheapest path through the prompt is the one that changes nothing.
  const current = existing
    ? `The row currently reads: "${existing}"\nIf that still describes what this conversation is about — even loosely — reply with exactly KEEP. Only write a new line if the topic has MATERIALLY changed to something else. Rewording is not a change; reply KEEP.`
    : 'This row has no line yet. Write one.';
  return [
    "You are labelling one row in a chat sidebar. The row already shows the chat's name; your line goes underneath it and says what the chat is currently about.",
    '',
    current,
    '',
    'Rules for a new line:',
    `- ONE line, under ${HEADLINE_MAX_CHARS} characters, no trailing period.`,
    '- Lowercase unless a proper noun starts it.',
    '- Say the SUBJECT, not the activity: "mid-drive vs hub motors", not "the user is researching e-bikes".',
    '- No preamble, no quotes, no markdown. Output the line and nothing else.',
    '',
    'Conversation:',
    conversation,
  ].join('\n');
}

/** The model seam — a bare one-shot completion. Injected so the gate, the
 *  prompt and the parser are all testable without a network or a subprocess. */
export type HeadlineModel = (prompt: string, signal: AbortSignal) => Promise<string>;

const TIMEOUT_MS = 30_000;

/**
 * Read a pane's transcript tail and return its user/assistant turns.
 *
 * Bounded twice — `readTailLines` caps the file read, and the join caps the
 * prompt — so this costs the same on a two-turn chat and a six-hour one.
 */
export function readRecentTurns(
  db: Database.Database,
  paneId: string,
): { conversation: string; turns: number } {
  const sessions = new AgentSessionStore(db);
  const sess = sessions.getByPane(paneId);
  const sid = sess?.current_sid;
  if (!sid) return { conversation: '', turns: 0 };
  const path = (sess.assistant === 'claude' ? findTranscript(sid) : null) ?? muxpadLocate(sid);
  if (!path) return { conversation: '', turns: 0 };
  let lines: string[];
  try {
    lines = readTailLines(path, TAIL_BYTES);
  } catch {
    return { conversation: '', turns: 0 };
  }
  const normalize = sess.assistant === 'claude' ? normalizeTranscriptLine : identityNormalize;
  const out: string[] = [];
  let turns = 0;
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    for (const ev of normalize(obj) as ChatEvent[]) {
      if ((ev.kind !== 'user' && ev.kind !== 'assistant') || !ev.text) continue;
      turns += 1;
      out.push(`${ev.kind}: ${ev.text}`);
    }
  }
  return { conversation: out.join('\n').slice(-MAX_PROMPT_CHARS), turns };
}

/**
 * Generate (or decline to change) one tab's headline.
 *
 * Returns the new line, or null for "nothing to do" — which covers every
 * failure as well as every deliberate keep. Callers cannot tell the two
 * apart, and shouldn't: both mean "leave the row as it is".
 */
export async function maybeWriteHeadline(
  db: Database.Database,
  tabId: string,
  paneId: string,
  model: HeadlineModel,
  now: number = Date.now(),
): Promise<string | null> {
  const tabs = new TabStore(db);
  const tab = tabs.getById(tabId);
  if (!tab) return null;
  const existing = tab.headline ?? null;
  const lastAt = tabs.headlineAt(tabId);

  // Read the transcript BEFORE the gate only because the gate needs the turn
  // count. It is a bounded tail read, not a model call — the expensive thing
  // is still behind the gate.
  const { conversation, turns } = readRecentTurns(db, paneId);
  if (!conversation) return null;
  if (!shouldConsiderHeadline({ existing, lastAt, turns, now })) return null;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  let reply: string;
  try {
    reply = await model(buildHeadlinePrompt(conversation, existing), abort.signal);
  } catch {
    // Silent by contract — a model that timed out is not something to tell
    // the user about in a nav rail. But the clock STILL advances: a chat with
    // no headline yet passes the gate unconditionally, so a persistent
    // failure (no Claude login, a timeout, an SDK import error) would
    // otherwise spawn a fresh CLI subprocess on every finished turn on every
    // tab, indefinitely. A failure is an attempt, and attempts are what the
    // limiter counts.
    tabs.touchHeadlineAt(tabId, now);
    return null;
  } finally {
    clearTimeout(timer);
  }

  // Same rule for a KEEP, and for a first-run reply we couldn't parse: a chat
  // whose topic is stable would otherwise be re-asked on every turn forever —
  // the single most expensive case, and the most pointless.
  const next = parseHeadlineReply(reply, existing);
  if (next === null) {
    tabs.touchHeadlineAt(tabId, now);
    return null;
  }
  tabs.setHeadline(tabId, next, now);
  return next;
}

/**
 * The production model: a one-shot Haiku completion through the Claude Agent
 * SDK — the same shape chat/clean-transcript.ts and chat/summarize.ts use.
 *
 * Why the Agent SDK and not `@anthropic-ai/sdk`: this machine has no
 * ANTHROPIC_API_KEY and no auth token. What it has is the Claude Code login
 * the agent panes already run on, and the Agent SDK's bundled CLI picks that
 * up with no configuration. Reusing that path rather than inventing a second
 * one also means there is exactly one place where "how does muxpad reach a
 * model" is answered.
 *
 * `settingSources: []` + `allowedTools: []` keep it a completion: no
 * CLAUDE.md, no skills, no MCP, no filesystem. Dynamic import so a server
 * that never writes a headline doesn't pay the SDK's load at boot.
 *
 * `model: 'haiku'` is the ALIAS, not a pinned id, matching the rest of the
 * codebase — a headline is a cheap, low-stakes label and should ride whatever
 * the current cheap model is rather than pinning us to a version to migrate.
 * (Haiku 4.5 is ~$1/$5 per million in/out; a 4k-char prompt and a ~15-token
 * reply is well under a hundredth of a cent, so the rate limit above is about
 * churn and latency, not money.)
 */
export const agentSdkHeadlineModel: HeadlineModel = async (prompt, signal) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abort = new AbortController();
  if (signal.aborted) abort.abort();
  else signal.addEventListener('abort', () => abort.abort(), { once: true });
  let out = '';
  let failure = '';
  for await (const m of query({
    prompt,
    options: {
      model: 'haiku',
      maxTurns: 1,
      settingSources: [],
      allowedTools: [],
      abortController: abort,
    },
  })) {
    if (m.type !== 'result') continue;
    if (m.subtype === 'success') out = m.result;
    else failure = m.subtype;
  }
  if (!out && failure) throw new Error(failure);
  return out;
};
