import {
  type PaneStatus,
  STATUS_ORDER,
  type Tab,
  collectLayoutLeaves,
  userTouchAt,
} from '@muxpad/shared';

/**
 * The sidebar search's INSTANT tier: rank every known tab against what the
 * user has typed so far, locally, with no network in the path.
 *
 * Pure on purpose. The box re-runs this on EVERY keystroke — there is no
 * debounce, because "get me to the Investing chat" is the common case and a
 * 150ms wait on the answer you already have reads as lag. Keeping the rule set
 * out of the component is what makes that affordable to reason about (and
 * testable at the offsets, which is where the highlight bugs live).
 *
 * The second tier — what was actually SAID inside sessions — is the archive's
 * FTS5 index behind `GET /api/search`, debounced, and rendered under its own
 * divider. It never reorders or delays anything here.
 */

/** One row of the searchable corpus: a tab, plus the workspace it lives in. */
export interface SearchableTab {
  tabId: string;
  tabSlug: string;
  tabName: string;
  headline?: string | undefined;
  icon?: string | undefined;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  status?: PaneStatus | undefined;
  unread?: boolean | undefined;
  pinned?: boolean | undefined;
  lastActivityAt?: number | null | undefined;
  /** When YOU last touched it — the key the recents list orders on. Separate
   *  from `lastActivityAt`, which a tailing log bumps every five seconds; see
   *  `userTouchAt` in shared/tab-order for the measurement that settled it. */
  lastUserAt?: number | null | undefined;
  /**
   * The chat is finished — archived, decayed, or a sub-chat that delivered.
   *
   * POPULATED ON THIS CORPUS NOW. It used to be "absent on the sidebar's
   * corpus; the mention picker supplies it", which made `SCORE.donePenalty`
   * dead code for ⌘K — and then made the recents list below wrong, because
   * `done` is the overwhelming majority: measured on the live cockpit, 1,091
   * of 1,111 rows. The wire has carried the field all along.
   */
  done?: boolean | undefined;
  /** Spawned under another chat — a worker, not a conversation. 964 of those
   *  1,111 rows. See `recentTabs` for why they are not somewhere to go back
   *  to. */
  spawnedBy?: string | null | undefined;
  /** Layout leaves — how a content hit's `session.pane_id` finds its tab. */
  paneIds: string[];
}

/** Which field the query hit. Also decides where the highlight is painted. */
export type MatchField = 'name' | 'headline' | 'workspace';

export interface TabMatch {
  tab: SearchableTab;
  field: MatchField;
  /** [start, end) of the matched run, in the ORIGINAL field text's
   *  coordinates. ABSENT on a row that nothing was typed against — the
   *  recents list below reuses this shape so one result row renders both,
   *  and `splitHighlight` already degrades an absent range to plain text. */
  range?: readonly [number, number] | undefined;
  score: number;
}

/**
 * The score bands. A band is 20 wide and every boost below is smaller than
 * that, so a boost can only ever win a tie INSIDE its own band — nothing may
 * promote a headline match above a name match, or the ordering the user reads
 * stops being explainable.
 *
 * The bands were 10 apart with one 5-point boost. They doubled when the ties
 * turned out to be the whole problem: typing `ra` produced FIVE rows all
 * scoring exactly `namePrefix`, so their order was decided entirely by the
 * tiebreak — and the tiebreak is recency, which handed the top of the list to
 * delivered sub-chats that happened to be touched most recently. `radar` and
 * `radar archive` sat below `rail status …`. Reported as "prioritize a
 * combination of recently active chats and strongest matches to chat name".
 *
 * The answer is to stop having ties, not to re-order them: a band now has room
 * for the three things that genuinely separate two equally-typed matches.
 */
export const SCORE = {
  nameExact: 200,
  namePrefix: 180,
  /** A prefix of a WORD inside the name — "inv" in "My Investing notes". Sits
   *  between prefix and plain substring: it is still the start of something
   *  you'd say out loud, which a match landing mid-word is not. */
  nameWord: 160,
  nameSubstring: 140,
  headline: 100,
  workspace: 60,
  pinnedBoost: 5,
  /** How much of the NAME the query covered. `ra` is all of "ra", a third of
   *  "radio" and a tenth of "Rat a rat card redesign" — and the shorter name
   *  is the one you meant, every time. Up to 8. */
  coverage: 8,
  /** Touched in the last minutes vs last month. Up to 5, decaying over a
   *  week — enough to separate two equally good matches, never enough to lift
   *  a worse one over a better one. */
  recency: 5,
  /** A finished chat — archived, decayed, or a sub-chat that has delivered.
   *  Still findable, still in its band, just under its live neighbours: when
   *  you TYPE a name you are looking for somewhere to go, and a delivered
   *  worker is somewhere you have already been. */
  donePenalty: 6,
} as const;

/** Whole days, for the recency ramp. */
const DAY_MS = 86_400_000;

/**
 * The part of a score that is not about the match: how much of the name it
 * covered, how recently the chat moved, and whether it is finished.
 *
 * Bounded by construction — `coverage + recency + pinnedBoost` is 18, under
 * the 20-point band — so this can reorder rows that matched the same way and
 * can never reorder rows that did not.
 */
function contextBoost(tab: SearchableTab, matched: number, now: number): number {
  let boost = 0;
  const len = tab.tabName.length;
  if (len > 0 && matched > 0) boost += SCORE.coverage * Math.min(1, matched / len);
  const at = tab.lastActivityAt;
  if (at) {
    // Linear over a week: today is worth the full 5, a week old is worth 0,
    // and older than that is not worth less than nothing.
    const age = Math.max(0, now - at);
    boost += SCORE.recency * Math.max(0, 1 - age / (7 * DAY_MS));
  }
  if (tab.done) boost -= SCORE.donePenalty;
  return boost;
}

/**
 * Neutralise every RegExp metacharacter in `s`.
 *
 * Exported because the CHAT-side highlight (lib/search-highlight) must escape
 * the same way this file does: a query is user text, and `a.*b` or an unclosed
 * `(` reaching `new RegExp` is either a crash or a match on something the user
 * never asked about.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

export interface FieldHit {
  range: readonly [number, number];
  /** 'exact' | 'prefix' | 'word' | 'sub' — the strongest placement found. */
  kind: 'exact' | 'prefix' | 'word' | 'sub';
}

/**
 * Best placement of `query` inside `text`, case-insensitively.
 *
 * Exported for lib/output-search, which ranks hosted artifacts and apps in the
 * same palette and must agree with this one about what counts as a prefix, a
 * word boundary and a mid-word hit — two rankers in one list that disagreed
 * about that would produce an order nobody could explain.
 *
 * Matches with a RegExp against the ORIGINAL string rather than comparing
 * lowercased copies: `toLowerCase()` is not length-preserving for every
 * codepoint (İ → i̇ is one char becoming two), so offsets taken from a
 * lowercased haystack can land mid-grapheme in the real one and the highlight
 * slices the wrong characters. The `i` flag folds case without moving indices.
 */
export function findBest(
  text: string,
  query: string,
  opts?: {
    /**
     * TREAT SPACES, HYPHENS, UNDERSCORES AND SLASHES AS THE SAME THING.
     *
     * For hosted outputs, where the haystack is a slug or a path and the query
     * is what a person says out loud. The case that forced it is the one the
     * whole feature exists for: the family games portal lives in
     * `tom-romy-surfers`, and it was asked for as "Tom Romy" — three times in
     * five days. A literal match finds nothing, because the space is not a
     * hyphen.
     *
     * Only the RUNS BETWEEN words are loosened; the words themselves are
     * escaped literally, so this cannot turn a query into a wildcard. And it
     * still matches against the original string, so the offsets a highlight is
     * painted at stay true.
     *
     * Not used for chat names, deliberately: those are prose, and this is a
     * rule about identifiers.
     */
    loose?: boolean | undefined;
  },
): FieldHit | null {
  if (!text || !query) return null;
  const source = opts?.loose ? looseSource(query) : escapeRegExp(query);
  if (!source) return null;
  const re = new RegExp(source, 'gi');
  let best: FieldHit | null = null;
  const rank = { exact: 3, prefix: 2, word: 1, sub: 0 } as const;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    const kind: FieldHit['kind'] =
      start === 0
        ? end === text.length
          ? 'exact'
          : 'prefix'
        : WORD_CHAR.test(text[start - 1] ?? '')
          ? 'sub'
          : 'word';
    if (!best || rank[kind] > rank[best.kind]) best = { range: [start, end], kind };
    if (best.kind === 'exact') break;
    // Zero-length matches can't happen (query is non-empty) but a stuck
    // lastIndex would spin the loop forever if that ever changed.
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return best;
}

export /** Each run of separators in the query becomes "one or more separators", and
 *  every other character stays literal. An all-separator query (" - ") yields
 *  nothing rather than a pattern that matches every path on the machine. */
function looseSource(query: string): string {
  const SEP = /[\s\-_/]+/g;
  const words = query.split(SEP).filter((w) => w.length > 0);
  if (words.length === 0) return '';
  return words.map(escapeRegExp).join('[\\s\\-_/]+');
}

export function nameScore(kind: FieldHit['kind']): number {
  if (kind === 'exact') return SCORE.nameExact;
  if (kind === 'prefix') return SCORE.namePrefix;
  if (kind === 'word') return SCORE.nameWord;
  return SCORE.nameSubstring;
}

/** Precedence index — lower is more urgent. Unknown/absent sorts last. */
function statusRank(s: PaneStatus | undefined): number {
  if (!s) return STATUS_ORDER.length;
  const i = STATUS_ORDER.indexOf(s);
  return i < 0 ? STATUS_ORDER.length : i;
}

/**
 * Rank tabs against `query`. Empty/whitespace-only query returns nothing —
 * the caller shows the tree, not a list of everything.
 *
 * Ordering: score desc, then status (blocked → working → dead → ready → idle,
 * through the shared STATUS_ORDER so the search and the rail agree), then
 * `last_activity_at` desc, then name and id. The last two exist only to make
 * the order TOTAL: two identically-scored rows must not swap places between
 * two renders of the same data.
 */
export function rankTabs(
  tabs: readonly SearchableTab[],
  query: string,
  opts?: { limit?: number; now?: number },
): TabMatch[] {
  const q = query.trim();
  if (!q) return [];
  // One clock for the whole pass: a ranking whose rows are scored against
  // different `now`s is not a total order, and this runs on every keystroke.
  const now = opts?.now ?? Date.now();
  const out: TabMatch[] = [];
  for (const tab of tabs) {
    let match: TabMatch | null = null;
    const onName = findBest(tab.tabName, q);
    if (onName) {
      match = { tab, field: 'name', range: onName.range, score: nameScore(onName.kind) };
    } else {
      const onHeadline = tab.headline ? findBest(tab.headline, q) : null;
      if (onHeadline) {
        match = { tab, field: 'headline', range: onHeadline.range, score: SCORE.headline };
      } else {
        const onWorkspace = findBest(tab.workspaceName, q);
        if (onWorkspace) {
          match = { tab, field: 'workspace', range: onWorkspace.range, score: SCORE.workspace };
        }
      }
    }
    if (!match) continue;
    if (tab.pinned) match.score += SCORE.pinnedBoost;
    // The match is WHAT you typed; this is everything else about the row. Only
    // a NAME match gets coverage — a query covering half a headline says
    // nothing about which chat you meant.
    match.score += contextBoost(
      tab,
      match.field === 'name' && match.range ? match.range[1] - match.range[0] : 0,
      now,
    );
    out.push(match);
  }
  out.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const sa = statusRank(a.tab.status);
    const sb = statusRank(b.tab.status);
    if (sa !== sb) return sa - sb;
    const la = a.tab.lastActivityAt ?? Number.NEGATIVE_INFINITY;
    const lb = b.tab.lastActivityAt ?? Number.NEGATIVE_INFINITY;
    if (la !== lb) return lb - la;
    const byName = a.tab.tabName.localeCompare(b.tab.tabName);
    if (byName !== 0) return byName;
    return a.tab.tabId < b.tab.tabId ? -1 : a.tab.tabId > b.tab.tabId ? 1 : 0;
  });
  const limit = opts?.limit;
  return limit !== undefined && limit >= 0 ? out.slice(0, limit) : out;
}

/** How many rows the empty query shows. The band this replaces had six fixed
 *  slots; eight covers them with margin and still fits one screen on a phone
 *  without the list becoming a second sidebar. */
export const RECENT_LIMIT = 8;

/**
 * THE EMPTY QUERY — "take me back to what I was doing", across every workspace.
 *
 * This is where recency lives now. The rail used to carry a permanent
 * "Recently active" band of six slots above the tree, and the band's problem
 * was not its order but its DUPLICATION: every row in it already existed below
 * in its own workspace, and the copy at the top had no workspace to belong to,
 * so the one piece of information you need to go back to something — where it
 * lives — was the one piece it could not show. ChatGPT users hit the same
 * thing when organized chats also filled a global Recents list.
 *
 * So recency moves behind the one search surface, where a row carries its
 * workspace name as a matter of course. The cost is honest and worth stating:
 * a cross-workspace jump is now a keystroke rather than a glance. That is the
 * trade this makes, not a free win.
 *
 * ORDERED BY YOUR OWN TOUCH, not the machine's. `userTouchAt` is the shared
 * definition the server's sidebar order already uses, and it reads
 * `last_user_at` precisely so a chat left tailing a log cannot hold the top of
 * the list. Measured on the live cockpit when that rule was written: six
 * working chats held six of the global top seven, all under a minute old, none
 * of them anything the user had done. Reusing the function rather than
 * re-deriving recency here is what keeps the two surfaces from disagreeing.
 *
 * NOT re-ranked by status. A blocked chat is not promoted, because a list that
 * reorders itself on an agent's state is the churn feed this is meant to
 * replace — and "which chat wants me" is a different question with its own
 * answer. The rows carry their state dot, so a blocked chat still reads as
 * blocked where it sits.
 */
export function recentTabs(
  tabs: readonly SearchableTab[],
  opts?: { limit?: number; exclude?: string | undefined },
): TabMatch[] {
  const limit = opts?.limit ?? RECENT_LIMIT;
  if (limit <= 0) return [];
  const exclude = opts?.exclude;
  const rows = tabs.filter((t) => {
    // WHERE YOU ALREADY ARE is not somewhere to go. Without this the cursor
    // starts on the chat you opened the palette from, and the first Enter —
    // the whole point of a keyboard switcher — does nothing at all.
    if (exclude && (t.tabId === exclude || t.tabSlug === exclude)) return false;
    // ── AND NEITHER IS A WORKER, OR A CHAT THAT IS OVER ─────────────────
    //
    // This list is "take me back to what I was doing", and the corpus it
    // draws on is not that list: measured on the live cockpit, 1,111 rows, of
    // which 1,091 are `done` and 964 are sub-chats. Ordering all of them by
    // recency and taking eight is one `muxpad agent new` away from a switcher
    // containing nothing but the workers you just spawned — a sub-chat's
    // `last_user_at` is stamped at CREATION, so eight fresh ones take every
    // slot.
    //
    // The band this replaced could not do that, and it is worth being precise
    // about why rather than trusting that it cannot happen: its working set
    // was fed by `TabActivity.touchTab`, which skips a sub-chat explicitly
    // ("answering a worker is work inside a chat, not a choice to be in
    // one"). That exclusion was load-bearing and it did not come across.
    //
    // A worker is also not a place you go back to: its result arrives in its
    // parent's conversation, and its own chat is reachable from the parent's
    // drawer and from `@`. A DONE chat is excluded for the plainer reason —
    // the clock calls a chat done after four days untouched, which is the
    // opposite of what you were just doing. Typing still finds both.
    if (t.spawnedBy) return false;
    if (t.done) return false;
    return true;
  });
  const out = [...rows];
  out.sort((a, b) => {
    const ta = touchedAt(a);
    const tb = touchedAt(b);
    if (ta !== tb) {
      // A row with no stamp at all sorts LAST rather than first: `null` is
      // "we don't know when", and guessing "just now" would put the least
      // known rows at the top of a list whose whole claim is recency.
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    // TOTAL, so two chats created in the same millisecond do not swap places
    // between renders of the same data.
    const byName = a.tabName.localeCompare(b.tabName);
    if (byName !== 0) return byName;
    return a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0;
  });
  // `field: 'name'` with no range: the row shape is shared with the ranked
  // results so one component renders both, and an absent range is already the
  // "nothing matched, print it plain" case in `splitHighlight`.
  return out.slice(0, limit).map((tab) => ({ tab, field: 'name' as const, score: 0 }));
}

/** The corpus row's camelCase fields in the shape the shared order reads.
 *  One policy, two spellings — never a second definition of "recent". */
function touchedAt(t: SearchableTab): number | null {
  return userTouchAt({
    id: t.tabId,
    last_user_at: t.lastUserAt,
    last_activity_at: t.lastActivityAt,
  });
}

/**
 * The tab slug in a route like `/w/personal/t/investing`, for "don't offer me
 * the chat I am looking at".
 *
 * Reads the path rather than the router's params because the palette is
 * mounted once, above every route, and has no matched route of its own to ask.
 * Returns undefined for any path without a tab — the hosted surfaces, the
 * workspace root — which is exactly the case where nothing should be excluded.
 */
export function tabSlugFromPath(path: string): string | undefined {
  const seg = /\/t\/([^/?#]+)/.exec(path)?.[1];
  if (!seg) return undefined;
  try {
    return decodeURIComponent(seg);
  } catch {
    // A malformed escape is not a reason to fail a navigation list; the raw
    // segment still matches a slug that never needed encoding.
    return seg;
  }
}

/** Split `text` at a match range so the row can bold the middle third. */
export function splitHighlight(
  text: string,
  range: readonly [number, number] | null | undefined,
): [string, string, string] {
  if (!range) return [text, '', ''];
  const [s, e] = range;
  // A range from a stale render (the text changed under it) must degrade to
  // "no highlight", never to sliced-apart nonsense.
  if (!(s >= 0 && e > s && e <= text.length)) return [text, '', ''];
  return [text.slice(0, s), text.slice(s, e), text.slice(e)];
}

/**
 * FTS5's `snippet()` wraps each matched term in the delimiters the server asks
 * for — `«` and `»` (server/src/archive/ArchiveDb.ts). Split them back out so a
 * message row can bold what matched instead of showing the guillemets raw.
 *
 * Tolerant by construction: an unbalanced or absent delimiter yields plain
 * text rather than swallowing the rest of the snippet. The pairing is a
 * PRESENTATION detail of a string we did not build, so it must never be able
 * to lose content.
 */
export function snippetParts(snippet: string): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let rest = snippet;
  while (rest.length > 0) {
    const open = rest.indexOf('«');
    if (open < 0) break;
    const close = rest.indexOf('»', open + 1);
    if (close < 0) break;
    if (open > 0) out.push({ text: rest.slice(0, open), hit: false });
    out.push({ text: rest.slice(open + 1, close), hit: true });
    rest = rest.slice(close + 1);
  }
  if (rest.length > 0) out.push({ text: rest, hit: false });
  return out;
}

/** The workspace-grouped shape `GET /api/tabs/all` answers with. */
export interface WorkspaceTabs {
  id: string;
  slug: string;
  name: string;
  tabs: Tab[];
}

/** Flatten the grouped payload into the corpus `rankTabs` consumes. */
export function toSearchableTabs(groups: readonly WorkspaceTabs[]): SearchableTab[] {
  const out: SearchableTab[] = [];
  for (const g of groups) {
    for (const t of g.tabs) {
      out.push({
        tabId: t.id,
        tabSlug: t.slug,
        tabName: t.name,
        // `headline` is nullable on the wire (a chat that never got one);
        // the corpus only distinguishes "have it" from "don't".
        headline: t.headline ?? undefined,
        icon: t.icon,
        workspaceId: g.id,
        workspaceSlug: g.slug,
        workspaceName: g.name,
        status: t.status,
        unread: t.unread,
        pinned: t.pinned,
        lastActivityAt: t.last_activity_at,
        lastUserAt: t.last_user_at,
        // BOTH OF THESE WERE ON THE WIRE AND DROPPED HERE. `done` left
        // `SCORE.donePenalty` unreachable for every ⌘K query, and `spawned_by`
        // left the recents list unable to tell a conversation from a worker.
        done: t.done,
        spawnedBy: t.spawned_by,
        paneIds: collectLayoutLeaves(t.layout),
      });
    }
  }
  return out;
}

/**
 * pane id → the tab that owns it, for resolving a content hit's
 * `session.pane_id` to a route. A pane that no longer exists in any layout is
 * simply absent, which is how the caller drops dead rows rather than offering
 * a link that goes nowhere.
 */
export function paneIndex(tabs: readonly SearchableTab[]): Map<string, SearchableTab> {
  const out = new Map<string, SearchableTab>();
  for (const t of tabs) {
    for (const p of t.paneIds) if (!out.has(p)) out.set(p, t);
  }
  return out;
}
