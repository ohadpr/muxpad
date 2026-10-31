import { type PaneStatus, STATUS_ORDER, type Tab, collectLayoutLeaves } from '@muxpad/shared';

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
  /** The chat is finished — archived, decayed, or a sub-chat that delivered.
   *  Absent on the sidebar's corpus; the mention picker supplies it. */
  done?: boolean | undefined;
  /** Layout leaves — how a content hit's `session.pane_id` finds its tab. */
  paneIds: string[];
}

/** Which field the query hit. Also decides where the highlight is painted. */
export type MatchField = 'name' | 'headline' | 'workspace';

export interface TabMatch {
  tab: SearchableTab;
  field: MatchField;
  /** [start, end) of the matched run, in the ORIGINAL field text's coordinates. */
  range: readonly [number, number];
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
const SCORE = {
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

interface FieldHit {
  range: readonly [number, number];
  /** 'exact' | 'prefix' | 'word' | 'sub' — the strongest placement found. */
  kind: 'exact' | 'prefix' | 'word' | 'sub';
}

/**
 * Best placement of `query` inside `text`, case-insensitively.
 *
 * Matches with a RegExp against the ORIGINAL string rather than comparing
 * lowercased copies: `toLowerCase()` is not length-preserving for every
 * codepoint (İ → i̇ is one char becoming two), so offsets taken from a
 * lowercased haystack can land mid-grapheme in the real one and the highlight
 * slices the wrong characters. The `i` flag folds case without moving indices.
 */
function findBest(text: string, query: string): FieldHit | null {
  if (!text || !query) return null;
  const re = new RegExp(escapeRegExp(query), 'gi');
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

function nameScore(kind: FieldHit['kind']): number {
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
      match.field === 'name' ? match.range[1] - match.range[0] : 0,
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
