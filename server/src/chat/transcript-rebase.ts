import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isCompactionText,
  isInterruptMarker,
  isPlumbingUserText,
  stripMentionContext,
} from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import {
  HEAD_LINES,
  type RebaseCorpus,
  TAIL_LINES,
  briefingOf,
  rebaseCorpusOfLines,
  wrapHistory,
  writeBriefing,
} from './rebase.js';
import { transcriptForPane } from './transcript-access.js';

/**
 * THE TRANSCRIPT REBASE — same turns, new base.
 *
 * "i want the history but I WANT IT REBASED ON THE NEW INSTRUCTIONS."
 *
 * A git rebase replays the same commits onto a new base. Here the base is the
 * system prompt, and a respawn already rebuilds that from today's generated
 * instructions. What a respawn cannot fix is instruction text that LEAKED INTO
 * THE CONVERSATION and replays with it on `--resume`: compaction summaries that
 * restate rules as they were weeks ago, every `<muxpad-…>` block muxpad
 * prepended to a message, every `<system-reminder>` the harness injected. The
 * model has no way to tell which of two copies of a rule is newer, so the old
 * copies are worse than none.
 *
 * So this writes a NEW transcript under a NEW session id holding the same real
 * turns with that material removed, and the pane resumes that. The original
 * file is never touched: it stays on disk, searchable, and is the way back.
 *
 * ── IT ALSO UNDOES THE COMPACTIONS ───────────────────────────────────────
 * A compaction does not delete the turns it summarised; it starts a new chain
 * (`compact_boundary`, parentUuid null) and points back with
 * `logicalParentUuid`. Following that pointer instead of stopping recovers the
 * original turns, so a rebased chat gets its real history back rather than a
 * summary of a summary.
 *
 * ── INTEGRITY IS THE WHOLE JOB ───────────────────────────────────────────
 * A transcript the API rejects on replay is worse than no feature: the chat
 * would not start at all. Three rules, and {@link checkTranscript} re-verifies
 * every one of them on the bytes about to be written:
 *   · the output is ONE linear chain — fresh uuids, each entry's parent the one
 *     before it — so nothing can dangle however much was dropped;
 *   · every `tool_use` has exactly one `tool_result`, in the next user turn,
 *     or neither is kept;
 *   · every entry carries the new sessionId, and the first one is a user turn.
 *
 * Pure down to {@link transcriptRebase}, which is the only part that reads,
 * calls a model or writes.
 */

type Json = Record<string, unknown>;

/**
 * Attachments worth replaying. Everything else the harness attaches renders as
 * a `<system-reminder>` — environment, date, model, tool and skill listings,
 * CLAUDE.md copies, token counters, "the user hasn't heard from you" nudges —
 * which is exactly the stale material, and the harness re-attaches its current
 * versions to the next turn anyway.
 *
 * Measured on this machine (every attachment type in ~/.claude/projects),
 * only these three carry something a PERSON put into the conversation:
 *   queued_command · a message typed while the agent was mid-turn, or a
 *                    background task's completion notice
 *   file / directory · content the user @-mentioned
 */
const KEPT_ATTACHMENTS = new Set(['queued_command', 'file', 'directory']);

/** Entry types that live on the uuid chain. The rest (ai-title, last-prompt,
 *  queue-operation, mode, pr-link, cost-state, file-history-snapshot…) are
 *  harness bookkeeping keyed to the OLD session and are not carried over. */
const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);

/**
 * WHERE THE LINE IS DRAWN, and why it is not "as much as fits".
 *
 * The output must leave room to WORK. A history replayed at 95% of the window
 * auto-compacts on the first turn, and a compaction is the exact decay a rebase
 * exists to undo — so the budget for replayed history is half the window. The
 * other half is the system prompt and tool schemas (~30–40k), and the next
 * several turns of real work.
 *
 * The window is inferred from the transcript itself: the largest context the
 * API ever reported for this session (`usage`, or a compaction's `preTokens`).
 * A session that has been past 200k is on a 1M-context model; anything else is
 * treated as 200k. Wrong in the safe direction — a 1M session that never got
 * past 200k is cut shorter than it had to be, never longer.
 */
const BUDGET_FRACTION = 0.5;
const SMALL_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;
/** Deliberately pessimistic for code and JSON, which tokenise denser than
 *  prose; overestimating costs a few old turns, underestimating costs the chat. */
const CHARS_PER_TOKEN = 3;
/** An image costs ~1.6k tokens however long its base64 is. */
const IMAGE_TOKENS = 1_600;
/** Room for the `<muxpad-history>` entry itself (a sub-500-word briefing). */
const BRIEFING_RESERVE = 2_000;

export interface RebaseStats {
  compactions: number;
  muxpadBlocks: number;
  reminders: number;
  plumbing: number;
  /** Attachment entries dropped, by type. */
  attachments: Record<string, number>;
  orphanToolUses: number;
  orphanToolResults: number;
  /** Entries off the live chain: abandoned branches, sidechains, bookkeeping. */
  offChain: number;
  /** The walk reached a parent the file does not contain. */
  danglingSource: number;
}

export interface TranscriptPlan {
  /** What is replayed verbatim, oldest first, cleaned and not yet re-linked. */
  kept: Json[];
  /** The older span that did not fit, or null when the whole history does.
   *  `ends` is its first HEAD_LINES and last TAIL_LINES entries as JSON lines —
   *  all a briefing reads — and `count` is how many it really has. */
  dropped: { count: number; ends: string[] } | null;
  tokens: { total: number; kept: number; budget: number; window: number };
  stats: RebaseStats;
}

export type PlanResult =
  | { ok: true; plan: TranscriptPlan }
  | { ok: false; reason: 'empty' | 'last_turn_too_large'; detail: string };

// ── text cleaning ──────────────────────────────────────────────────────────

/** A muxpad block at the very START of a message. Anchored on purpose: these
 *  are always prepended, and a message that merely QUOTES one — this repo's own
 *  chats discuss them constantly — must not lose text. */
const LEADING_MUXPAD = /^\s*<(muxpad-[a-z][a-z-]*)\b[^>]*>([\s\S]*?)<\/\1>\s*/;
const LEADING_REMINDER = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/;
/** No `<system-reminder>` inside the body, or a lazy match starting at the
 *  FIRST reminder would swallow the real text between two of them. */
const TRAILING_REMINDER =
  /\s*<system-reminder>(?:(?!<system-reminder>)[\s\S])*?<\/system-reminder>\s*$/;

/**
 * A user-role text with the injected material removed. '' means nothing a
 * person said is left, and the caller drops it.
 */
export function cleanUserText(text: string, stats: RebaseStats): string {
  let t = text;
  for (;;) {
    const r = t.match(LEADING_REMINDER);
    if (r) {
      stats.reminders += 1;
      t = t.slice(r[0].length);
      continue;
    }
    const m = t.match(LEADING_MUXPAD);
    if (!m) break;
    const tag = m[1] as string;
    // The history a previous rebase left is the one muxpad block that is
    // CONVERSATION, not instruction — keep it and everything after it.
    if (tag === 'muxpad-history') break;
    stats.muxpadBlocks += 1;
    const rest = t.slice(m[0].length);
    const briefing = briefingOf(tag, m[2] ?? '');
    if (briefing) {
      t = rest.trim() ? `${wrapHistory(briefing)}\n\n${rest}` : wrapHistory(briefing);
      break;
    }
    t = rest;
  }
  for (;;) {
    const r = t.match(TRAILING_REMINDER);
    if (!r) break;
    stats.reminders += 1;
    t = t.slice(0, t.length - r[0].length);
  }
  const unmentioned = stripMentionContext(t);
  if (unmentioned !== t.trimEnd()) stats.muxpadBlocks += 1;
  t = unmentioned.trim();
  if (t && isCompactionText(t)) {
    stats.compactions += 1;
    return '';
  }
  if (t && isPlumbingUserText(t)) {
    stats.plumbing += 1;
    return '';
  }
  return t;
}

/** Trailing reminders off a tool result. Only TRAILING: the result is a
 *  command's output, and a file that contains the tag must keep it. */
function cleanToolResultContent(content: unknown, stats: RebaseStats): unknown {
  const strip = (s: string): string => {
    let t = s;
    for (;;) {
      const r = t.match(TRAILING_REMINDER);
      if (!r) return t;
      stats.reminders += 1;
      t = t.slice(0, t.length - r[0].length);
    }
  };
  if (typeof content === 'string') return strip(content);
  if (!Array.isArray(content)) return content;
  return content.map((b) =>
    isObj(b) && b.type === 'text' && typeof b.text === 'string' ? { ...b, text: strip(b.text) } : b,
  );
}

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function contentOf(e: Json): unknown {
  return isObj(e.message) ? e.message.content : undefined;
}

function withContent(e: Json, content: unknown): Json {
  return { ...e, message: { ...(e.message as Json), content } };
}

/** One entry, cleaned. null = drop it. */
function cleanEntry(e: Json, stats: RebaseStats): Json | null {
  if (e.type === 'system') {
    if (e.subtype === 'compact_boundary') stats.compactions += 1;
    else stats.plumbing += 1;
    return null;
  }
  if (e.type === 'attachment') {
    const a = isObj(e.attachment) ? e.attachment : {};
    const kind = typeof a.type === 'string' ? a.type : 'unknown';
    if (!KEPT_ATTACHMENTS.has(kind)) {
      stats.attachments[kind] = (stats.attachments[kind] ?? 0) + 1;
      return null;
    }
    if (kind === 'queued_command' && typeof a.prompt === 'string') {
      const prompt = cleanUserText(a.prompt, stats);
      if (!prompt) return null;
      if (prompt === a.prompt) return e;
      // The pre-rendered copy would still say what the prompt used to; the
      // harness renders from `attachment` when it is absent, as it does for
      // every entry written before `rendered` existed.
      const { rendered: _r, renderedRole: _rr, renderedInHumanTurn: _rh, ...rest } = e;
      return { ...rest, attachment: { ...a, prompt } };
    }
    return e;
  }
  if (e.type === 'assistant') return e;
  if (e.type !== 'user') return null;

  if (e.isCompactSummary === true) {
    stats.compactions += 1;
    return null;
  }
  const content = contentOf(e);
  if (typeof content === 'string') {
    const text = cleanUserText(content, stats);
    return text ? withContent(e, text) : null;
  }
  if (!Array.isArray(content)) return null;
  const blocks: unknown[] = [];
  for (const b of content) {
    if (isObj(b) && b.type === 'text' && typeof b.text === 'string') {
      const text = cleanUserText(b.text, stats);
      if (text) blocks.push(text === b.text ? b : { ...b, text });
    } else if (isObj(b) && b.type === 'tool_result') {
      blocks.push({ ...b, content: cleanToolResultContent(b.content, stats) });
    } else {
      blocks.push(b);
    }
  }
  return blocks.length ? withContent(e, blocks) : null;
}

// ── reading a transcript that does not fit in a string ─────────────────────

/**
 * Random access to a transcript's lines.
 *
 * NOT a string, because the chats that most need a rebase do not fit in one: a
 * live transcript on this machine is 604 MB, past V8's 512 MB string ceiling,
 * and `readFileSync(path, 'utf8')` throws on it. So the file is scanned in
 * chunks once to learn its shape, and only the lines that matter are ever
 * decoded again.
 */
export interface LineSource {
  size: number;
  read(start: number, end: number): Buffer;
}

export function bufferSource(buf: Buffer): LineSource {
  return { size: buf.length, read: (s, e) => buf.subarray(s, e) };
}

export function fileSource(fd: number, size: number): LineSource {
  return {
    size,
    read(s, e) {
      const b = Buffer.allocUnsafe(e - s);
      let off = 0;
      while (off < b.length) {
        const n = readSync(fd, b, off, b.length - off, s + off);
        if (n <= 0) break;
        off += n;
      }
      return b.subarray(0, off);
    },
  };
}

const CHUNK = 16 * 1024 * 1024;

/** Every non-blank line as [start, end) byte offsets, parsed. A line that is not
 *  JSON — a live transcript's last line is routinely half-written — is skipped. */
function scanLines(
  src: LineSource,
  each: (o: Json, start: number, end: number) => void,
  chunk = CHUNK,
): void {
  let carry: Buffer = Buffer.alloc(0);
  let carryStart = 0;
  for (let pos = 0; pos < src.size; pos += chunk) {
    const piece = src.read(pos, Math.min(src.size, pos + chunk));
    const buf = carry.length ? Buffer.concat([carry, piece]) : piece;
    const base = carry.length ? carryStart : pos;
    let from = 0;
    for (let nl = buf.indexOf(10, from); nl >= 0; nl = buf.indexOf(10, from)) {
      emit(buf, from, nl, base);
      from = nl + 1;
    }
    carry = Buffer.from(buf.subarray(from));
    carryStart = base + from;
  }
  if (carry.length) emit(carry, 0, carry.length, carryStart);

  function emit(buf: Buffer, s: number, e: number, base: number): void {
    if (e - s < 2) return;
    let o: unknown;
    try {
      o = JSON.parse(buf.toString('utf8', s, e));
    } catch {
      return;
    }
    if (isObj(o)) each(o, base + s, base + e);
  }
}

function readEntry(src: LineSource, s: Skel): Json {
  return JSON.parse(src.read(s.start, s.end).toString('utf8')) as Json;
}

// ── the chain ──────────────────────────────────────────────────────────────

/** What the first pass keeps of an entry: its links and tool ids, never its
 *  content — so a 600 MB transcript costs megabytes, not gigabytes. */
interface Skel {
  start: number;
  end: number;
  uuid: string;
  parent: string | null;
  /** A compaction boundary's pointer to the turns it hid. */
  logical: string | null;
  type: string;
  ts: string;
  uses: string[];
  results: string[];
  msgId: string | null;
}

function toolUseIds(e: Json): string[] {
  const c = contentOf(e);
  if (e.type !== 'assistant' || !Array.isArray(c)) return [];
  return c
    .filter((b) => isObj(b) && b.type === 'tool_use' && typeof b.id === 'string')
    .map((b) => (b as Json).id as string);
}

function toolResultIds(e: Json): string[] {
  const c = contentOf(e);
  if (e.type !== 'user' || !Array.isArray(c)) return [];
  return c
    .filter((b) => isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map((b) => (b as Json).tool_use_id as string);
}

/** The API message an assistant entry belongs to. Claude Code writes one entry
 *  per content block, so several entries share one `message.id`. */
function messageId(e: Json): string | null {
  return isObj(e.message) && typeof e.message.id === 'string' ? e.message.id : null;
}

/**
 * The live conversation, oldest first, with every compaction undone.
 *
 * Walks from the newest entry back along `parentUuid`. A `compact_boundary`
 * has no parent — that is how a compaction hides the turns before it — but it
 * names them in `logicalParentUuid`, and following that is the whole trick.
 * Everything not on this walk is a branch nobody is on (a rewind, an edit) or
 * bookkeeping, and is not carried over.
 *
 * WALK ORDER, NEVER FILE ORDER. The harness re-appends whole stretches of old
 * history to the same file — 15,243 duplicated uuids in the 604 MB transcript,
 * in four blocks of ~4,000 lines, differing only in `gitBranch`/`slug`. File
 * position therefore says nothing about when an entry happened; the parent
 * links do. The last copy of a uuid wins, as it does in the harness.
 */
function liveChain(copies: Map<string, Skel[]>, leaf: Skel, stats: RebaseStats): Skel[] {
  // The copy of `uuid` that was current when `before` was written: the last one
  // written before it. See WALK ORDER above — after a compaction the harness
  // re-appends the turns it preserved, RE-PARENTED onto the summary, so the
  // newest copy of the boundary's logical parent is AFTER the boundary and
  // leads straight back to it. Taking the newest copy blindly is a cycle; it
  // was, on the 604 MB transcript, 9,771 entries in and 33 compactions short.
  const resolve = (uuid: string, before: number): Skel | undefined => {
    const all = copies.get(uuid);
    if (!all) return undefined;
    for (let i = all.length - 1; i >= 0; i--) if ((all[i] as Skel).start < before) return all[i];
    return all[all.length - 1];
  };
  const chain: Skel[] = [];
  const on = new Set<string>();
  const visited = new Set<Skel>();
  let cur: Skel | undefined = leaf;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    // A preserved turn is met twice — its re-appended copy after the boundary,
    // then the original before it. The one nearer the leaf is kept; the walk
    // carries on through the original, because that is the way back.
    if (!on.has(cur.uuid)) {
      on.add(cur.uuid);
      chain.push(cur);
    }
    const next: string | null = cur.parent ?? cur.logical;
    if (!next) break;
    const from: number = cur.start;
    cur = resolve(next, from);
    if (!cur) stats.danglingSource += 1;
  }
  chain.reverse();

  // PARALLEL TOOL CALLS FORK THE CHAIN. One assistant message with two
  // tool_uses is written as two entries, the second a child of the first — and
  // the FIRST call's result is a child of the first entry: a sibling branch the
  // walk never visits. The harness stitches it back in on load, and so must
  // this, or every parallel call becomes an orphan tool_use. Measured: two in an
  // 8 MB transcript, which would have been two API errors.
  const usesOn = new Set(chain.flatMap((s) => s.uses));
  const resultsOn = new Set(chain.flatMap((s) => s.results));
  const siblings = new Map<string, Skel[]>();
  for (const all of copies.values()) {
    const s = all[all.length - 1] as Skel;
    if (on.has(s.uuid) || s.type !== 'user' || !s.results.length) continue;
    if (!s.parent || !on.has(s.parent)) continue;
    if (!s.results.every((id) => usesOn.has(id) && !resultsOn.has(id))) continue;
    for (const id of s.results) resultsOn.add(id);
    siblings.set(s.parent, [...(siblings.get(s.parent) ?? []), s]);
  }
  if (!siblings.size) return chain;
  // Each goes where the results of its assistant message begin: after the last
  // entry of that message, before whatever follows it.
  const out: Skel[] = [];
  let pending: Skel[] = [];
  chain.forEach((s, i) => {
    out.push(s);
    const sib = siblings.get(s.uuid);
    if (sib) pending.push(...sib.sort((a, b) => a.start - b.start));
    const next = chain[i + 1];
    const sameMessage = next?.type === 'assistant' && s.msgId !== null && next.msgId === s.msgId;
    if (pending.length && !sameMessage) {
      out.push(...pending);
      pending = [];
    }
  });
  return out;
}

/**
 * Which tool calls may be replayed: exactly one use, exactly one result after
 * it, and no OTHER assistant message in between — the API wants the result in
 * the very next user turn. Anything else is an orphan, and an orphan on either
 * side is a hard 400 on replay. The commonest real one is the last entry of a
 * chat rebased mid-turn: a call whose result was never written.
 *
 * Decided on the skeleton, which is exact: cleaning never removes a tool block
 * and never removes an assistant entry.
 */
function soundToolIds(chain: Skel[]): Set<string> {
  const useAt = new Map<string, number[]>();
  const resultAt = new Map<string, number[]>();
  chain.forEach((s, i) => {
    for (const id of s.uses) useAt.set(id, [...(useAt.get(id) ?? []), i]);
    for (const id of s.results) resultAt.set(id, [...(resultAt.get(id) ?? []), i]);
  });
  const good = new Set<string>();
  for (const [id, us] of useAt) {
    const rs = resultAt.get(id);
    if (us.length !== 1 || rs?.length !== 1) continue;
    const u = us[0] as number;
    const r = rs[0] as number;
    if (r <= u) continue;
    const mid = (chain[u] as Skel).msgId;
    let adjacent = true;
    for (let k = u + 1; k < r; k++) {
      const between = chain[k] as Skel;
      if (between.type === 'assistant' && (mid === null || between.msgId !== mid)) {
        adjacent = false;
        break;
      }
    }
    if (adjacent) good.add(id);
  }
  return good;
}

/** An entry with its unsound tool blocks removed; null when nothing is left. */
function keepSoundTools(e: Json, good: Set<string>, stats: RebaseStats): Json | null {
  const c = contentOf(e);
  if (!Array.isArray(c) || (e.type !== 'assistant' && e.type !== 'user')) return e;
  const kept = c.filter((b) => {
    if (!isObj(b)) return true;
    if (e.type === 'assistant' && b.type === 'tool_use') {
      if (good.has(b.id as string)) return true;
      stats.orphanToolUses += 1;
      return false;
    }
    if (e.type === 'user' && b.type === 'tool_result') {
      if (good.has(b.tool_use_id as string)) return true;
      stats.orphanToolResults += 1;
      return false;
    }
    return true;
  });
  if (kept.length === c.length) return e;
  return kept.length ? withContent(e, kept) : null;
}

/** Where a person (or a schedule, or another chat) started a turn — the only
 *  places the history may be cut, because everything after one is whole turns
 *  and so no tool call can be separated from its result. */
function isTurnStart(e: Json): boolean {
  if (e.type !== 'user' || e.isMeta === true) return false;
  const c = contentOf(e);
  if (typeof c === 'string') return !isInterruptMarker(c);
  if (!Array.isArray(c)) return false;
  const hasText = c.some(
    (b) =>
      isObj(b) && b.type === 'text' && typeof b.text === 'string' && !isInterruptMarker(b.text),
  );
  return hasText && !c.some((b) => isObj(b) && b.type === 'tool_result');
}

// ── size ───────────────────────────────────────────────────────────────────

function charsOf(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + charsOf(x), 0);
  if (isObj(v)) {
    if (v.type === 'image' || v.type === 'document') return IMAGE_TOKENS * CHARS_PER_TOKEN;
    let n = 0;
    for (const x of Object.values(v)) n += charsOf(x);
    return n;
  }
  return 0;
}

/** What an entry costs in the window: its message content, or for an
 *  attachment, what it renders to. Metadata (cwd, uuids, toolUseResult) is
 *  never sent to the model and is not counted. */
export function entryTokens(e: Json): number {
  const body = e.type === 'attachment' ? (e.rendered ?? e.attachment) : contentOf(e);
  return Math.ceil(charsOf(body) / CHARS_PER_TOKEN) + 4;
}

/** The largest context an entry proves this session ran with. */
function contextSeen(e: Json): number {
  let max = 0;
  const u = isObj(e.message) && isObj(e.message.usage) ? e.message.usage : null;
  if (u) {
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    max = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
  }
  const pre = isObj(e.compactMetadata) ? e.compactMetadata.preTokens : undefined;
  return typeof pre === 'number' ? Math.max(max, pre) : max;
}

// ── plan & render ──────────────────────────────────────────────────────────

export function emptyStats(): RebaseStats {
  return {
    compactions: 0,
    muxpadBlocks: 0,
    reminders: 0,
    plumbing: 0,
    attachments: {},
    orphanToolUses: 0,
    orphanToolResults: 0,
    offChain: 0,
    danglingSource: 0,
  };
}

/**
 * Decide what the rebased transcript holds. Pure apart from reading `src`.
 *
 * Two passes. The first decodes every line once and keeps only links and tool
 * ids. The second walks the live chain NEWEST FIRST, cleaning as it goes and
 * holding entries only while they still fit the budget — the moment they stop
 * fitting, everything older is the span the briefing covers, and only its two
 * ends are decoded again.
 *
 * `budgetTokens` overrides the half-the-window rule (tests, and a caller that
 * knows the model better than the transcript does); `chunkBytes` exists so a
 * test can make lines straddle read boundaries.
 */
export function planTranscriptRebase(
  input: string | LineSource,
  opts: { budgetTokens?: number; chunkBytes?: number } = {},
): PlanResult {
  const src = typeof input === 'string' ? bufferSource(Buffer.from(input, 'utf8')) : input;
  const stats = emptyStats();
  const copies = new Map<string, Skel[]>();
  const hasChild = new Set<string>();
  let seen = 0;
  let maxContext = 0;
  scanLines(
    src,
    (o, start, end) => {
      seen += 1;
      maxContext = Math.max(maxContext, contextSeen(o));
      if (typeof o.uuid !== 'string' || !CHAIN_TYPES.has(String(o.type)) || o.isSidechain === true)
        return;
      const parent = typeof o.parentUuid === 'string' ? o.parentUuid : null;
      if (parent) hasChild.add(parent);
      const all = copies.get(o.uuid) ?? [];
      copies.set(o.uuid, all);
      all.push({
        start,
        end,
        uuid: o.uuid,
        parent,
        logical:
          o.subtype === 'compact_boundary' && typeof o.logicalParentUuid === 'string'
            ? o.logicalParentUuid
            : null,
        type: String(o.type),
        ts: typeof o.timestamp === 'string' ? o.timestamp : '',
        uses: toolUseIds(o),
        results: toolResultIds(o),
        msgId: messageId(o),
      });
    },
    opts.chunkBytes,
  );
  // The leaf is the newest entry nothing descends from. Not simply the last
  // line: a re-appended block of old history can end the file.
  let leaf: Skel | undefined;
  for (const all of copies.values()) {
    const s = all[all.length - 1] as Skel;
    if (hasChild.has(s.uuid)) continue;
    if (!leaf || s.ts > leaf.ts || (s.ts === leaf.ts && s.start > leaf.start)) leaf = s;
  }
  if (!leaf) return { ok: false, reason: 'empty', detail: 'the transcript has no conversation' };
  const chain = liveChain(copies, leaf, stats);
  stats.offChain = seen - chain.length;
  const good = soundToolIds(chain);

  const window = maxContext > SMALL_WINDOW ? LARGE_WINDOW : SMALL_WINDOW;
  const budget = opts.budgetTokens ?? Math.floor(window * BUDGET_FRACTION);

  // NEWEST FIRST. `held` is the suffix still within budget, newest first;
  // `older` the chain positions of everything cleaned that did not fit.
  const prepare = (s: Skel, st: RebaseStats = stats): Json | null => {
    const c = cleanEntry(readEntry(src, s), st);
    return c ? keepSoundTools(c, good, st) : null;
  };
  const held: Json[] = [];
  const heldCost: number[] = [];
  const older: Skel[] = [];
  let total = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = prepare(chain[i] as Skel);
    if (!e) continue;
    const cost = entryTokens(e);
    total += cost;
    if (total <= budget && !older.length) {
      held.push(e);
      heldCost.push(cost);
    } else {
      older.push(chain[i] as Skel);
    }
  }
  held.reverse();
  heldCost.reverse();
  older.reverse();

  // The first thing replayed has to be something the user side said.
  const firstTurn = (from: number) => {
    for (let i = from; i < held.length; i++) if (isTurnStart(held[i] as Json)) return i;
    return -1;
  };
  if (!older.length) {
    const first = firstTurn(0);
    if (first < 0) return { ok: false, reason: 'empty', detail: 'no user turn survives cleaning' };
    const kept = held.slice(first);
    const keptCost = heldCost.slice(first).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      plan: { kept, dropped: null, tokens: { total, kept: keptCost, budget, window }, stats },
    };
  }

  // It does not all fit. Keep the most recent WHOLE turns that fit beside the
  // briefing, starting at the earliest turn start that leaves room for it.
  let keptCost = heldCost.reduce((a, b) => a + b, 0);
  let cut = 0;
  while (
    cut < held.length &&
    (!isTurnStart(held[cut] as Json) || keptCost + BRIEFING_RESERVE > budget)
  ) {
    keptCost -= heldCost[cut] as number;
    cut += 1;
  }
  if (cut >= held.length) {
    return {
      ok: false,
      reason: 'last_turn_too_large',
      detail: `the most recent turn alone does not fit the ${budget}-token budget`,
    };
  }
  // The span the briefing covers: everything older, plus whatever of the held
  // suffix came before the cut. Only its ends are decoded (see rebase.ts).
  const spanSkels = older;
  const spanHeld = held.slice(0, cut);
  const count = spanSkels.length + spanHeld.length;
  const at = (i: number): string =>
    JSON.stringify(
      // A throwaway tally: these entries were already counted on the way in.
      i < spanSkels.length
        ? (prepare(spanSkels[i] as Skel, emptyStats()) ?? {})
        : spanHeld[i - spanSkels.length],
    );
  const idx =
    count <= HEAD_LINES + TAIL_LINES
      ? Array.from({ length: count }, (_, i) => i)
      : [
          ...Array.from({ length: HEAD_LINES }, (_, i) => i),
          ...Array.from({ length: TAIL_LINES }, (_, i) => count - TAIL_LINES + i),
        ];
  const ends = idx.map(at);
  return {
    ok: true,
    plan: {
      kept: held.slice(cut),
      dropped: { count, ends },
      tokens: { total, kept: keptCost, budget, window },
      stats,
    },
  };
}

/**
 * The new transcript, as JSONL. `briefing` is required exactly when the plan
 * dropped something — the older span must be represented, never silently lost.
 */
export function renderTranscriptRebase(
  plan: TranscriptPlan,
  sid: string,
  briefing: string | null,
  mint: () => string = randomUUID,
): string {
  if (plan.dropped && !briefing?.trim()) throw new Error('a cut history needs a briefing');
  const head = plan.kept[0] as Json;
  const lead: Json[] = plan.dropped
    ? [
        {
          type: 'user',
          message: { role: 'user', content: wrapHistory(briefing as string) },
          isSidechain: false,
          userType: head.userType ?? 'external',
          cwd: head.cwd,
          version: head.version,
          gitBranch: head.gitBranch,
          entrypoint: head.entrypoint,
          timestamp: head.timestamp,
        },
      ]
    : [];
  const remap = new Map<string, string>();
  let parent: string | null = null;
  const lines: string[] = [];
  for (const src of [...lead, ...plan.kept]) {
    const uuid = mint();
    if (typeof src.uuid === 'string') remap.set(src.uuid, uuid);
    const { logicalParentUuid: _l, sourceToolAssistantUUID: source, ...e } = src;
    // Points at the assistant entry that made the tool call — re-pointed at
    // its new uuid, or left off when that entry was not carried over.
    const to = typeof source === 'string' ? remap.get(source) : undefined;
    const out: Json = {
      ...e,
      parentUuid: parent,
      uuid,
      sessionId: sid,
      ...(to ? { sourceToolAssistantUUID: to } : {}),
    };
    lines.push(JSON.stringify(out));
    parent = uuid;
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Everything `claude --resume` and the API need to be true of a transcript.
 * [] = sound. Run on the exact bytes about to be written, so a bug anywhere
 * above surfaces as a refusal rather than as a chat that will not start.
 */
export function checkTranscript(jsonl: string, sid: string): string[] {
  const problems: string[] = [];
  const entries: Json[] = [];
  for (const [i, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      problems.push(`line ${i + 1} is not JSON`);
    }
  }
  if (!entries.length) return [...problems, 'empty transcript'];
  if (entries[0]?.type !== 'user') problems.push('first entry is not a user turn');
  const uuids = new Set<string>();
  let prev: string | null = null;
  entries.forEach((e, i) => {
    if (e.sessionId !== sid) problems.push(`entry ${i} has sessionId ${String(e.sessionId)}`);
    if (typeof e.uuid !== 'string' || uuids.has(e.uuid))
      problems.push(`entry ${i} uuid missing or repeated`);
    if (e.parentUuid !== prev)
      problems.push(`entry ${i} parent does not link to the entry before it`);
    if (typeof e.timestamp !== 'string') problems.push(`entry ${i} has no timestamp`);
    if (!CHAIN_TYPES.has(String(e.type))) problems.push(`entry ${i} has type ${String(e.type)}`);
    uuids.add(e.uuid as string);
    prev = e.uuid as string;
  });
  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  entries.forEach((e, i) => {
    for (const id of toolUseIds(e)) {
      if (uses.has(id)) problems.push(`tool_use ${id} appears twice`);
      uses.set(id, i);
    }
    for (const id of toolResultIds(e)) {
      if (results.has(id)) problems.push(`tool_result ${id} appears twice`);
      results.set(id, i);
    }
  });
  for (const [id, u] of uses) {
    const r = results.get(id);
    if (r === undefined) {
      problems.push(`tool_use ${id} has no tool_result`);
      continue;
    }
    if (r < u) problems.push(`tool_result ${id} comes before its tool_use`);
    const mid = messageId(entries[u] as Json);
    for (let k = u + 1; k < r; k++) {
      const b = entries[k] as Json;
      if (b.type === 'assistant' && (mid === null || messageId(b) !== mid)) {
        problems.push(`tool_result ${id} is not in the turn right after its tool_use`);
        break;
      }
    }
  }
  for (const id of results.keys())
    if (!uses.has(id)) problems.push(`tool_result ${id} has no tool_use`);
  for (const e of entries) {
    const c = contentOf(e);
    const texts =
      e.type !== 'user'
        ? []
        : typeof c === 'string'
          ? [c]
          : Array.isArray(c)
            ? c.filter((b) => isObj(b) && b.type === 'text').map((b) => String((b as Json).text))
            : [];
    for (const t of texts) {
      if (isCompactionText(t)) problems.push('a compaction summary survived');
      const m = t.match(LEADING_MUXPAD);
      if (m && m[1] !== 'muxpad-history') problems.push(`a <${m[1]}> block survived`);
      if (LEADING_REMINDER.test(t) || TRAILING_REMINDER.test(t))
        problems.push('a <system-reminder> survived');
    }
  }
  return problems;
}

// ── the side-effecting part ────────────────────────────────────────────────

export type TranscriptRebaseResult =
  | {
      ok: true;
      sid: string;
      path: string;
      /** Entries replayed verbatim, and whether an older span was briefed. */
      kept: number;
      briefed: boolean;
      tokens: TranscriptPlan['tokens'];
      stats: RebaseStats;
    }
  | {
      ok: false;
      reason:
        | 'no_session'
        | 'elsewhere'
        | 'absent'
        | 'not_claude'
        | 'unreadable'
        | 'empty'
        | 'last_turn_too_large'
        | 'no_briefing'
        | 'integrity'
        | 'write_failed';
      detail: string;
    };

export interface TranscriptRebaseDeps {
  /** Injected in tests; defaults to the model call in rebase.ts. */
  brief?: (corpus: RebaseCorpus) => Promise<string | null>;
  budgetTokens?: number;
  mintSid?: () => string;
}

/**
 * Produce the rebased transcript on disk and say where it is — or refuse.
 *
 * Touches nothing but ONE new file, written next to the original (the harness
 * looks a session up in the project directory of its cwd, which is that one),
 * via a temp name and a rename so a half-written transcript can never be
 * resumed. The caller decides whether to point the pane at it, and deletes it
 * with {@link discardRebasedTranscript} if it does not.
 *
 * Refuses, rather than degrading:
 *   elsewhere  · the pane runs on another machine; its transcript is not ours
 *   not_claude · codex/cursor transcripts are muxpad's own normalised log, not
 *                a file their harness can resume from
 *   last_turn_too_large · one turn bigger than the budget cannot be kept whole
 *   integrity  · the output failed {@link checkTranscript}
 */
export async function transcriptRebase(
  db: Database.Database,
  paneId: string,
  deps: TranscriptRebaseDeps = {},
): Promise<TranscriptRebaseResult> {
  const sess = new AgentSessionStore(db).getByPane(paneId);
  const oldSid = sess?.current_sid;
  if (!sess || !oldSid) {
    return { ok: false, reason: 'no_session', detail: 'this chat has no session yet' };
  }
  const access = transcriptForPane(db, paneId, oldSid, sess.assistant);
  if (access.kind === 'elsewhere') {
    return {
      ok: false,
      reason: 'elsewhere',
      detail: `this chat runs on ${access.nodeId}; it has to be rebased there`,
    };
  }
  if (sess.assistant !== 'claude') {
    return {
      ok: false,
      reason: 'not_claude',
      detail: `a ${sess.assistant} transcript cannot be replayed`,
    };
  }
  if (access.kind !== 'local')
    return { ok: false, reason: 'absent', detail: 'no transcript on disk' };

  let planned: PlanResult;
  let fd: number | null = null;
  try {
    fd = openSync(access.path, 'r');
    planned = planTranscriptRebase(
      fileSource(fd, fstatSync(fd).size),
      deps.budgetTokens ? { budgetTokens: deps.budgetTokens } : {},
    );
  } catch (e) {
    return { ok: false, reason: 'unreadable', detail: (e as Error).message };
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (!planned.ok) return planned;
  const { plan } = planned;

  let briefing: string | null = null;
  if (plan.dropped) {
    // The briefing covers ONLY the span being dropped, read through the same
    // corpus code as a briefing-only rebase — one sampler, one "leave the
    // tools out" prompt.
    const corpus = {
      ...rebaseCorpusOfLines(plan.dropped.ends, 'claude', plan.dropped.count),
      continues: true,
    };
    briefing = await (deps.brief ?? writeBriefing)(corpus);
    if (!briefing?.trim()) {
      return {
        ok: false,
        reason: 'no_briefing',
        detail: 'could not brief the part of the chat too old to replay',
      };
    }
    if (corpus.title) briefing = `Ongoing thread: ${corpus.title}\n\n${briefing.trim()}`;
  }

  const sid = (deps.mintSid ?? randomUUID)();
  const jsonl = renderTranscriptRebase(plan, sid, briefing);
  const problems = checkTranscript(jsonl, sid);
  if (problems.length) {
    return { ok: false, reason: 'integrity', detail: problems.slice(0, 5).join('; ') };
  }

  const path = join(dirname(access.path), `${sid}.jsonl`);
  const tmp = `${path}.rebase-tmp`;
  try {
    // `wx`: never overwrite — a sid collision is a bug, not a thing to paper over.
    const out = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(out, jsonl);
    } finally {
      closeSync(out);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    return { ok: false, reason: 'write_failed', detail: (e as Error).message };
  }
  return {
    ok: true,
    sid,
    path,
    kept: plan.kept.length,
    briefed: !!plan.dropped,
    tokens: plan.tokens,
    stats: plan.stats,
  };
}

/** Undo {@link transcriptRebase} when the pane could not be moved onto it. */
export function discardRebasedTranscript(path: string): void {
  rmSync(path, { force: true });
}
