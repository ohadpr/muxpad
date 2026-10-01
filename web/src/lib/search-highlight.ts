import { escapeRegExp } from './nav-search';

/**
 * Lighting up a search term inside a CHAT MESSAGE.
 *
 * The sidebar already highlights inside its own rows (nav-search's
 * `splitHighlight` / `snippetParts`), but a result row is one line of text with
 * one match in it. A landed-on message is a different problem in three ways,
 * and this module exists for exactly those three:
 *
 *   1. MANY OCCURRENCES, not one. `splitHighlight` takes a single range and
 *      cuts the string in three. A message that says the word five times has to
 *      light up five times, so the unit here is a LIST of runs — the same
 *      `{ text, hit }[]` shape `snippetParts` already returns, so the two can be
 *      rendered by identical JSX and there is only ever one way to paint a hit.
 *
 *   2. TERMS, not a substring. `/api/search` is FTS5 `MATCH`: typing
 *      `scroll bug` finds messages containing BOTH tokens, anywhere, in any
 *      order — the literal string "scroll bug" need never appear. Highlighting
 *      the raw query would therefore light up nothing at all on most multi-word
 *      searches. So the query is broken into terms first (`queryTerms`), and
 *      each term is highlighted on its own. That is also precisely what FTS5's
 *      own `snippet()` does to build the row you clicked, so the message you
 *      land on is marked up the same way as the result that sent you there.
 *
 *   3. MARKDOWN, not a string. Assistant text goes through react-markdown, so
 *      the highlight cannot be a string operation on the source: `**bold**` is
 *      not in the DOM, and slicing the source would corrupt the syntax. It is
 *      applied as a rehype pass over the parsed tree instead — see
 *      `rehypeSearchHighlight`.
 *
 * SAFETY. Every term is `escapeRegExp`'d (shared with nav-search, so there is
 * one escaping rule in the app, not two): a query is user text and `a.*b`
 * reaching `new RegExp` would either throw or silently match half the message.
 * Nothing here produces HTML — the runs are plain strings handed to React as
 * children, and the markdown path builds hast nodes. There is no
 * `dangerouslySetInnerHTML` on either route.
 */

/** A stretch of text, and whether it is part of a match. Same shape as
 *  `snippetParts` so both can feed the same renderer. */
export interface HighlightRun {
  text: string;
  hit: boolean;
}

/**
 * FTS5 operator words. Bare (unquoted) and upper-case, these are syntax rather
 * than something the user is looking for, so highlighting them would light up
 * every "or" and "not" in the message for a query that never asked about them.
 * Matched case-SENSITIVELY on purpose: FTS5 only treats them as operators in
 * upper case, so a search for the ordinary English word "not" still works.
 */
const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * The literal terms a query is asking about.
 *
 * `/api/search` takes a raw FTS5 MATCH expression, so the box's contents can
 * legitimately contain quoting, prefix stars and operators. Those are
 * instructions to the index, not text to find, and they are stripped here:
 *
 *   · `"exact phrase"` → the words inside it (FTS5 marks each token of a
 *     phrase match separately, and so do we);
 *   · `inv*` → `inv`, because a prefix query matched on the prefix and lighting
 *     up only the letters that matched is the honest span;
 *   · `AND` / `OR` / `NOT` / `NEAR` → dropped;
 *   · `-`, `(`, `)`, `^`, `:` and friends → separators.
 *
 * Splitting on non-letter/non-digit runs (Unicode-aware, so Hebrew and Arabic
 * words survive intact) rather than on whitespace: `foo,bar` is two terms to
 * FTS5 and must be two terms here. `_` is kept as a word character because
 * identifiers are most of what gets searched in a dev cockpit.
 *
 * Sorted LONGEST FIRST. The runs are found with one alternation, and a regex
 * alternation is first-match-wins at each position: with `["s", "scroll"]` the
 * word `scroll` would light up only its first letter. Length-descending makes
 * the longest term at any position win, which is the only ordering that yields
 * the same result regardless of how the user typed the query.
 */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.split(/[^\p{L}\p{N}_]+/u)) {
    if (!raw) continue;
    if (FTS_OPERATORS.has(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  // Length by CODE POINTS, not UTF-16 units: an emoji or a rare CJK character
  // is one character that costs two units, and sorting by `.length` would rank
  // a two-emoji term above a five-letter one.
  const size = (s: string) => [...s].length;
  return out.sort((a, b) => size(b) - size(a));
}

/**
 * One case-insensitive alternation over `terms`, or null when there is nothing
 * to match. Terms are escaped, so no metacharacter from the query survives.
 *
 * Deliberately NOT `\b`-anchored. The instant tier scores word boundaries
 * because it is ranking names; here the term has already been matched by FTS5
 * (which is prefix- and stemming-aware) and the reader's question is only
 * "where is it on this page". Refusing to mark `scroll` inside `scrolling`
 * would leave the message they were sent to looking like it has no match in it.
 */
function termsRegExp(terms: readonly string[]): RegExp | null {
  const usable = terms.filter((t) => t.length > 0);
  if (usable.length === 0) return null;
  return new RegExp(usable.map(escapeRegExp).join('|'), 'giu');
}

/**
 * Split `text` into alternating plain and matched runs.
 *
 * Non-overlapping and left-to-right: `aa` in `aaa` marks one run at 0..2 and
 * leaves the trailing `a` plain, which is both what a regex scan does and what
 * a reader expects to see. Adjacent matches are emitted as separate hit runs
 * rather than merged — they render as two `<mark>`s side by side, which is
 * visually identical and keeps this function's output a faithful description of
 * what matched.
 *
 * Returns a single plain run for a text with no matches (never an empty array
 * for non-empty text) so callers can render the result unconditionally.
 */
export function highlightRuns(text: string, terms: readonly string[]): HighlightRun[] {
  const re = termsRegExp(terms);
  if (!re || !text) return text ? [{ text, hit: false }] : [];
  const out: HighlightRun[] = [];
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    // A term that somehow reduced to an empty match would leave `lastIndex`
    // parked and spin this loop forever. `queryTerms` cannot produce one, but
    // the guard is a byte and the failure mode is a hung tab.
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

/** Does `text` contain any of `terms`? The cheap "is this the message?" test. */
export function textMatchesTerms(text: string, terms: readonly string[]): boolean {
  const re = termsRegExp(terms);
  return re ? re.test(text) : false;
}

/**
 * How many DISTINCT terms occur in `text`.
 *
 * FTS5's default conjunction means a hit for `scroll bug` contains both words,
 * so when several loaded messages mention one of them, the one that mentions
 * both is overwhelmingly the message the user was sent to. Used only to rank
 * candidates — see `pickSearchTarget`.
 */
export function termsPresent(text: string, terms: readonly string[]): number {
  let n = 0;
  for (const t of terms) {
    if (t && new RegExp(escapeRegExp(t), 'iu').test(text)) n++;
  }
  return n;
}

// ── Markdown ────────────────────────────────────────────────────────────────

/**
 * The slice of hast this pass touches. Declared structurally rather than pulled
 * from `@types/hast`: the walk only needs "has children" and "has a value", the
 * web package does not depend on the unified type packages today, and adding a
 * dependency to describe two fields would be the tail wagging the dog.
 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * A rehype plugin that wraps every occurrence of `terms` in `<mark>`.
 *
 * Runs on the PARSED tree, which is the whole point. The alternatives are both
 * wrong: marking the markdown SOURCE would put `<mark>` inside link
 * destinations and fence info-strings and break the syntax, and post-processing
 * the rendered DOM would mean mutating nodes React owns (it would blow them
 * away on the next commit) or `dangerouslySetInnerHTML` with model output.
 * Splitting hast TEXT nodes is neither: the document structure is already
 * decided, so a match can only ever land inside one text node, and every other
 * node is passed through untouched.
 *
 * Consequences worth stating, because they are deliberate:
 *
 *   · Code blocks and inline code highlight normally — their content is a text
 *     node like any other, and `<mark>` inside `<code>` is valid HTML that
 *     inherits the monospace font.
 *   · Link TEXT highlights; link HREFs do not. A URL you cannot see is not "on
 *     the page", and marking one would change nothing visible while making the
 *     tree lie about what matched.
 *   · A match that SPANS inline markup — `scr**oll**` — does not highlight,
 *     because after parsing those are two text nodes in two elements and there
 *     is no single run to mark. Correct rather than unfortunate: the rendered
 *     page really does not contain that string as one run.
 *
 * `dir` is untouched. The per-block direction MD_COMPONENTS computes reads the
 * element's text through `textOf`, which walks children — so a `<mark>` in the
 * middle of a Hebrew paragraph contributes its characters exactly as the bare
 * text did, and the paragraph's base direction is unchanged.
 */
export function rehypeSearchHighlight(terms: readonly string[]) {
  return () => (tree: HastNode) => {
    if (terms.length === 0) return;
    visit(tree, terms);
  };
}

function visit(node: HastNode, terms: readonly string[]): void {
  const kids = node.children;
  if (!kids || kids.length === 0) return;
  let rebuilt: HastNode[] | null = null;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as HastNode;
    if (child.type === 'text' && typeof child.value === 'string') {
      const runs = highlightRuns(child.value, terms);
      // Nothing matched — leave the node's identity alone so react-markdown
      // has the smallest possible diff on a re-render.
      if (!runs.some((r) => r.hit)) {
        rebuilt?.push(child);
        continue;
      }
      rebuilt ??= kids.slice(0, i);
      for (const run of runs) {
        rebuilt.push(
          run.hit
            ? {
                type: 'element',
                tagName: 'mark',
                properties: { className: ['chat-hit'] },
                children: [{ type: 'text', value: run.text }],
              }
            : { type: 'text', value: run.text },
        );
      }
      continue;
    }
    rebuilt?.push(child);
    visit(child, terms);
  }
  if (rebuilt) node.children = rebuilt;
}
