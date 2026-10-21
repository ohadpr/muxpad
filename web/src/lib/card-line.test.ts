import { describe, expect, it } from 'vitest';
import { cardLineMarkdown } from './card-line';

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

  it('flattens the card that was ten lines tall', () => {
    const line = cardLineMarkdown(INVESTING);
    expect(isOneLine(line)).toBe(true);
    expect(line.startsWith('🟢 CLOSE · NW $3.95M +$43K (+1.11%) · 📈 stocks')).toBe(true);
    // The hard-broken lines are segments, not a run-on: "…no action✅ no action"
    // is exactly what flattening without a separator produced.
    expect(line).toContain('▲ VGT +$20K, ₿ +$6K · ▼ GOOGL −$0.9K · ✅ no action');
    // The table survives as ONE code span — monospace and literal, so a `*` or
    // `_` in an ascii table cannot open an emphasis run that never closes.
    expect(line).toContain('`Indices $2.29M +$25K · MAG-6 $216K +$1K');
  });

  it('keeps inline formatting, which costs no height', () => {
    const line = cardLineMarkdown('**V2.1** [docs](http://x.test) `npm run build`');
    expect(line).toBe('**V2.1** [docs](http://x.test) `npm run build`');
  });

  it('drops the markers of blocks it cannot have', () => {
    expect(cardLineMarkdown('# Build\n\n- one\n- two\n\n---\n\n> note')).toBe(
      'Build · one · two · note',
    );
    expect(cardLineMarkdown('1. first\n2. second')).toBe('first · second');
  });

  it('does not lose an unterminated fence', () => {
    // A card written mid-edit, or truncated. Dropping it would blank the card.
    expect(cardLineMarkdown('head\n\n```\nstill here')).toBe('head · `still here`');
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
