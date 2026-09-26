import type { ChatClock } from '@muxpad/shared';
import { type ArchiveSearchHit, req } from '../api';
import type { ChatChipChat } from '../components/ChatChip';
import {
  type SearchableTab,
  type WorkspaceTabs,
  paneIndex,
  rankTabs,
  toSearchableTabs,
} from './nav-search';

/**
 * The `@` mention — one gesture that collapses three things.
 *
 * Typing `@` in the composer opens a picker over EVERY chat, live and done, and
 * what you do with the one you pick is decided by what you type around it:
 *
 *   1. `@Investing` alone            → a REFERENCE. The message is yours, sent
 *                                      to this chat, and the mention renders as
 *                                      a chip you can click to go there.
 *   2. `@Investing what's the cash?` → a DIRECTION. The text goes to THAT
 *                                      chat's agent instead of this one's, and
 *                                      it reports back here as a card.
 *   3. typing anything after the `@`  → a SEARCH. Names, headlines and
 *                                      workspaces match locally; what was
 *                                      actually SAID matches through the
 *                                      archive's FTS5 index (`GET /api/search`),
 *                                      which already indexes every session ever
 *                                      run on this machine. No index is built
 *                                      here, and none should be.
 *
 * Everything in this file is pure except `directTo`, which is one POST. The
 * grammar lives here rather than in the component because all three readings
 * above are the SAME parse, and a hand-kept second copy of it in the composer
 * is how "@name" starts meaning different things in the draft and in the log.
 *
 * ── The token is the chat's NAME, verbatim ───────────────────────────────────
 * `@Tom camping solo`, not `@tom-camping-solo` and not `@[Tom camping solo]`.
 * Tab slugs are random short ids (TabStore.uniqueSlug), so a slug token would
 * be unreadable in the draft the user is looking at; a bracket form is a
 * grammar to learn. Resolution is therefore CORPUS-DRIVEN, not grammatical:
 * a token is whatever known chat name follows the `@`, longest first, so
 * "@Main repo" resolves to "Main repo" and never to "Main". The price is that
 * an unknown `@word` is just text — which is the correct degradation, and the
 * same one the prototype shipped.
 */

/** A chat, as the picker and the chip need it. Superset of `SearchableTab`. */
export interface MentionChat extends SearchableTab {
  /**
   * Past its clock — the `done` group in the sidebar. Computed SERVER-side and
   * published on the tab row (territory A); read as optional here because this
   * file must keep working against a server that predates the column, and
   * because a chat with no clock (pinned) is never done.
   */
  done?: boolean | undefined;
  /**
   * WHY it is done, when it is. The picker says this out loud for a reason:
   * after the amendment a sub-chat leaves the live list the moment it delivers,
   * so `@` is one of the two ways back to it (the other is its card), and
   * "delivered" is the word that tells you this row is a RESULT rather than
   * something you abandoned.
   */
  doneReason?: 'decayed' | 'delivered' | 'archived' | undefined;
  /**
   * The chat this one was spawned under, resolved to a NAME within the corpus.
   *
   * A delivered sub-chat is usually named after its task ("Work review"), and
   * there may be several of them; whose work it was is the thing that tells them
   * apart. Absent when the parent is not in the corpus — a dangling `spawned_by`
   * is an expected state (nothing is ever deleted, but nothing is cascaded
   * either), and the honest reading of it is "a root in its own right".
   */
  parentName?: string | undefined;
  /**
   * What `ChatChip` (and `chatTooltip`) need off this chat, built ONCE here.
   *
   * The chip is territory B's component and its prop shape is deliberately
   * structural, not `Tab` — so the translation from a wire row to chip material
   * happens at corpus time, in one place, rather than inline at each of the
   * three surfaces that draw a chip (picker row, inline mention, report card).
   */
  chip: ChatChipChat & { headline?: string | null };
}

/** The lifecycle fields territory A publishes on the tab row. */
type TabWithLifecycle = {
  done?: boolean | null;
  done_reason?: 'decayed' | 'delivered' | 'archived' | null;
  spawned_by?: string | null;
  /** Present-but-NULL means there is no clock at all — see toMentionChats. */
  clock?: ChatClock | null;
};

/**
 * The picker's corpus: every chat in every visible workspace, live and done.
 *
 * Built on `toSearchableTabs` so the `@` picker and the sidebar's search box
 * rank the same fields off the same rows — the whole point of the feature is
 * that this eventually REPLACES that box, and two corpora would mean two
 * answers to "which chats are there".
 */
export function toMentionChats(groups: readonly WorkspaceTabs[]): MentionChat[] {
  const rows = new Map<string, TabWithLifecycle>();
  for (const g of groups) {
    for (const t of g.tabs) rows.set(t.id, t as TabWithLifecycle);
  }
  const names = new Map<string, string>();
  for (const g of groups) {
    for (const t of g.tabs) names.set(t.id, t.name);
  }
  return toSearchableTabs(groups).map((t) => {
    const row = rows.get(t.tabId);
    const done = row?.done === true;
    const reason = row?.done_reason ?? undefined;
    const parentName = row?.spawned_by ? names.get(row.spawned_by) : undefined;
    return {
      ...t,
      ...(done ? { done: true } : {}),
      ...(reason ? { doneReason: reason } : {}),
      ...(parentName ? { parentName } : {}),
      chip: {
        name: t.tabName,
        icon: t.icon ?? null,
        ...(t.pinned ? { pinned: true } : {}),
        ...(done ? { done: true } : {}),
        ...(row?.spawned_by ? { spawned_by: row.spawned_by } : {}),
        // The clock is passed through EXACTLY as published, and it is the only
        // time input the chip has. The chip quantises the fill for the tile and
        // reads `stopped`/`last_day`/`done` off the row; lifecycle is the
        // server's, start to finish.
        //
        // There is nothing to guard against here any more. This used to also
        // pass `last_activity_at` for "rows that predate the column", carefully
        // withheld when `clock` was explicitly null — a guard that existed only
        // because the chip carried a fallback that re-derived the decay rules
        // client-side. B deleted the fallback; the guard went with it.
        ...(row?.clock ? { clock: row.clock } : {}),
        ...(t.headline ? { headline: t.headline } : {}),
      },
    };
  });
}

// ── The run under the caret ──────────────────────────────────────────────────

/** An active `@…` run in the draft: where it is, and what it is asking for. */
export interface MentionRun {
  /** Index of the `@`. */
  start: number;
  /** End of the run — always the caret, so the query is what's behind it. */
  end: number;
  /** Text between the `@` and the caret. May contain spaces (names do). */
  query: string;
}

/**
 * How long a run is allowed to get before it stops being a mention.
 *
 * Spaces are legal in the query — chat names have them, and so do the phrases
 * the content tier is good at ("cash position"). The cost of that is that a `@`
 * typed in ordinary prose would otherwise keep a picker open over the rest of
 * the paragraph, so the run is capped. Sized well past the longest tab name in
 * the user's tree (~40 chars) and past a useful search phrase.
 */
export const MENTION_QUERY_MAX = 64;

/** Characters that may sit immediately before a `@` for it to open a picker. */
const MENTION_BOUNDARY = /[\s([{"'—–-]/;

/**
 * The `@…` run the caret is inside, or null.
 *
 * Deliberately NOT anchored to the end of the draft: editing a mention in the
 * middle of a sentence must reopen the picker, and the caret is what says which
 * run is being edited. The run closes — returns null — on a newline, a second
 * `@`, an email-looking `a@b`, or past `MENTION_QUERY_MAX`, so the picker is
 * never a thing you have to dismiss out of a paragraph that merely contains an
 * address.
 */
export function detectMentionRun(text: string, caret: number): MentionRun | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  const at = text.lastIndexOf('@', pos - 1);
  if (at < 0) return null;
  const before = at > 0 ? (text[at - 1] ?? '') : '';
  // `foo@bar.com` is an address, not a mention: a `@` only opens a picker at
  // the start of the draft or after whitespace/an opening bracket.
  if (at > 0 && !MENTION_BOUNDARY.test(before)) return null;
  const query = text.slice(at + 1, pos);
  if (query.length > MENTION_QUERY_MAX) return null;
  // A newline ends the run (the picker is about the line you are on), and a
  // second `@` means the earlier one is settled text.
  if (/[\n\r@]/.test(query)) return null;
  return { start: at, end: pos, query };
}

/**
 * Is this run a mention the user has already FINISHED choosing?
 *
 * `@Investing what's the cash position` is one run by the grammar above — the
 * query is allowed to contain spaces because chat names do. So the corpus is
 * what closes the picker: once the run starts with a known chat name followed by
 * whitespace, the choice is made and everything after it is the request. Without
 * this the picker would hover over the whole sentence you type next, and Enter
 * would re-pick the chat instead of sending.
 */
export function runIsSettled(query: string, corpus: readonly MentionChat[]): boolean {
  const lower = query.toLowerCase();
  return corpus.some((c) => {
    const name = c.tabName.toLowerCase();
    if (!name || lower.length <= name.length || !lower.startsWith(name)) return false;
    return /^\s/.test(query.slice(name.length));
  });
}

/**
 * The run the picker should be showing, given everything that can close it.
 *
 * All three closing conditions in one place, because "why is the picker still
 * up" is the question this feature gets wrong first:
 *   — no `@…` under the caret at all (detectMentionRun),
 *   — the name is chosen and spaced past, so the rest is the request
 *     (runIsSettled),
 *   — Escape was pressed on THIS run: `dismissedAt` is the offset of the `@` it
 *     was pressed on, so continuing to type does not bring it back, while a NEW
 *     `@` is a new invitation.
 */
export function nextMentionRun(
  text: string,
  caret: number,
  corpus: readonly MentionChat[],
  dismissedAt: number | null,
): MentionRun | null {
  const run = detectMentionRun(text, caret);
  if (!run) return null;
  if (runIsSettled(run.query, corpus)) return null;
  if (dismissedAt !== null && run.start === dismissedAt) return null;
  return run;
}

/**
 * A chat the user EXPLICITLY CHOSE, and where its token sits in the draft.
 *
 * ─── Why the token alone is not enough ───────────────────────────────────────
 * The token is the chat's NAME (see the note at the top of this file, and it is
 * still the right token — a slug would be unreadable in the draft the user is
 * looking at). But a name is DISPLAY TEXT: it is not unique, it is not stable,
 * and resolving it again at send time is a guess. Two ways that guess was wrong,
 * both reproduced:
 *
 *   · pick `Main`, type `repo status`, and the draft reads `@Main repo status` —
 *     which re-resolves, correctly by its own longest-name rule, to the chat
 *     called `Main repo`. No duplicate names needed.
 *   · two chats both called `Work review`; pick the second and the first gets
 *     the work, because it comes first in the corpus. The picker even shows the
 *     parent that tells them apart, and then throws it away.
 *
 * So a pick is REMEMBERED, by id, anchored to the `@` it was inserted at. The
 * text stays exactly what the user reads; the identity rides alongside it. A
 * pick that no longer matches the draft is dropped, not guessed at — see
 * `repinPicks` — so this can only ever make resolution MORE specific than the
 * name-matching fallback, never differently wrong.
 */
export interface MentionPick {
  /** The chat that was chosen. The whole point: an id, not a display name. */
  tabId: string;
  /** The name as INSERTED. What the anchor is re-found by, and how many
   *  characters the body starts after — the chat may have been renamed since. */
  name: string;
  /** Offset of the `@` this pick belongs to. */
  start: number;
}

/**
 * Replace a run with the canonical token for `chat`, plus one trailing space.
 *
 * Returns the new draft, where the caret goes, AND the pick — because the caller
 * has to set all of them in the same commit. The caret: a textarea whose value
 * changed without its selection puts the caret at the end, which after picking a
 * mention in the middle of a sentence is the wrong place by however much you had
 * written. The pick: see `MentionPick`.
 */
export function applyMention(
  text: string,
  run: MentionRun,
  chat: MentionChat,
): { text: string; caret: number; pick: MentionPick } {
  // One space after the token, and never two: picking a mention in the middle of
  // a sentence must not leave a gap the user has to go back and delete.
  const followedBySpace = /^[ \t]/.test(text.slice(run.end));
  const token = followedBySpace ? `@${chat.tabName}` : `@${chat.tabName} `;
  const next = text.slice(0, run.start) + token + text.slice(run.end);
  // Caret past the space either way, so typing continues the request.
  return {
    text: next,
    caret: run.start + token.length + (followedBySpace ? 1 : 0),
    pick: { tabId: chat.tabId, name: chat.tabName, start: run.start },
  };
}

/**
 * Re-anchor picks against the draft as it is NOW, dropping the ones that are gone.
 *
 * A draft is edited freely after a mention is picked: text is typed in front of
 * the token (every offset shifts), the token is deleted (the pick is void), the
 * same chat is picked twice (two anchors, one name). So an offset recorded at
 * pick time is a hint, not a fact, and this is the one place that reconciles it.
 *
 * TWO PASSES, and the order matters: every pick that still sits exactly where it
 * was claims its position first, and only then do the displaced ones look for a
 * free occurrence of their token. One pass would let a displaced pick steal the
 * anchor of a pick that never moved, which for two same-named chats is the very
 * confusion this whole mechanism exists to remove.
 *
 * Pure, and total: what it returns always describes the text it was handed.
 */
export function repinPicks(text: string, picks: readonly MentionPick[]): MentionPick[] {
  const lower = text.toLowerCase();
  const claimed = new Set<number>();
  const held: MentionPick[] = [];
  const adrift: MentionPick[] = [];
  for (const p of picks) {
    const name = p.name.toLowerCase();
    if (!name) continue;
    if (!claimed.has(p.start) && tokenAt(lower, p.start, name)) {
      claimed.add(p.start);
      held.push(p);
    } else adrift.push(p);
  }
  for (const p of adrift) {
    const name = p.name.toLowerCase();
    let at = -1;
    for (let i = lower.indexOf(`@${name}`); i >= 0; i = lower.indexOf(`@${name}`, i + 1)) {
      if (claimed.has(i) || !tokenAt(lower, i, name)) continue;
      at = i;
      break;
    }
    // The token is gone from the draft, so the choice it recorded is gone too.
    // Dropping it falls back to name resolution, which is the honest answer.
    if (at < 0) continue;
    claimed.add(at);
    held.push({ ...p, start: at });
  }
  return held.sort((a, b) => a.start - b.start);
}

// ── Resolution: a token back to a chat ───────────────────────────────────────

/**
 * Chats whose `@Name` token appears in `text`, longest name first.
 *
 * Longest-first is the disambiguation rule and it is load-bearing: "Main" is a
 * prefix of "Main repo", and matching the short one would send work to the
 * wrong chat while LOOKING right in the draft.
 *
 * The tie-break on `tabId` is not cosmetic. Two chats may share a name, and the
 * sort was otherwise stable on the CORPUS ORDER — which is the sidebar's order,
 * which moves with activity. So the same `@Work review` in a message already
 * sent resolved to one chat this morning and the other one this afternoon.
 * Identity for a NEW mention is carried properly by `MentionPick`; this is what
 * makes the fallback — text that was written before any of that, or by hand —
 * at least answer the same way every time.
 */
function byNameLength(corpus: readonly MentionChat[]): MentionChat[] {
  return [...corpus].sort(
    (a, b) => b.tabName.length - a.tabName.length || a.tabId.localeCompare(b.tabId),
  );
}

/** Does `@name` sit at `i` in `text`, as a whole token? */
function tokenAt(text: string, i: number, name: string): boolean {
  if (!text.startsWith(`@${name}`, i)) return false;
  // The character after the name must not be a word character, or `@Main` would
  // match inside `@Mainframe` — which `byNameLength` only protects against for
  // names we KNOW about.
  const after = text[i + 1 + name.length] ?? '';
  return after === '' || !/[\p{L}\p{N}]/u.test(after);
}

/** One segment of a message: prose, or a resolved mention. */
export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; chat: MentionChat };

/**
 * Split `text` into prose and mentions, for rendering chips inline.
 *
 * Case-INSENSITIVE on the name (the user may have typed the mention by hand)
 * but the segment keeps the text as written, so nothing the user typed is
 * rewritten by the renderer.
 */
export function parseMentions(text: string, corpus: readonly MentionChat[]): MentionSegment[] {
  if (!text.includes('@') || corpus.length === 0) return [{ kind: 'text', text }];
  const ordered = byNameLength(corpus);
  const lower = text.toLowerCase();
  const out: MentionSegment[] = [];
  let plain = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === '@') {
      const hit = ordered.find((c) => c.tabName && tokenAt(lower, i, c.tabName.toLowerCase()));
      if (hit) {
        if (plain) {
          out.push({ kind: 'text', text: plain });
          plain = '';
        }
        const raw = text.slice(i, i + 1 + hit.tabName.length);
        out.push({ kind: 'mention', text: raw, chat: hit });
        i += raw.length;
        continue;
      }
    }
    plain += text[i];
    i += 1;
  }
  if (plain) out.push({ kind: 'text', text: plain });
  return out;
}

/** A leading `@Name` plus the work that follows it — the DIRECTION reading. */
export interface Directive {
  target: MentionChat;
  /** What to ask the other chat. Never empty (an empty body is a reference). */
  body: string;
}

/**
 * Read `text` as a direction to another chat, or null.
 *
 * Only a LEADING mention directs work. A mention in the middle of a sentence is
 * a reference — "ask @Investing about this later" is a note to self, and
 * routing it away from the chat the user was typing in would be the single
 * worst thing this feature could do. The rule is one the user can state, which
 * is the property that matters.
 *
 * ─── An explicit choice outranks re-reading the text ─────────────────────────
 * `picks` is what the user actually SELECTED in the picker (see `MentionPick`).
 * When one is anchored to this leading `@` and its token still matches, that
 * chat receives the work — full stop. Re-resolving by name is the FALLBACK, for
 * a mention typed by hand or restored from a draft written before the pick was
 * recorded; it is not a second opinion about a choice already made.
 *
 * `text` should be passed UNTRIMMED: a pick's anchor is an offset into the
 * draft, and trimming it first shifts every offset by the leading whitespace.
 * The body is trimmed here either way, so nothing else changes.
 */
export function parseDirective(
  text: string,
  corpus: readonly MentionChat[],
  picks: readonly MentionPick[] = [],
): Directive | null {
  const lead = text.length - text.trimStart().length;
  const trimmed = text.slice(lead);
  if (!trimmed.startsWith('@')) return null;
  const lower = trimmed.toLowerCase();
  // The chat the user pointed at, if they pointed at this `@` and the token they
  // were given is still the one in the draft.
  const picked = picks.find(
    (p) => p.start === lead && p.name && tokenAt(lower, 0, p.name.toLowerCase()),
  );
  const chosen = picked ? corpus.find((c) => c.tabId === picked.tabId) : undefined;
  const target =
    chosen ??
    byNameLength(corpus).find((c) => c.tabName && tokenAt(lower, 0, c.tabName.toLowerCase()));
  if (!target) return null;
  // How far the body starts after the `@` is a fact about the TEXT, so it is the
  // token's length — which is the name as inserted, not the chat's name today.
  // A chat renamed after it was picked still gets the work, and the body is
  // still the body.
  const token = chosen && picked ? picked.name : target.tabName;
  const body = trimmed.slice(1 + token.length).trim();
  return body ? { target, body } : null;
}

// ── The markers ──────────────────────────────────────────────────────────────
//
// A directed message and its answer are REAL delivered messages: muxpad never
// writes an agent's transcript, it tails the file the harness owns. So each one
// carries a delimited block that is at once a genuine instruction to the agent
// receiving it ("this came from another chat") and the render hook this client
// keys on to draw a card instead of a wall of XML. Same shape, and the same
// reasoning, as the cron fire marker (shared/src/cron.ts) — read that first if
// you are changing this.

const DIRECT_OPEN = /^\s*<muxpad-direct\b([^>]*)>([\s\S]*?)<\/muxpad-direct>\s*/;
const REPORT_TAG = /^\s*<muxpad-report\b([^>]*)>/;
const REPORT_CLOSE = '</muxpad-report>';

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? (m[1] as string) : null;
}

/** Attribute values are interpolated into a `"`-quoted attribute. */
function esc(v: string): string {
  return v.replace(/[<>"&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&amp;',
  );
}

function unesc(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export interface DirectMarker {
  /** Correlates the report with the card the sending chat is already showing. */
  id: string;
  /** Name of the chat that asked, for the receiving agent to say out loud. */
  from: string;
  /** Pane of the chat that asked — where the report has to be sent back to. */
  pane: string;
  /** The chat RECEIVING this. Pre-filled into the report template it copies, so
   *  the answer identifies itself without the agent having to know its own
   *  chat's name (it doesn't, reliably). */
  to?: string | undefined;
  /** …and its pane, so a device with no local record of the request can still
   *  resolve which chat the report came from. */
  toPane?: string | undefined;
}

/**
 * Wrap a directed request with its marker AND the instruction that makes the
 * round trip actually happen.
 *
 * The report-back line is a CLI invocation on purpose. `muxpad agent send` is
 * already the supported way one session talks to another (it queues if the
 * target is mid-turn), it needs no new server surface, and an agent that can
 * run a command can run this one. What it must not do is improvise the marker:
 * the first line is quoted here verbatim so that `parseReportMarker` on the
 * other side is matching a string this file also wrote.
 */
export function renderDirectMarker(marker: DirectMarker, body: string): string {
  // Fully pre-filled: the receiving agent copies a line, it does not compose
  // one. Every attribute in it is something this side already knows, and an
  // agent asked to invent `from` would invent something wrong.
  const report = `<muxpad-report id="${esc(marker.id)}" from="${esc(
    marker.to ?? '',
  )}" pane="${esc(marker.toPane ?? '')}"></muxpad-report>`;
  // Line by line, joined: the exact shape of these lines is the contract with
  // the agent reading them, so they are worth being able to see.
  const note = [
    `Directed here from the muxpad chat "${marker.from}" — another chat's user, not this chat's.`,
    'Do the work in THIS chat, then report back once, in one message:',
    `  muxpad agent send ${marker.pane} '${report}`,
    "  <two or three sentences: what you did and what the answer is>'",
    'Nothing else is needed — the chat that asked renders that message as a card.',
  ].join('\n');
  return `<muxpad-direct id="${esc(marker.id)}" from="${esc(marker.from)}" pane="${esc(
    marker.pane,
  )}">\n${note}\n</muxpad-direct>\n\n${body}`;
}

/** Split a delivered directed message back into its marker and the request. */
export function parseDirectMarker(text: string): { marker: DirectMarker; body: string } | null {
  const m = text.match(DIRECT_OPEN);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const id = attr(attrs, 'id');
  const from = attr(attrs, 'from');
  const pane = attr(attrs, 'pane');
  if (!id || !from || !pane) return null;
  return {
    marker: { id, from: unesc(from), pane: unesc(pane) },
    body: text.slice(m[0].length),
  };
}

export interface ReportMarker {
  /** The directive this answers. Empty when the agent omitted it. */
  id: string;
  /** The chat that is answering. Empty when the agent dropped the attribute. */
  from: string;
  /** Its pane — the fallback way to resolve which chat that was. */
  pane: string;
}

/** The answer's marker — written by the OTHER agent, parsed here. */
export function renderReportMarker(marker: ReportMarker, body: string): string {
  return `<muxpad-report id="${esc(marker.id)}" from="${esc(marker.from)}" pane="${esc(
    marker.pane,
  )}"></muxpad-report>\n${body}`;
}

/**
 * Recognise a report coming back from a directed chat.
 *
 * TOLERANT BY CONSTRUCTION, and this is the half of the round trip that needs
 * it: the string was typed by ANOTHER agent from an instruction, so a missing
 * `id`, an attribute it invented, a closing tag it forgot, or the answer written
 * INSIDE the element instead of after it must all still render as a report. The
 * failure mode being avoided is a bubble of raw XML where a card should be. The
 * only hard requirement is a leading tag — text that merely mentions one
 * mid-message is ordinary prose (same rule as the cron marker).
 */
export function parseReportMarker(text: string): { marker: ReportMarker; body: string } | null {
  const m = text.match(REPORT_TAG);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const close = rest.indexOf(REPORT_CLOSE);
  const inner = close >= 0 ? rest.slice(0, close) : '';
  const after = close >= 0 ? rest.slice(close + REPORT_CLOSE.length) : rest;
  const attrs = m[1] ?? '';
  return {
    marker: {
      id: unesc(attr(attrs, 'id') ?? ''),
      from: unesc(attr(attrs, 'from') ?? ''),
      pane: unesc(attr(attrs, 'pane') ?? ''),
    },
    // After the tag is the form we asked for; inside it is the form a model
    // writes anyway. Prefer the first, fall back to the second, lose neither.
    body: after.trim() || inner.trim(),
  };
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Why a direction could not be delivered — shown to the user as a notice. */
export type DirectFailure =
  | { reason: 'no-pane'; message: string }
  | { reason: 'refused'; message: string };

export type DirectResult = { ok: true; paneId: string } | ({ ok: false } & DirectFailure);

/**
 * Deliver a directed request to another chat's agent.
 *
 * Goes through `POST /api/agent-sessions/:paneId/send` — the HTTP counterpart
 * of this pane's own socket `send` frame, which the CLI already uses. The server
 * owns the queue, so a target that is mid-turn is a normal success (it runs
 * next); a target whose runner is still booting answers 409, and that is the
 * one case worth putting in front of the user, because retrying works.
 *
 * A DONE chat with no live pane cannot be directed to. That is reported rather
 * than silently reviving it: reviving is the user's gesture (send it a message),
 * and doing it behind their back would make `@` a way to wake seventeen chats.
 */
export async function directTo(
  target: MentionChat,
  marker: DirectMarker,
  body: string,
): Promise<DirectResult> {
  const paneId = await agentPaneOf(target);
  if (!paneId) {
    return {
      ok: false,
      reason: 'no-pane',
      message: `${target.tabName} has no live agent — open it and send it a message first.`,
    };
  }
  const text = renderDirectMarker({ ...marker, to: target.tabName, toPane: paneId }, body);
  try {
    const res = await req<{ ok: boolean; reason?: string }>(
      `/api/agent-sessions/${encodeURIComponent(paneId)}/send`,
      { method: 'POST', body: JSON.stringify({ text }) },
    );
    if (res.ok) return { ok: true, paneId };
    return {
      ok: false,
      reason: 'refused',
      message: `${target.tabName} didn't take it (${res.reason ?? 'no reason given'}).`,
    };
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    // 409 is the documented "runner still booting" answer, and it is worth
    // saying in words the user can act on rather than as a status code.
    const message =
      status === 409
        ? `${target.tabName} is still starting up — try again in a moment.`
        : `Couldn't reach ${target.tabName}.`;
    return { ok: false, reason: 'refused', message };
  }
}

/**
 * Which of a chat's panes is its agent.
 *
 * Asks the agent-session registry per layout leaf, in layout order, and takes
 * the first that has one. Most chats have exactly one pane, so this is one
 * request; a split with a terminal beside the agent costs two. Deliberately not
 * `GET /api/agent-sessions` (the whole registry) — that is dozens of rows to
 * answer a question about one chat.
 */
async function agentPaneOf(target: MentionChat): Promise<string | null> {
  for (const paneId of target.paneIds) {
    try {
      await req<unknown>(`/api/agent-sessions/by-pane/${encodeURIComponent(paneId)}`);
      return paneId;
    } catch {
      // 404 = not an agent pane. Any other failure is treated the same way:
      // the next leaf gets a turn, and a chat with no answer at all is
      // reported as having no live agent, which is what the user sees anyway.
    }
  }
  return null;
}

// ── The picker's rows ────────────────────────────────────────────────────────

/** One row of the picker. `why` is the second column: state, or what matched. */
export interface MentionRow {
  chat: MentionChat;
  /** 'name' — matched the chat itself. 'content' — matched what was said in it. */
  via: 'name' | 'content';
  /** Range to highlight inside `chat.tabName`, when the name is what matched. */
  nameRange?: readonly [number, number] | undefined;
  /** FTS5 snippet (with `«»` marks) when `via === 'content'`. */
  snippet?: string | undefined;
}

/** How many rows the picker shows. Past this it stops being scannable. */
export const MAX_MENTION_ROWS = 8;

/**
 * Where a chat sits in the bare-`@` list: 0 = offer it, 1 = push it under.
 *
 * DONE IS NOT ONE THING any more. A decayed chat and an archived one both mean
 * "you are finished with this", and they belong under the live rows. A
 * DELIVERED sub-chat means the opposite: it just produced something, and it left
 * the live list for that reason rather than from neglect. Sinking it would make
 * the amendment's own case unreachable — a sub-chat retires the instant it
 * reports, and "the thing that just came back" is the likeliest row you want.
 * So it sorts by recency alongside the live chats, which is where it actually
 * ranks.
 */
function restingRank(c: MentionChat): number {
  if (!c.done) return 0;
  return c.doneReason === 'delivered' ? 0 : 1;
}

/**
 * Rank chats by name/headline/workspace — the instant tier, no network.
 *
 * An EMPTY query is a real query here, unlike the sidebar box: `@` on its own
 * has to offer something, or the gesture has no discoverable surface. It offers
 * the chats you'd most likely mean — live before done, most recently active
 * first — which is the sidebar's own resting order.
 */
export function rankMentions(
  corpus: readonly MentionChat[],
  query: string,
  opts: { excludeTabId?: string | undefined; limit?: number },
): MentionRow[] {
  const limit = opts.limit ?? MAX_MENTION_ROWS;
  const pool = corpus.filter((c) => c.tabId !== opts.excludeTabId);
  const q = query.trim();
  if (!q) {
    const resting = [...pool].sort((a, b) => {
      const da = restingRank(a);
      const db = restingRank(b);
      if (da !== db) return da - db;
      const la = a.lastActivityAt ?? Number.NEGATIVE_INFINITY;
      const lb = b.lastActivityAt ?? Number.NEGATIVE_INFINITY;
      if (la !== lb) return lb - la;
      return a.tabName.localeCompare(b.tabName);
    });
    return resting.slice(0, limit).map((chat) => ({ chat, via: 'name' as const }));
  }
  // `rankTabs` hands back the very rows it was given, so the cast recovers the
  // `done` flag the ranker has no opinion about rather than asserting anything.
  return rankTabs(pool, q, { limit }).map((m) => ({
    chat: m.tab as MentionChat,
    via: 'name' as const,
    ...(m.field === 'name' ? { nameRange: m.range } : {}),
  }));
}

/**
 * Append the content tier: chats where the QUERY WAS SAID, from the archive.
 *
 * Strictly below the name rows and never allowed to reorder them — the same
 * split the sidebar box makes, for the same reason. One row per chat: a name
 * row already on the list is not repeated with a snippet under it, and ten hits
 * inside one long chat is one place to go.
 */
export function withContentRows(
  nameRows: readonly MentionRow[],
  hits: readonly ArchiveSearchHit[],
  corpus: readonly MentionChat[],
  opts: { excludeTabId?: string | undefined; limit?: number },
): MentionRow[] {
  const limit = opts.limit ?? MAX_MENTION_ROWS;
  const rows = [...nameRows];
  if (rows.length >= limit) return rows.slice(0, limit);
  const panes = paneIndex(corpus);
  const byId = new Map(corpus.map((c) => [c.tabId, c]));
  const seen = new Set(rows.map((r) => r.chat.tabId));
  for (const hit of hits) {
    const paneId = hit.session?.pane_id;
    if (!paneId) continue;
    const found = panes.get(paneId);
    const chat = found ? byId.get(found.tabId) : undefined;
    // A hit whose pane belongs to no chat any more has nowhere to point.
    if (!chat) continue;
    if (chat.tabId === opts.excludeTabId) continue;
    if (seen.has(chat.tabId)) continue;
    seen.add(chat.tabId);
    rows.push({ chat, via: 'content', snippet: hit.snippet });
    if (rows.length >= limit) break;
  }
  return rows;
}

// ── The content tier's REQUEST ───────────────────────────────────────────────
//
// `withContentRows` above is what SURVIVES the archive's answer, and on a real
// archive most of it does not: the endpoint ranks messages across every session
// ever recorded on this machine, and this client then discards every hit whose
// pane is not a chat that still exists, every repeat from one chat, and the chat
// being typed in. Measured on the user's own archive: for `trayo`, 47 of the
// first 50 hits were unresolvable and one chat made the list, out of eight that
// have the word in them. A chat whose matching message ranks 51st was
// unreachable by that query while the picker sat with seven empty slots.
//
// The endpoint takes a limit and nothing else — no offset, and no way to say
// "only these panes" — so the client cannot page properly and cannot push the
// filter down. What it CAN do is ask for a bigger page when, and only when, the
// answer it got did not fill the list. That is the policy below, and it is
// deliberately a pure function so the paging can be tested without mounting a
// composer.

/** The first page. Small enough that the common query costs one cheap MATCH. */
export const MENTION_SEARCH_PAGE = 50;
/**
 * The last page, and it is the SERVER'S CAP (routes/search.ts clamps to 200) —
 * not a number chosen here. So this is the end of the line: a chat whose only
 * matching message ranks 201st cannot be reached through the content tier at
 * all, and no amount of client paging changes that. Closing that properly means
 * the endpoint filtering to a set of panes, or paging, and the endpoint is
 * another territory's. Recorded rather than hidden.
 */
export const MENTION_SEARCH_MAX = 200;
/** Below this the query is too broad to be worth an FTS5 MATCH. */
const MENTION_SEARCH_MIN_CHARS = 3;
/** The server rejects a longer `q` outright — its MATCH is synchronous. */
const MENTION_SEARCH_MAX_CHARS = 256;

/** Hits, and the query they are the answer to. */
export interface MentionSearchState {
  /** `''` when nothing has been searched yet. */
  query: string;
  /** The limit they were asked for — how we know whether there may be more. */
  limit: number;
  hits: readonly ArchiveSearchHit[];
}

export const NO_MENTION_SEARCH: MentionSearchState = { query: '', limit: 0, hits: [] };

/**
 * The hits that answer THIS query — and nothing else, ever.
 *
 * The ticket scheme in the composer stops a LATE response overwriting a newer
 * one. It does not, and cannot, stop the hits already in state from being shown
 * under a query they have nothing to do with: search `@cash`, take a content
 * result, replace the query with `@zebra`, and for the debounce plus a round
 * trip the picker said "matching zebra" over the cash row — selectable, and the
 * first thing Enter would take. Binding the hits to their query makes that
 * unrepresentable rather than something to remember to clear.
 */
export function hitsFor(state: MentionSearchState, query: string): readonly ArchiveSearchHit[] {
  const q = query.trim();
  return q !== '' && state.query === q ? state.hits : [];
}

/**
 * The limit to fetch for `query` next, or null for "ask the archive nothing".
 *
 * Three answers in one place: don't search, search the first page, or go back
 * for the big page because what came back did not fill the list.
 */
export function nextSearchLimit(opts: {
  query: string;
  state: MentionSearchState;
  /** Rows the picker can already show, AFTER resolution and dedup. */
  rows: number;
  /** Rows it has room for. */
  want: number;
  /** False once /api/search has 404ed — an older server with no archive. */
  archiveAvailable: boolean;
}): number | null {
  const q = opts.query.trim();
  if (!opts.archiveAvailable) return null;
  if (q.length < MENTION_SEARCH_MIN_CHARS || q.length > MENTION_SEARCH_MAX_CHARS) return null;
  if (opts.state.query !== q) return MENTION_SEARCH_PAGE;
  // The page came back FULL, so the archive may be holding more of it, and the
  // picker still has room. A short page means the archive is exhausted: asking
  // for more of nothing is a round trip that cannot change the answer.
  const mayHaveMore =
    opts.state.hits.length >= opts.state.limit && opts.state.limit < MENTION_SEARCH_MAX;
  if (mayHaveMore && opts.rows < opts.want) return MENTION_SEARCH_MAX;
  return null;
}
