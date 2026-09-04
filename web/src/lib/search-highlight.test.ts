import { describe, expect, it } from 'vitest';
import {
  type HighlightRun,
  highlightRuns,
  queryTerms,
  rehypeSearchHighlight,
  termsPresent,
  textMatchesTerms,
} from './search-highlight';

/** The runs, flattened to `plain|HIT|plain` so an expectation reads as the
 *  sentence a reader would see. */
function show(runs: HighlightRun[]): string {
  return runs.map((r) => (r.hit ? `[${r.text}]` : r.text)).join('');
}

/** Round-trip: the runs must always reassemble into the original text. This is
 *  the invariant that stops a highlight from ever LOSING content. */
function joined(runs: HighlightRun[]): string {
  return runs.map((r) => r.text).join('');
}

describe('queryTerms — what the user is actually looking for', () => {
  it('splits a multi-word query, because FTS5 matched the words, not the phrase', () => {
    // `/api/search` is a MATCH expression: "scroll bug" finds messages with
    // BOTH tokens anywhere. Highlighting the literal phrase would light up
    // nothing at all on most real searches.
    expect(queryTerms('scroll bug')).toEqual(['scroll', 'bug']);
  });

  it('sorts longest first so an alternation cannot mark only the short one', () => {
    // A regex alternation is first-match-wins at each position: with
    // ["s","scroll"] the word `scroll` would highlight a single letter.
    expect(queryTerms('s scroll sc')).toEqual(['scroll', 'sc', 's']);
  });

  it('strips FTS5 syntax — quotes, prefix stars, parens — from the terms', () => {
    expect(queryTerms('"exact phrase"')).toEqual(['phrase', 'exact']);
    expect(queryTerms('inv*')).toEqual(['inv']);
    expect(queryTerms('(alpha OR beta)')).toEqual(['alpha', 'beta']);
  });

  it('drops bare upper-case operators but keeps the ordinary English words', () => {
    expect(queryTerms('cats AND dogs')).toEqual(['cats', 'dogs']);
    // lower-case `and` is a word someone might genuinely be searching for —
    // FTS5 only treats it as an operator in upper case, and so do we.
    expect(queryTerms('and')).toEqual(['and']);
  });

  it('de-duplicates case-insensitively', () => {
    expect(queryTerms('Scroll scroll SCROLL')).toEqual(['Scroll']);
  });

  it('keeps Hebrew and Arabic words whole', () => {
    expect(queryTerms('שלום עולם')).toEqual(['שלום', 'עולם']);
  });

  it('keeps underscores — identifiers are most of what gets searched here', () => {
    expect(queryTerms('scrollTopForAnchor snake_case')).toEqual([
      'scrollTopForAnchor',
      'snake_case',
    ]);
  });

  it('is empty for a query with nothing in it', () => {
    expect(queryTerms('   ')).toEqual([]);
    expect(queryTerms('*"()')).toEqual([]);
  });
});

describe('highlightRuns — where the term is on the page', () => {
  it('marks every occurrence, not just the first', () => {
    expect(show(highlightRuns('bug, bug, bug', ['bug']))).toBe('[bug], [bug], [bug]');
  });

  it('is case-insensitive but preserves the ORIGINAL casing in the run', () => {
    expect(show(highlightRuns('Bug and BUG', ['bug']))).toBe('[Bug] and [BUG]');
  });

  it('never loses or duplicates a character', () => {
    const text = 'the scrollbug is a bug about scrolling';
    for (const q of ['bug', 'scroll bug', 'SCROLL', 'x']) {
      expect(joined(highlightRuns(text, queryTerms(q)))).toBe(text);
    }
  });

  it('takes the longest term when two overlap at the same spot', () => {
    // queryTerms already ordered them; this proves the alternation honours it.
    expect(show(highlightRuns('scrolling', queryTerms('s scroll')))).toBe('[scroll]ing');
  });

  it('handles repeated overlapping runs left-to-right without spinning', () => {
    // "aa" in "aaa" is one match at 0..2; the trailing "a" stays plain.
    expect(show(highlightRuns('aaa', ['aa']))).toBe('[aa]a');
  });

  it('marks a term inside a longer word — FTS5 is prefix-aware and so is this', () => {
    // Refusing this would leave the message the reader was SENT to looking
    // like it has no match in it.
    expect(show(highlightRuns('scrolling', ['scroll']))).toBe('[scroll]ing');
  });

  it('escapes regex metacharacters instead of executing them', () => {
    // The dangerous case: `.` must match a literal dot, not any character.
    expect(show(highlightRuns('a.c and abc', ['a.c']))).toBe('[a.c] and abc');
    expect(show(highlightRuns('cost is $5 (net)', ['$5', '(net)']))).toBe('cost is [$5] [(net)]');
  });

  it('does not throw on a query that is not a valid regex on its own', () => {
    for (const q of ['(', '[a-', '\\', '+', '*?', 'a|b']) {
      expect(() => highlightRuns('anything at all', queryTerms(q))).not.toThrow();
    }
  });

  it('marks Hebrew, and mixed Hebrew/Latin, at the right offsets', () => {
    expect(show(highlightRuns('שלום עולם שלום', ['שלום']))).toBe('[שלום] עולם [שלום]');
    expect(show(highlightRuns('the מילה word', queryTerms('מילה word')))).toBe('the [מילה] [word]');
  });

  it('does not slice a surrogate pair apart', () => {
    const runs = highlightRuns('a 🎉 party 🎉', ['🎉']);
    expect(show(runs)).toBe('a [🎉] party [🎉]');
    expect(joined(runs)).toBe('a 🎉 party 🎉');
  });

  it('returns the text as one plain run when nothing matches', () => {
    expect(highlightRuns('nothing here', ['zzz'])).toEqual([{ text: 'nothing here', hit: false }]);
    expect(highlightRuns('nothing here', [])).toEqual([{ text: 'nothing here', hit: false }]);
  });

  it('returns nothing for empty text', () => {
    expect(highlightRuns('', ['a'])).toEqual([]);
  });
});

describe('textMatchesTerms / termsPresent — is this the message?', () => {
  it('matches on any single term', () => {
    expect(textMatchesTerms('only the bug', ['scroll', 'bug'])).toBe(true);
    expect(textMatchesTerms('neither word', ['scroll', 'bug'])).toBe(false);
  });

  it('counts DISTINCT terms, which is how the real hit outranks a bystander', () => {
    expect(termsPresent('a scroll bug', ['scroll', 'bug'])).toBe(2);
    expect(termsPresent('a bug bug bug', ['scroll', 'bug'])).toBe(1);
  });

  it('escapes the terms it counts with too', () => {
    expect(termsPresent('abc', ['a.c'])).toBe(0);
  });
});

// ── The markdown route ──────────────────────────────────────────────────────

interface TestNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: TestNode[];
}

function text(value: string): TestNode {
  return { type: 'text', value };
}
function el(tagName: string, ...children: TestNode[]): TestNode {
  return { type: 'element', tagName, children };
}
function run(tree: TestNode, terms: string[]): TestNode {
  (rehypeSearchHighlight(terms)() as (t: TestNode) => void)(tree);
  return tree;
}
/** Flatten a hast tree to `plain[HIT]plain`, so the assertions read like prose
 *  and a `<mark>` in the wrong place is visible. */
function render(node: TestNode): string {
  if (node.type === 'text') return node.value ?? '';
  const inner = (node.children ?? []).map(render).join('');
  if (node.tagName === 'mark') return `[${inner}]`;
  return inner;
}

describe('rehypeSearchHighlight — marking inside rendered markdown', () => {
  it('wraps matches in <mark class="chat-hit"> and leaves the rest alone', () => {
    const tree = { type: 'root', children: [el('p', text('a bug here'))] } as TestNode;
    run(tree, ['bug']);
    const p = tree.children?.[0] as TestNode;
    expect(render(tree)).toBe('a [bug] here');
    const mark = p.children?.[1] as TestNode;
    expect(mark.tagName).toBe('mark');
    expect(mark.properties).toEqual({ className: ['chat-hit'] });
  });

  it('marks inside a CODE BLOCK without disturbing its structure', () => {
    const tree = {
      type: 'root',
      children: [el('pre', el('code', text('const bug = 1; // bug')))],
    } as TestNode;
    run(tree, ['bug']);
    expect(render(tree)).toBe('const [bug] = 1; // [bug]');
    const pre = tree.children?.[0] as TestNode;
    expect(pre.tagName).toBe('pre');
    expect((pre.children?.[0] as TestNode).tagName).toBe('code');
  });

  it('marks LINK TEXT and never the href', () => {
    const a: TestNode = {
      type: 'element',
      tagName: 'a',
      properties: { href: 'https://example.com/bug' },
      children: [text('the bug report')],
    };
    const tree = { type: 'root', children: [el('p', a)] } as TestNode;
    run(tree, ['bug']);
    expect(render(tree)).toBe('the [bug] report');
    expect(a.properties).toEqual({ href: 'https://example.com/bug' });
  });

  it('descends into nested inline markup', () => {
    const tree = {
      type: 'root',
      children: [el('p', text('a '), el('strong', text('bug')), text(' here'))],
    } as TestNode;
    run(tree, ['bug']);
    expect(render(tree)).toBe('a [bug] here');
  });

  it('leaves a non-matching text node identical, so react-markdown re-renders less', () => {
    const node = text('nothing to see');
    const tree = { type: 'root', children: [el('p', node)] } as TestNode;
    run(tree, ['bug']);
    expect((tree.children?.[0] as TestNode).children?.[0]).toBe(node);
  });

  it('does nothing at all with no terms', () => {
    const tree = { type: 'root', children: [el('p', text('a bug'))] } as TestNode;
    run(tree, []);
    expect(render(tree)).toBe('a bug');
  });

  it('marks Hebrew inside markdown', () => {
    const tree = { type: 'root', children: [el('p', text('יש כאן באג אחד'))] } as TestNode;
    run(tree, ['באג']);
    expect(render(tree)).toBe('יש כאן [באג] אחד');
  });

  it('never emits raw HTML — the mark is a NODE, and its text is a text node', () => {
    // The injection case: if the term or the message were ever concatenated
    // into markup, this is where it would show up.
    const tree = {
      type: 'root',
      children: [el('p', text('<script>alert(1)</script> and a bug'))],
    } as TestNode;
    run(tree, ['bug', '<script>']);
    const kinds = (tree.children?.[0] as TestNode).children?.map((c) => c.type);
    expect(new Set(kinds)).toEqual(new Set(['text', 'element']));
    // `<script>` isn't a term queryTerms would ever produce, but even passed
    // in raw it can only ever become the CONTENT of a mark, never a tag.
    expect(render(tree)).toContain('[bug]');
  });
});
