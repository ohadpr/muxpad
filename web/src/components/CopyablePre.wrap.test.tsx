import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyablePre } from './CopyablePre';

/**
 * A BLOCK IS WRAPPED BY DEFAULT, AND THE BUTTON UNWRAPS IT.
 *
 * It began the other way round — `white-space: pre`, right for code, with an
 * opt-in button for the rest. That was the wrong default, because most of
 * these blocks are not code: they are an email, a prompt, a report, prose the
 * agent put in a fence. For those, `pre` means the sentence disappears past
 * the right edge with nothing on screen saying there is more, and the reader
 * has to notice a control and guess what it does in order to see text written
 * to be read. "Default wrap so the text is visible."
 *
 * The cost lands where it can be paid: indentation is one press away; words
 * clipped at an edge you cannot see are not recoverable, because you never
 * knew they were there.
 */
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

/** jsdom lays nothing out, so the fixture has to declare the geometry: every
 *  one of these reads 0 unless we say otherwise.
 *
 *  `long` means "this block has a line that does not fit the box" — which the
 *  component asks TWO different ways, so the fixture answers both. Wrapped, it
 *  compares height against the logical line count; unwrapped, width against
 *  the box. One fixture flag, because it is one fact about the content. */
function withLongLines(long: boolean, lines = 1) {
  const LH = 20;
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return long ? 900 : 300;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 300;
    },
  });
  // Wrapped: a long line becomes several visual ones, so the block is taller
  // than its own line count. Measured off the rendered box, not `scrollHeight`
  // — the component reads the element the TEXT is in (see its comment: the
  // `pre` carries the prose leading, the `code` carries the code's), and
  // `scrollHeight` also includes the pre's padding.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return long ? (lines + 2) * LH : lines * LH;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = (): DOMRect => {
    const height = long ? (lines + 2) * LH : lines * LH;
    return {
      height,
      width: 300,
      top: 0,
      left: 0,
      right: 300,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  vi.stubGlobal(
    'getComputedStyle',
    () => ({ lineHeight: `${LH}px` }) as unknown as CSSStyleDeclaration,
  );
}

const mount = (text: string) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<CopyablePre>{text}</CopyablePre>);
  });
  return host;
};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
});

describe('the wrap toggle', () => {
  it('starts wrapped — the text is visible without anybody pressing anything', () => {
    withLongLines(true, 1);
    const box = mount('a very long line that runs past the right-hand edge of the block');
    expect(box.querySelector('pre')?.dataset.wrap).toBe('true');
  });

  it('is absent when nothing is actually being wrapped', () => {
    // A control that does nothing is worse than no control: it is one of two
    // things in that corner, and a reader will press it once.
    withLongLines(false);
    const box = mount('short');
    expect(box.querySelector('.copyable-block-wrap')).toBeNull();
    // …and copy is still there, which is the one that never moves.
    expect(box.querySelectorAll('.copyable-block-button')).toHaveLength(1);
  });

  it('appears beside copy when lines are being wrapped', () => {
    withLongLines(true, 1);
    const box = mount('a very long line that runs past the right-hand edge of the block');
    const wrap = box.querySelector('.copyable-block-wrap');
    expect(wrap).not.toBeNull();
    // Pressed, because wrapping is ON: the button reports the state it is in.
    expect(wrap?.getAttribute('aria-pressed')).toBe('true');
    // Before copy in the DOM, so copy keeps its position at the corner.
    const buttons = [...box.querySelectorAll('.copyable-block-button')];
    expect(buttons[0]).toBe(wrap);
  });

  it('unwraps on a press, which is what the button is for now', () => {
    withLongLines(true, 1);
    const box = mount('a very long line');
    act(() => {
      box.querySelector<HTMLButtonElement>('.copyable-block-wrap')?.click();
    });
    expect(box.querySelector('pre')?.dataset.wrap).toBeUndefined();
    expect(box.querySelector('.copyable-block-wrap')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('stays reachable while unwrapped, so you can get back', () => {
    // Unwrapping ends the condition that put the button there. Without the
    // `!wrap` half of the test the control would vanish under the pointer and
    // the reader could never turn wrapping back on.
    withLongLines(true, 1);
    const box = mount('a very long line');
    act(() => {
      box.querySelector<HTMLButtonElement>('.copyable-block-wrap')?.click();
    });
    expect(box.querySelector('.copyable-block-wrap')).not.toBeNull();
    act(() => {
      box.querySelector<HTMLButtonElement>('.copyable-block-wrap')?.click();
    });
    expect(box.querySelector('pre')?.dataset.wrap).toBe('true');
  });

  it('says what the press will DO, not what the block is', () => {
    // A toggle whose label describes the current state reads as an
    // instruction to do the thing it is already doing.
    withLongLines(true, 1);
    const box = mount('a very long line');
    const btn = box.querySelector('.copyable-block-wrap');
    expect(btn?.getAttribute('aria-label')).toMatch(/original line breaks/i);
    act(() => {
      (btn as HTMLButtonElement | null)?.click();
    });
    expect(box.querySelector('.copyable-block-wrap')?.getAttribute('aria-label')).toMatch(
      /^Wrap long lines$/,
    );
  });

  it('is per block, not a setting', () => {
    // Two blocks, one unwrapped: the other keeps the default.
    withLongLines(true, 1);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <>
          <CopyablePre>one</CopyablePre>
          <CopyablePre>two</CopyablePre>
        </>,
      );
    });
    const [first, second] = [...host.querySelectorAll('.copyable-block')];
    act(() => {
      first?.querySelector<HTMLButtonElement>('.copyable-block-wrap')?.click();
    });
    expect(first?.querySelector('pre')?.dataset.wrap).toBeUndefined();
    expect(second?.querySelector('pre')?.dataset.wrap).toBe('true');
  });
});

/**
 * …AND IT HAS TO BE SOMEWHERE YOU CAN SEE IT.
 *
 * `.copyable-block-wrap` and `.copyable-block-button` are both one class —
 * (0,1,0) each — so a tie is decided by SOURCE ORDER. The offset rule sat
 * before the base rule, the base `right: 6px` won, and the wrap button
 * rendered exactly underneath copy: in the DOM, on top of nothing, invisible.
 * "Text blocks don't have the wordwrap icon we discussed" — they did, in the
 * same 30 pixels as the other one.
 */
describe('the two buttons do not stack', () => {
  const CSS = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'CopyablePre.css'),
    'utf8',
  );

  it('offsets the wrap button AFTER the rule it has to beat', () => {
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const base = flat.indexOf('.copyable-block-button {');
    const wrap = flat.indexOf('.copyable-block-wrap {');
    expect(base).toBeGreaterThan(-1);
    expect(wrap).toBeGreaterThan(-1);
    expect(wrap, 'the offset must come after the base rule or it loses the tie').toBeGreaterThan(
      base,
    );
  });

  it('puts them at different offsets, by more than their own width', () => {
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = (sel: string) => {
      const i = flat.indexOf(`${sel} {`);
      const body = flat.slice(i, flat.indexOf('}', i));
      return Number.parseFloat(/right:\s*([\d.]+)px/.exec(body)?.[1] ?? 'NaN');
    };
    const size = (() => {
      const i = flat.indexOf('.copyable-block-button {');
      const body = flat.slice(i, flat.indexOf('}', i));
      return Number.parseFloat(/width:\s*([\d.]+)px/.exec(body)?.[1] ?? 'NaN');
    })();
    expect(at('.copyable-block-wrap') - at('.copyable-block-button')).toBeGreaterThanOrEqual(size);
  });
});

/**
 * ── AND THE RULE HAS TO REACH THE TEXT ───────────────────────────────────
 *
 * The toggle flipped `data-wrap` correctly and nothing moved: a fenced block
 * is `<pre><code>…`, `.chat-md pre code` declares its own `white-space: pre`,
 * and `white-space` is inherited — so the pre's value never reached the lines
 * it was meant to wrap. "Word wrap icon clickable but doesn't cause contents
 * to wrap."
 */
describe('the wrap rule reaches the code element', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CSS = readFileSync(join(HERE, 'CopyablePre.css'), 'utf8');
  const CHAT = readFileSync(join(HERE, 'ChatPane.css'), 'utf8');
  const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

  it('targets the code child, not only the pre', () => {
    const i = flat.indexOf('.copyable-block > pre[data-wrap="true"] code');
    expect(i, 'the selector that actually owns the text is missing').toBeGreaterThan(-1);
    const body = flat.slice(i, flat.indexOf('}', i));
    expect(body).toMatch(/white-space:\s*pre-wrap/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('out-ranks the rule it has to beat, rather than relying on order', () => {
    // `.chat-md pre code` is (0,1,2); this is (0,2,2). Order would be a
    // bundler's business, and this sheet and ChatPane.css are two files.
    expect(CHAT).toMatch(/\.chat-md pre code \{/);
    expect(flat).toMatch(/\.copyable-block > pre\[data-wrap="true"\] code/);
  });

  it('keeps the scroll lock on the PRE, which is the box that scrolls', () => {
    const i = flat.lastIndexOf('.copyable-block > pre[data-wrap="true"] {');
    const body = flat.slice(i, flat.indexOf('}', i));
    expect(body).toMatch(/overflow-x:\s*hidden/);
  });
});

/**
 * ── THE MEASUREMENT READS THE ELEMENT THE TEXT IS IN ─────────────────────
 *
 * A fenced block is `<pre><code>`, and the two carry different leading: the
 * code is at 0.8225em/1.55 (about 19.8px), the pre at the conversation's prose
 * leading (about 25.1px). Reading the pre's number and comparing it against
 * rows laid out at the code's meant a 40-line block with five wrapping lines
 * showed NO button — measured in a headless browser, it took roughly ten extra
 * wrapped rows before one appeared. The pre's 22px of padding rode along in
 * `scrollHeight` for another half-row in the same direction.
 */
describe('what the wrap measurement looks at', () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'CopyablePre.tsx'),
    'utf8',
  );

  it('measures the code child when there is one', () => {
    expect(SRC).toMatch(/firstElementChild as HTMLElement \| null\)? \?\? el/);
    expect(SRC).toMatch(/getComputedStyle\(box\)/);
  });

  it('uses the rendered box, not scrollHeight, so padding is not counted', () => {
    expect(SRC).toMatch(/box\.getBoundingClientRect\(\)\.height/);
    expect(SRC).not.toMatch(/el\.scrollHeight > lines/);
  });

  it('does not count a trailing newline as a line', () => {
    // A fenced block almost always ends in one, and counting it bought a whole
    // row of false slack in the direction that hides the button.
    expect(SRC).toContain("replace(/\\n$/, '')");
  });

  it('does not keep the button lit just because wrapping is on', () => {
    // `[aria-pressed="true"]` was in the always-visible list while wrapping
    // was the opt-in. Wrapped is the default now, so that rule lit a permanent
    // button on every block and hid the UNUSUAL state behind hover.
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'CopyablePre.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const i = css.indexOf('opacity: 1;');
    const block = css.slice(Math.max(0, css.lastIndexOf('}', i)), i);
    expect(block).not.toContain('aria-pressed');
  });
});
