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

/**
 * A worker's report, as the log needs it.
 *
 * `text` is the SUMMARY — a few sentences, capped server-side at 400 characters.
 * It is an INDEX, not a substitute: the work itself (a 25 KB research report, a
 * published url) is fetched from the transcript when the card is expanded, which
 * is why nothing here grew a second, larger field. See lib/spawn-work.ts.
 */
export interface SpawnReport {
  /** Null is meaningful: `none` and a `crashed` worker that got nothing done
   *  both have a state and no sentences. */
  text: string | null;
  /** 'ok' a report · 'none' it produced nothing and says so · 'crashed' its last
   *  turn was fatal. A report we could not produce at all is no report field. */
  state: 'ok' | 'none' | 'crashed';
  /** When it was written — the report entry's place in the log, which is the
   *  moment the result LANDED rather than the spawn hours further up. */
  at: number;
}

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
   * The chat this one was spawned under, by ID — `spawned_by`, passed through.
   *
   * The name (below) is for SAYING whose work this is; the id is for ASKING the
   * other direction — "what did this chat start" — which is what the spawn cards
   * in a conversation and the running count above its composer are. Absent for a
   * root, which is most chats.
   */
  parentId?: string | undefined;
  /**
   * When this chat was CREATED — `created_at`, passed through.
   *
   * For a child chat this is the moment of the spawn, and that is what it is
   * carried for: the spawn card sits in the parent's log where the spawn
   * happened, so the card needs a time, and the only honest one is the one the
   * server stamped on the row. No new storage, durable, the same on every
   * device. Optional here for the same wire-compat reason as everything else on
   * this interface, though `created_at` has been on the tab row since the first
   * migration.
   */
  createdAt?: number | undefined;
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
   * WHEN it finished — the anchor for its COMPLETION card.
   *
   * `done_at`, passed through: the server's retirement stamp. Absent while the
   * chat is live, and absent from a server that predates the field — see
   * `finishedAt`, which is what actually resolves it.
   */
  doneAt?: number | undefined;
  /**
   * WHAT THIS WORKER WAS ASKED — one short line of plain English, generated
   * server-side from its FIRST message (server/src/chat/spawn-task.ts).
   *
   * `--name=status-line` is a handle typed on a command line; it is not a label,
   * and a card carrying only that says nothing about what is running. Absent for
   * every chat nobody spawned, and for a worker whose first turn has not been
   * read yet — see `spawnLabel`, which never leaves the card blank.
   */
  task?: string | undefined;
  /**
   * WHAT THIS WORKER DID — the spawn report, when it has one.
   *
   * Written server-side by reading the child's own transcript the moment its work
   * ends (server/src/chat/spawn-report.ts), published on the child's tab row, and
   * shown as its own entry in the PARENT's conversation. Absent for every chat
   * nobody spawned, and for a worker still working.
   *
   * Three fields rather than a bare string because the STATE is the half that
   * decides what to draw: a worker that produced nothing says so, and a crashed
   * one is the only case where a card must stop spinning without its chat having
   * retired. See `spawnState`.
   */
  report?: SpawnReport | undefined;
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
  /** Epoch ms the row was created — for a child, the moment of the spawn. */
  created_at?: number | null;
  /** Present-but-NULL means there is no clock at all — see toMentionChats. */
  clock?: ChatClock | null;
  /** Epoch ms it finished — the retirement stamp. Null while live. */
  done_at?: number | null;
  /** One line of what this worker was asked, generated from its first message. */
  spawn_task?: string | null;
  /** The spawn report's three columns. All three absent together, always. */
  spawn_report?: string | null;
  spawn_report_at?: number | null;
  spawn_report_state?: 'ok' | 'none' | 'crashed' | null;
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
      ...(row?.spawned_by ? { parentId: row.spawned_by } : {}),
      ...(parentName ? { parentName } : {}),
      ...(typeof row?.created_at === 'number' ? { createdAt: row.created_at } : {}),
      ...(typeof row?.done_at === 'number' ? { doneAt: row.done_at } : {}),
      ...(row?.spawn_task ? { task: row.spawn_task } : {}),
      // THE REPORT, gated on the STATE and on the timestamp together. Both are
      // needed to draw the entry at all — a state with no time has no place in
      // the log to sit — and the server publishes them as a set, so a row
      // carrying one without the other is a server that predates this or a
      // half-written row, and the honest reading of either is "no report yet".
      ...(row?.spawn_report_state && typeof row.spawn_report_at === 'number'
        ? {
            report: {
              text: row.spawn_report ?? null,
              state: row.spawn_report_state,
              at: row.spawn_report_at,
            },
          }
        : {}),
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

// ── What this chat SPAWNED ───────────────────────────────────────────────────

/**
 * How many spawn cards one conversation carries.
 *
 * The same shape of cap as the directed cards next door, and for the same
 * reason: a chat used as a dispatcher accumulates children forever, and forty
 * cards is not a record of anything you can read. LIVE children are never
 * dropped — they are the work still running, and the running count is derived
 * from this very list — so the cap only ever sheds finished ones, OLDEST FIRST.
 * What it sheds is not lost: the sidebar's `done` group and `@` both still hold
 * it, and the oldest spawn is also the one furthest up a log you have scrolled
 * past.
 */
export const MAX_SPAWN_CARDS = 12;

/**
 * The chats spawned under `tabId`, in the order they were spawned.
 *
 * This is the whole of fix 4's data layer, and it needed no new storage: a child
 * chat IS the record that a spawn happened. The card could have been a
 * device-local echo like the directed ones (see lib/chat-directed), and then a
 * spawn made by the CLI — an agent delegating work, which is nearly all of them
 * — would have appeared nowhere, on any device. Derived from the corpus it
 * appears everywhere, for whoever made it, and it cannot disagree with the
 * sidebar about what is running because it is the same rows.
 *
 * ─── Ordered by CREATION, not by activity ────────────────────────────────────
 * This used to sort on `lastActivityAt`, which was defensible while the cards
 * were pinned furniture at the foot of the log — they were a list of what was
 * running, and the busiest child belonged at the bottom. They are transcript
 * entries now, placed where the spawn happened, and an entry in a log is a fact
 * about a MOMENT: a card that reorders itself every time the child says
 * something is a message that walks around the conversation while you read it.
 * `created_at` is that moment, it is the server's, and it never changes.
 *
 * `tabId` breaks ties, keeping the order total — two spawns in the same
 * millisecond must not swap places between two renders.
 */
export function spawnedChildren(
  corpus: readonly MentionChat[],
  tabId: string | undefined | null,
  max: number = MAX_SPAWN_CARDS,
): MentionChat[] {
  if (!tabId) return [];
  const kids = corpus.filter((c) => c.parentId === tabId && c.tabId !== tabId);
  kids.sort((a, b) => spawnedAt(a) - spawnedAt(b) || a.tabId.localeCompare(b.tabId));
  if (kids.length <= max) return kids;
  // Shed FINISHED ones from the front; keep every live child and fill the rest
  // of the budget with the most recent results.
  const live = kids.filter((k) => !k.done);
  const finished = kids.filter((k) => k.done);
  const keepFinished = finished.slice(
    Math.max(0, finished.length - Math.max(0, max - live.length)),
  );
  return kids.filter((k) => (k.done ? keepFinished.includes(k) : true));
}

/**
 * When a chat was spawned, as a number the ordering can rely on.
 *
 * A row with no `created_at` sorts to the very beginning rather than to "now":
 * the front of the log is a STABLE place, and "now" is the one answer that would
 * move the card on every render. (Unreachable against any real server —
 * `created_at` is non-optional on the tab row — so this is the shape of the
 * fallback, not a case that happens.)
 */
function spawnedAt(c: MentionChat): number {
  return c.createdAt ?? 0;
}

/**
 * One entry a child chat puts in its parent's conversation.
 *
 * TWO PER CHILD, and this is the correction that matters most in the whole
 * feature:
 *
 *   `launch`      at the child's `created_at` — "you started this, it is
 *                 running". A name and a spinner. Nothing to summarise yet.
 *   `completion`  at the moment it FINISHED — the green tick, the summary, the
 *                 expand, the way in. Everything the result is.
 *
 * A draft of this drew ONE card that gained the result in place. It is a trap,
 * and the user named it exactly: "if the chat has progressed then it doesn't
 * help much to update the original card". A card that mutates where it sits is
 * invisible the moment the conversation has scrolled past it — which is
 * precisely when a long job finishes. The completion has to arrive where the
 * reader is LOOKING, and in a log that means a new entry at the bottom.
 *
 * Both are anchored to SERVER-STAMPED columns, so neither moves once drawn and
 * a reload puts them back in the same two places. Two cards back to back when
 * nothing happened in between is a correct and expected rendering, not a defect
 * to suppress: it says a thing started and finished, which is what happened.
 */
export interface SpawnCard {
  chat: MentionChat;
  kind: 'launch' | 'completion';
  /** Epoch ms this entry is about. Never moves. */
  at: number;
}

/**
 * When a child FINISHED — or null if we cannot say, in which case it gets no
 * completion entry at all rather than one in an invented place.
 *
 * Three sources, in descending order of how directly each answers the question:
 *
 *   1. `doneAt` — the server's RETIREMENT stamp. The truth, and the only one of
 *      the three that is an event rather than an approximation.
 *   2. the spawn report's timestamp — for a CRASHED worker, which by design
 *      never retires (a crashed run keeps its live row so you can look at it),
 *      so it has no stamp at 1 and this is the only "when" that exists for it.
 *   3. `lastActivityAt` — the last resort, and a deliberately temporary one: a
 *      child that finished on a server built before `done_at` existed still
 *      gets its completion card instead of silently losing one. For a retired
 *      worker nothing touches it again, so it is stable in practice.
 *
 * NOT the report's timestamp first: that is an ATTEMPT clock which advances on
 * failures too and is rate-limited to once per half hour, so preferring it would
 * put the card up to thirty minutes away from where the work actually ended.
 */
function finishedAt(c: MentionChat): number | null {
  if (typeof c.doneAt === 'number') return c.doneAt;
  if (c.report) return c.report.at;
  return typeof c.lastActivityAt === 'number' ? c.lastActivityAt : null;
}

/**
 * WHAT A SPAWN CARD IS CALLED — a sentence, not a handle.
 *
 * The cards read `status-line` and `cross-ws`: the `--name=` values typed on a
 * command line. They are chosen to be short enough to type and unique enough to
 * grep, which are not the qualities a label needs, and two of them side by side
 * say nothing about what is running.
 *
 * Three sources, in descending order of how well each answers "what is this
 * worker for":
 *
 *   1. `task` — generated from the child's FIRST message the moment it starts
 *      work. Written for this slot and nothing else.
 *   2. the HEADLINE — and this is the one place it is genuinely good. It
 *      restates the PROMPT and it arrives on a six-minute interval; both are
 *      why it was wrong under a FINISHED card (it says nothing about what the
 *      worker found), and both are fine here. What a worker was asked IS what a
 *      launch card wants to say, and a label that is late by a few minutes is a
 *      label on work that is usually still running.
 *   3. the tab NAME — the handle. Poor, not broken, and never blank.
 */
export function spawnLabel(chat: MentionChat): string {
  return chat.task || chat.headline || chat.tabName;
}

/**
 * The handle, for the line under the label — `status-line` beneath "Move the
 * status line out of the composer".
 *
 * Worth its line: it is what the sidebar row says, what `@` completes, and what
 * you would type to talk to this worker from a terminal. Omitted when it IS the
 * label, because two lines saying `status-line` are worse than one.
 */
export function spawnHandle(chat: MentionChat): string | undefined {
  return spawnLabel(chat) === chat.tabName ? undefined : chat.tabName;
}

/**
 * What a report card SAYS when the generator wrote no sentences.
 *
 * Both fallbacks are statements of fact rather than apologies, and neither is an
 * invented summary — "a child that produced nothing useful says so plainly" is
 * the requirement, and the server distinguishes "nothing to report" from "we
 * could not summarise" precisely so that this function is never reached for the
 * second one (no report field at all → no card).
 *
 * Here rather than in the JSX so the wording is one string in one place, and so a
 * test can hold it: these two sentences are the entire content of the card in the
 * two cases where a reader is most likely to think something broke.
 */
export function spawnReportSummary(report: SpawnReport): string {
  if (report.text) return report.text;
  return report.state === 'crashed'
    ? 'Crashed before it produced anything.'
    : 'Finished with nothing to report.';
}

/**
 * What a card says about its worker — the one state resolution, in one place.
 *
 * A pure function rather than ternaries in the renderer because it decides three
 * things that were previously wrong or unavailable:
 *
 *   · `failed` EXISTS. A crashed worker deliberately keeps its live row (a
 *     crashed run is what you want to look at), so `!done` read it as still
 *     working and its card span forever. The report's `crashed` state is the
 *     only signal that says otherwise, and it comes from an OBSERVED fatal turn
 *     rather than from anything a model concluded.
 *   · `delivered` vs `done`. Delivered means it finished its work; done means the
 *     chat left the live list some other way (you archived it, or it decayed
 *     without ever being a worker that delivered).
 *   · everything else is `working` — which on a LAUNCH card is the spinner, and
 *     is the only thing that card ever says.
 */
export type SpawnState = 'working' | 'delivered' | 'done' | 'failed';

export function spawnState(chat: MentionChat): SpawnState {
  // RIGHT NOW OUTRANKS THE ROW. A sub-chat retires at a turn end, by design —
  // so a worker you are still using carries `retired_at` with reason
  // `delivered` between its turns, and its card wore a green tick while it was
  // busy. Retirement is a statement about a DELIVERY that happened; the pane's
  // live status is a statement about this moment, and this moment wins.
  //
  // Checked FIRST, ahead of the crash, because a crashed run that has been
  // revived and is working again is working.
  if (chat.status === 'working' || chat.status === 'blocked') return 'working';
  if (chat.report?.state === 'crashed') return 'failed';
  if (!chat.done) return 'working';
  return chat.doneReason === 'delivered' ? 'delivered' : 'done';
}

/**
 * Is there anything behind an expander on this child's completion card?
 *
 * Only a REPORT earns one. Three states exist in the wild at once — measured on
 * the real database — and two of them have nothing to show:
 *
 *   `ok` / `crashed`  a generated report. Expanding shows the child's final
 *                     answer beneath it: its conclusion, and the file path or
 *                     url it names.
 *   `none`            the generator judged that it produced nothing, and the
 *                     card says exactly that. A control under that sentence
 *                     would promise a second opinion that does not exist.
 *   UNSET             the generation was attempted and came back unusable
 *                     (`spawn_report_at` stamped, `spawn_report_state` NULL).
 *                     We know nothing about this run.
 *
 * The last case is the one that produced the complaint. With no report the
 * expander still opened — onto the transcript — and a worker narrates as it
 * works, so what it opened onto was the entire story of how the job was done:
 * "way too verbose and contains the entire story". Offering nothing is better
 * than offering that; the sub-chat is still one click away through the head.
 */
export function canExpandSpawn(chat: MentionChat): boolean {
  return chat.report?.state === 'ok' || chat.report?.state === 'crashed';
}

/**
 * The spawn cards for `tabId`'s conversation — every child, live and finished.
 *
 * FINISHED CHILDREN ARE IN, which is the opposite of what the foot-of-log
 * version did, and for the reason the amendment turns on: a card is no longer
 * furniture that has to earn its place above the composer forever. It is an
 * entry in the log at the moment of the spawn, so a delivered child's card is
 * the record that this chat started something and it finished — the same reading
 * as any older message, and it scrolls away like one.
 *
 * ONE list feeds both the cards and the running count (see
 * `liveSpawnedChildren`, which this must agree with by construction). That is
 * the property the seam test pins: two surfaces answering "what is this chat
 * running" from two lists is how they came to disagree in the first place.
 */
export function spawnCards(
  corpus: readonly MentionChat[],
  tabId: string | undefined | null,
  max: number = MAX_SPAWN_CARDS,
): SpawnCard[] {
  const out: SpawnCard[] = [];
  // THE CAP COUNTS CHILDREN, NOT ENTRIES. What a reader drowns in is a
  // dispatcher's forty workers, not the fact that each of them both started and
  // finished — and a child's two entries are shed together, because half a pair
  // is worse than neither: a launch whose completion is missing reads as work
  // that vanished, and a completion with no launch as one that came from nowhere.
  for (const chat of spawnedChildren(corpus, tabId, max)) {
    out.push({ chat, kind: 'launch', at: spawnedAt(chat) });
    // ONLY ONCE IT HAS ACTUALLY FINISHED. Nothing arrives at the bottom of the
    // conversation while the work is still going on — which is the rule the
    // whole two-card split rests on.
    //
    // Through `spawnState`, so the live pane status is what decides: a worker
    // you are still using is retired between its turns (that is what a sub-chat
    // does), and a completion card for it would be announcing a result while it
    // was mid-sentence.
    if (spawnState(chat) === 'working') continue;
    const at = finishedAt(chat);
    if (at !== null) out.push({ chat, kind: 'completion', at });
  }
  // Sorted because a slow worker finishes AFTER a later sibling was launched,
  // and `interleaveSpawnCards` walks this list once against the transcript's own
  // times. `kind` breaks a tie so a completion can never be drawn above the
  // launch it answers — which is what a worker that finished inside the same
  // millisecond would otherwise do, a coin-flip per render.
  out.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return out;
}

const KIND_ORDER: Record<SpawnCard['kind'], number> = { launch: 0, completion: 1 };

/** The children still working — the number above the composer. */
export function liveSpawnedChildren(
  corpus: readonly MentionChat[],
  tabId: string | undefined | null,
): MentionChat[] {
  return spawnedChildren(corpus, tabId, Number.POSITIVE_INFINITY).filter((c) => !c.done);
}

/** One thing the conversation draws: a rendered transcript entry, or a card. */
export type LogEntry<T> = { kind: 'entry'; node: T } | { kind: 'card'; card: SpawnCard };

/**
 * Interleave the spawn cards into a conversation's entries, by TIME.
 *
 * `entries` are the transcript's top-level rows in the order they are rendered,
 * each with the epoch ms it happened at (`null` for a row whose transcript line
 * carried no parseable timestamp). `cards` are `spawnCards`' output — ascending
 * by spawn time.
 *
 * A card is emitted before the first entry that happened AFTER it, which is what
 * "where the spawn happened" means when the spawn itself is not a transcript
 * line: the tool call that created the child is somewhere in the turn, and the
 * card lands between that turn and whatever came next. Cards older than the
 * oldest loaded entry come out at the top (they belong further back than the
 * history window reaches, and the top is where "further back" is); cards newer
 * than the last entry come out at the bottom, which is where a spawn that just
 * happened belongs.
 *
 * An entry with NO time is not a boundary — it cannot say whether the spawn came
 * before or after it, and guessing would put the card in a different place on
 * the next reload.
 *
 * Pure and generic over the node type on purpose: placement is the half of this
 * that can be wrong, and it is worth being able to test it against `['a','b']`
 * rather than a mounted 6,000-line component.
 */
export function interleaveSpawnCards<T>(
  entries: readonly { at: number | null; node: T }[],
  cards: readonly SpawnCard[],
): LogEntry<T>[] {
  const out: LogEntry<T>[] = [];
  let i = 0;
  for (const entry of entries) {
    if (entry.at !== null) {
      while (i < cards.length && (cards[i] as SpawnCard).at <= entry.at) {
        out.push({ kind: 'card', card: cards[i++] as SpawnCard });
      }
    }
    out.push({ kind: 'entry', node: entry.node });
  }
  for (; i < cards.length; i++) out.push({ kind: 'card', card: cards[i] as SpawnCard });
  return out;
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

/**
 * A value as LITERAL TEXT inside a `'…'` shell word.
 *
 * XML escaping is not shell quoting, and `esc` above is XML escaping. It leaves
 * the apostrophe alone — correctly, for an attribute in a `"`-quoted slot — and
 * the report-back command interpolates those same attributes into a
 * single-quoted shell argument. So a chat called `Ohad's project` produced a
 * ready-to-copy command whose quote ended in the middle of its own name:
 *
 *   muxpad agent send p1 '<muxpad-report … from="Ohad's project" …>
 *
 * `/bin/sh -n` rejects it with an unterminated quote, and the round trip then
 * depended on the receiving agent noticing and repairing our command. Review 3
 * named the real hole here: "shell quoting" was a boundary nobody's territory
 * claimed, in a file otherwise concerned with XML.
 *
 * `'\''` is the POSIX idiom — close the quote, an escaped literal apostrophe,
 * reopen — and it is the whole trick, because inside `'…'` nothing else has any
 * meaning at all.
 */
function shq(v: string): string {
  return v.replace(/'/g, `'\\''`);
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
  //
  // Both interpolations into the COMMAND go through `shq` — see it for the
  // apostrophe that broke the template. The last line is the other half of the
  // same problem and cannot be escaped from here: the agent writes its own
  // prose, and "it's done" would end the quote just as a name did. So the marker
  // is stated as the contract and the delivery is explicitly not — an agent that
  // would rather POST, or quote differently, is doing the right thing as long as
  // the first line is the marker. (The durable fix is a stdin form of
  // `muxpad agent send`, which is the CLI's to add, not this file's.)
  const note = [
    `Directed here from the muxpad chat "${marker.from}" — another chat's user, not this chat's.`,
    'Do the work in THIS chat, then report back once, in one message:',
    `  muxpad agent send '${shq(marker.pane)}' '${shq(report)}`,
    "  <two or three sentences: what you did and what the answer is>'",
    "The single quotes are the shell's, so an apostrophe inside your sentences has",
    "to be written '\\'' — or send the message any other way you like. What matters",
    'is only that its FIRST LINE is exactly the marker above.',
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
