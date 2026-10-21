import { describe, expect, it } from 'vitest';
import { cardLineMarkdown, cardLineText } from './card-line';

/** The card that found the bug, verbatim from the store — a close summary with
 *  two-space hard breaks and a fenced holdings table. Collapsed, it drew ten
 *  lines inside a bordered panel. */
const INVESTING = `🟢 CLOSE · NW $3.95M +$43K (+1.11%)

📈 stocks +1.22% vs SPY +0.53%
▲ VGT +$20K, ₿ +$6K
▼ GOOGL −$0.9K
✅ no action

\`\`\`
Indices   $2.29M    +$25K
MAG-6      $216K     +$1K
Cash       $579K        —
─────────────────────────
NW        $3.95M    +$43K
\`\`\``;

describe('the collapsed card is one line of markdown', () => {
  /** The invariant, and the only one that matters: whatever a card contains,
   *  what reaches the renderer has no line breaks in it. Height then follows
   *  from the text rather than from which elements the css happened to name. */
  const isOneLine = (s: string) => !s.includes('\n');

  it('previews only the headline of the card that was ten lines tall', () => {
    const line = cardLineMarkdown(INVESTING);
    expect(isOneLine(line)).toBe(true);
    expect(line).toBe('🟢 CLOSE · NW $3.95M +$43K (+1.11%)');
  });

  it('keeps inline formatting, which costs no height', () => {
    const line = cardLineMarkdown('**V2.1** [docs](http://x.test) `npm run build`');
    expect(line).toBe('**V2.1** [docs](http://x.test) `npm run build`');
  });

  it('drops the markers of blocks it cannot have', () => {
    expect(cardLineMarkdown('# Build\n\n- one\n- two\n\n---\n\n> note')).toBe('Build');
    expect(cardLineMarkdown('1. first\n2. second')).toBe('first');
  });

  it('does not pull a later code block into the headline', () => {
    expect(cardLineMarkdown('head\n\n```\nstill here')).toBe('head');
  });

  it('delimits a code span longer than any backtick run inside it', () => {
    const line = cardLineMarkdown('```\na ``b`` c\n```');
    expect(line).toBe('```a ``b`` c```');
  });

  it('pads a span whose content starts or ends with a backtick', () => {
    // Without the pad this closes early and the rest leaks out as prose.
    expect(cardLineMarkdown('```\n`x`\n```')).toBe('`` `x` ``');
  });

  it('is empty for a card that is only layout', () => {
    expect(cardLineMarkdown('\n\n---\n\n')).toBe('');
  });
});

it('previews only the first code row, including an unterminated fence', () => {
  expect(cardLineMarkdown('```\nfirst row\nsecond row')).toBe('`first row`');
});
it('skips leading blank lines without joining later content', () => {
  expect(cardLineMarkdown('\r\n\r\n**Summary**  \r\nDetails')).toBe('**Summary**');
  expect(cardLineText('\nSummary\nDetails')).toBe('Summary');
  expect(cardLineText('\n  \n')).toBe('');
});
