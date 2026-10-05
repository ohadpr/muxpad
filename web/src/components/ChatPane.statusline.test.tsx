import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { liveStatusLabel, sessionModelLabel, workingRowLabel } from '../lib/live-status';
import { SessionBar } from './ChatStart';

/**
 * THE SESSION LINE: out of the composer, and one line at every width.
 *
 * "Move the status line out of the composer box, it's all too tight there.
 *  Simplify the status line a bit and never should it grow more than one line
 *  long."
 *
 * It read `Agent · muxpad · claude-opus-5 · 25% · 2 agents` from inside the
 * composer pill. Two separate defects in one strip:
 *
 *   · IT WAS IN THE BOX. Sharing the pill's surface was the fix for a previous
 *     complaint (37px of a 119px bar spent on borders and gaps — see
 *     ChatPane.composer.css.test.ts) and it over-corrected: a line about the
 *     SESSION became chrome inside the thing you type in, crammed against the
 *     input with nothing between them.
 *   · IT COULD WRAP. Five cells, two of them a folder name and a raw model id,
 *     at 390px. When it wrapped it grew a line, and because the composer is
 *     bottom-anchored and the strip sat above the input inside it, growing the
 *     strip SHOVED THE COMPOSER DOWN. The thing you type in moved because of a
 *     label you never press.
 *
 * ─── Why these are CONSTRUCTION assertions, not string assertions ──────────
 * A test that says "`Agent · muxpad · Opus 5` fits in 390px" is true until
 * somebody ships a model called `claude-opus-5-thinking-20260514` or works in
 * `~/very-long-project-name`. The numbers change; the constraint does not. So
 * what is pinned here is the SET OF DECLARATIONS that make wrapping
 * impossible — a fixed one-line height on the bar, explicit `nowrap`, and a
 * truncating label in every cell — plus a scan that fails if any rule in this
 * strip ever acquires a declaration that would permit a second line.
 *
 * JSDOM has no layout engine, so geometry cannot be measured here. The real
 * measurement (320px and 390px, pathological strings, all six themes) is in
 * /tmp/sidebar/statusline.md; this file is what keeps it true afterwards.
 */

const css = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');
const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

/** Prose about a declaration is not a declaration. */
const bare = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { selector: string; body: string };

const RULES: Rule[] = [...bare(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .join(','),
  body: m[2] ?? '',
}));

function ruleBody(selector: string): string {
  const hit = RULES.find((r) => r.selector === selector);
  if (!hit) throw new Error(`no rule for ${selector}`);
  return hit.body;
}

const decl = (selector: string, prop: string): string | null => {
  // The LAST wins, as the cascade decides it within one rule.
  const all = [...ruleBody(selector).matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].filter(
    (m) => (m[1] ?? '').trim() === prop,
  );
  const hit = all[all.length - 1];
  return hit ? (hit[2] ?? '').trim() : null;
};

const px = (v: string | null) => Number((v ?? '').replace('px', ''));

describe('the session line cannot become two lines', () => {
  it('fixes the bar at exactly one line of text, so content cannot grow it', () => {
    // `height`, not `min-height` and not `max-height` alone: a fixed height is
    // the only one of the three that both reserves the line AND refuses a
    // second one. With `max-height` the children would still lay out two rows
    // and merely be clipped, which is how you get a half-visible second line.
    const h = px(decl('.chat-status-bar', 'height'));
    expect(h).toBeGreaterThan(0);
    // …and the number is the line, not a guess: the cell's line-height with no
    // block padding of its own. Same arithmetic tie the composer's 40px has.
    expect(px(decl('.chat-status-seg', 'line-height'))).toBe(h);
    const pad = (decl('.chat-status-seg', 'padding') ?? '').split(/\s+/);
    expect(pad[0]).toBe('0');
  });

  it('says nowrap out loud rather than relying on the flex default', () => {
    // `nowrap` is the initial value, so the strip has always technically had
    // it — which is exactly why this is worth writing down. An explicit
    // declaration is a thing a future edit has to consciously delete; a
    // default is a thing it can silently override from a shorthand.
    expect(decl('.chat-status-bar', 'flex-wrap')).toBe('nowrap');
  });

  it('gives every cell a label that truncates instead of pushing', () => {
    expect(decl('.chat-status-seg', 'white-space')).toBe('nowrap');
    expect(decl('.chat-status-seg', 'overflow')).toBe('hidden');
    // Without `min-width: 0` a flex item refuses to shrink below its
    // min-content width — the label would win the argument and overflow the
    // pane instead of ellipsizing.
    expect(decl('.chat-status-seg', 'min-width')).toBe('0');
    expect(decl('.chat-status-seg-label', 'overflow')).toBe('hidden');
    expect(decl('.chat-status-seg-label', 'text-overflow')).toBe('ellipsis');
  });

  it('lets the static cells shrink and never the live one', () => {
    // The live cell is the whole point of the line. When the width runs out it
    // is the folder and the model that give way — "12 agents" must read whole at
    // 320px, so it is the one item excused from shrinking.
    //
    // The WRAPPER is the bar's flex item (the button is one level down inside
    // it), so that is where the protection has to be declared. Asserting only
    // the button's `flex-shrink` would pass while the cell shrank anyway — which
    // is exactly the shape of bug this file exists to catch.
    expect(decl('.chat-status-seg-wrap.-live', 'flex')).toBe('0 0 auto');
    expect(decl('.chat-status-seg.-live', 'flex-shrink')).toBe('0');
    // …and the ordinary cells must be shrinkable, or the strip overflows the
    // pane rather than ellipsizing. `0 1 auto`: content-sized, never stretched
    // to fill the bar's full 768px, and free to give way.
    expect(decl('.chat-status-seg-wrap', 'flex')).toBe('0 1 auto');
    expect(decl('.chat-status-seg', 'flex-shrink')).not.toBe('0');
  });

  it('aligns to the PILL, not to the pane, so the desktop inherits the phone', () => {
    // Designed at 390px, where the pill is the full width and any right-hand
    // alignment looks the same. On a wide desktop the pill is 768px centered, so
    // a strip merely pushed right with `margin-left: auto` would sit a long way
    // out from the thing it describes. Same centering as the pill and the notice.
    expect(decl('.chat-status-bar', 'max-width')).toBe(decl('.chat-composer', 'max-width'));
    expect(decl('.chat-status-bar', 'justify-content')).toBe('flex-end');
  });

  /**
   * THE GUARD. Everything above pins what today's rules say; this fails if any
   * rule in the strip ever acquires a declaration that would PERMIT a second
   * line, including one nobody has written yet.
   */
  it('has no rule anywhere in the strip that would permit a second line', () => {
    const WRAPPERS: Array<[string, RegExp]> = [
      ['flex-wrap', /^wrap|^wrap-reverse/],
      ['white-space', /^normal|^pre-wrap|^pre-line|^break-spaces/],
      ['overflow-wrap', /^break-word|^anywhere/],
      ['word-break', /^break-all|^break-word/],
      ['word-wrap', /^break-word/],
    ];
    const offenders: string[] = [];
    for (const rule of RULES) {
      // The PANELS are prose and must wrap — a folder path or a subagent name
      // is a paragraph, not a cell. Only the strip itself is one line.
      if (!/chat-status-(bar|seg)/.test(rule.selector)) continue;
      if (/chat-status-menu|chat-session-|chat-folder-|chat-roster-/.test(rule.selector)) continue;
      for (const [prop, bad] of WRAPPERS) {
        for (const m of rule.body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
          if ((m[1] ?? '').trim() !== prop) continue;
          if (bad.test((m[2] ?? '').trim()))
            offenders.push(`${rule.selector} { ${prop}: ${m[2]} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the menus escaping, so one line does not mean one clipped popover', () => {
    // The fixed height above would guillotine the panels if the bar clipped.
    // Truncation happens per CELL (`.chat-status-seg`, above); the bar and the
    // cell WRAPPER stay visible so an upward menu can leave the box.
    expect(decl('.chat-status-bar', 'overflow')).toBe('visible');
    expect(decl('.chat-status-seg-wrap', 'overflow') ?? 'visible').toBe('visible');
  });
});

describe('the session line sits outside the composer pill', () => {
  /** The composer's own markup — the pill and everything inside it. */
  const WRAP = SRC.slice(
    SRC.indexOf('<div className="chat-composer-wrap"'),
    SRC.indexOf('<div className="chat-composer-main">'),
  );

  it('renders the bar as a SIBLING of the pill, before it opens', () => {
    expect(WRAP).toContain('<SessionBar');
    // Order is the assertion: the strip is emitted before the pill's own
    // element, so it cannot be a child of it.
    expect(WRAP.indexOf('<SessionBar')).toBeLessThan(
      WRAP.indexOf('<div className="chat-composer">'),
    );
  });

  it('is not a second box — no border and no background of its own', () => {
    // Kept from the height work that put it in the pill in the first place.
    // Out of the pill does NOT mean back to a bordered, filled strip floating
    // above it: that arrangement cost 37px of a 119px bar. A quiet line on the
    // transparent gap costs its own text and nothing else.
    expect(decl('.chat-status-bar', 'border')).toBeNull();
    expect(decl('.chat-status-bar', 'background')).toBeNull();
  });

  it('owns the gap to the pill itself, and spends less than the pill used to', () => {
    // Inside the pill, the pill's 6px row gap held the strip off the input. Out
    // of it, the strip's own bottom margin is the only thing that can — so this
    // margin is now REQUIRED to be non-zero (the inverse of what the composer
    // test asserts for the in-pill arrangement it replaced).
    const margin = (decl('.chat-status-bar', 'margin') ?? '').split(/\s+/);
    const below = Number((margin[2] ?? '').replace('px', ''));
    expect(below).toBeGreaterThan(0);
    // And the bar must not have grown on the way out. The strip's total cost is
    // its line plus that gap; in the pill it was its line plus the pill's row
    // gap. Same line, so the gap is the whole comparison.
    const pillGap = px(decl('.chat-composer', 'gap'));
    expect(below).toBeLessThanOrEqual(pillGap);
  });

  it('cannot move the composer, because its height is not a variable', () => {
    // The original defect, stated as a property rather than a screenshot: the
    // strip was above the input INSIDE a bottom-anchored pill, so a wrapped
    // strip pushed the input down. Its height is now a constant in the
    // stylesheet and the only inline style the composer measures is the
    // reserve's — nothing in this component sizes the strip at runtime.
    expect(decl('.chat-status-bar', 'height')).toMatch(/^\d+px$/);
    expect(SRC).not.toMatch(/className="chat-status-bar"[\s\S]{0,200}style=/);
  });
});

describe('the session line spends its width on what changes', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  const STATUS = {
    model: 'claude-opus-5',
    activeModel: 'claude-opus-5',
    context: { pct: 25, tokens: 50_000, max: 200_000 },
    models: [{ value: 'default', displayName: 'Opus', resolvedModel: 'claude-opus-5' }],
  };

  function mount(props: Partial<Parameters<typeof SessionBar>[0]>) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <SessionBar
          paneId="p1"
          folder={{ cwd: '/Users/me/muxpad', hasProject: true }}
          status={null}
          send={() => {}}
          liveLabel={liveStatusLabel({ chats: 2 })}
          agents={[
            { id: 'a', label: 'one', steps: 1, busy: true },
            { id: 'b', label: 'two', steps: 1, busy: true },
          ]}
          mode="chat"
          {...props}
        />,
      );
    });
    return host;
  }

  const cells = (box: HTMLElement) => [...box.querySelectorAll('.chat-status-bar > *')];

  it('shows two cells in Chat mode — what it is, and what is running', () => {
    // Chat has no dials: no model to pick, no context to watch, no folder
    // presented as a switch. That was already true; what is new is that this is
    // the WHOLE line, and it is asserted as a count.
    const box = mount({ mode: 'chat', status: STATUS });
    expect(cells(box)).toHaveLength(2);
    expect(box.textContent).toContain('Chat');
    expect(box.textContent).toContain('2 agents');
  });

  it('drops the mode cell in Agent mode, where the backend logo already says it', () => {
    // "Mode and folder are rarely-changing facts about the session." The mode
    // word is also REDUNDANT there: the model cell — logo and all — renders
    // only in Agent mode, so its presence is the statement. Chat mode keeps the
    // word because there the cell is the only thing on the line.
    const box = mount({ mode: 'agent', status: STATUS });
    expect(box.querySelector('.chat-status-seg.-mode')).toBeNull();
    expect(box.textContent).not.toContain('Agent');
    // …and never more than three: folder, session, live.
    expect(cells(box).length).toBeLessThanOrEqual(3);
  });

  it('keeps no percentage on the line', () => {
    // "The context percentage is the kind of thing you look for rather than
    // monitor." It moves to the session menu, which has had a labelled meter
    // and a token count the whole time — a strictly better place to look.
    const box = mount({ mode: 'agent', status: STATUS });
    expect(box.textContent).not.toContain('%');
  });

  it('still opens the roster — the one cell that had to survive all of this', () => {
    const box = mount({ mode: 'agent', status: STATUS });
    const live = box.querySelector<HTMLButtonElement>('.chat-status-seg.-live');
    expect(live).not.toBeNull();
    act(() => live?.click());
    expect(box.textContent).toContain('one');
  });

  it('reaches the context meter and the folder from the session cell', () => {
    // Nothing removed from the line may become unreachable. Both are behind the
    // one cell that is always there in Agent mode.
    const box = mount({ mode: 'agent', status: STATUS, folder: null });
    const seg = box.querySelector<HTMLButtonElement>('.chat-status-seg:not(.-live)');
    act(() => seg?.click());
    expect(box.querySelector('.chat-session-bar-fill')).not.toBeNull();
    expect(box.textContent).toContain('25%');
  });
});

describe('a model id is shortened for the line and kept whole in the menu', () => {
  it('turns a raw id into something that fits beside a folder name', () => {
    // `claude-opus-5` is 13 characters of mostly-constant prefix. The backend
    // logo beside it already says "Claude", so the vendor is the one part of
    // the string carrying no information at that spot.
    expect(sessionModelLabel('claude-opus-5')).toBe('Opus 5');
    expect(sessionModelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(sessionModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(sessionModelLabel('claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('leaves a display name the backend already chose alone', () => {
    // The menu's `displayName` is a human's word ("Opus", "Default"), not an
    // id. Rewriting those would be inventing names for models we were told the
    // name of.
    expect(sessionModelLabel('Opus')).toBe('Opus');
    expect(sessionModelLabel('gpt-5-codex')).toBe('gpt-5-codex');
  });

  it('never returns something longer than it was given', () => {
    // The whole reason this exists. A "prettifier" that lengthens the string is
    // the bug it was written to prevent.
    for (const id of [
      'claude-opus-5',
      'claude-haiku-4-5-20251001',
      'claude-3-7-sonnet-20250219',
      'Opus',
      '',
      'default',
    ]) {
      expect(sessionModelLabel(id).length).toBeLessThanOrEqual(Math.max(id.length, 1));
    }
  });
});

/**
 * THE TWO WORKING LABELS, and why only one of them carries the word.
 *
 * Reported as "this double working indication is a bit annoying": the bar above
 * the composer read `Working…` and the row in the log read `Working…`, a hundred
 * pixels apart, saying the identical thing. They were two ternaries in two files
 * with nothing connecting them — which is how it happened and why it survived.
 *
 * They are not interchangeable. The BAR is fixed: it survives scrolling away and
 * text streaming, and it carries the agent counts. The ROW is positional: it
 * sits where the reply will land and is the only surface that can name the tool
 * currently running, which the bar's 180px budget could not hold anyway.
 */
describe('only one surface says the word', () => {
  it('the row says nothing when there is no tool — the dots carry it', () => {
    expect(workingRowLabel(null)).toBeNull();
    expect(workingRowLabel(undefined)).toBeNull();
    expect(workingRowLabel('')).toBeNull();
  });

  it('…and the BAR says it in exactly that case, so the fact is never lost', () => {
    // The division of labour, asserted as a pair rather than as two beliefs.
    expect(workingRowLabel(null)).toBeNull();
    expect(liveStatusLabel({ chats: 0, turnActive: true })).toBe('Working…');
  });

  it('the row names the tool — the one thing the bar cannot fit', () => {
    expect(workingRowLabel('Bash')).toBe('Running Bash…');
  });

  it('and they never both speak at once', () => {
    // With a tool running the row is specific and the bar is generic; with no
    // tool the row is silent. Neither case repeats a string.
    const row = workingRowLabel('Bash');
    const bar = liveStatusLabel({ chats: 0, turnActive: true });
    expect(row).not.toBe(bar);
  });

  it('the bar still prefers counts, which beat the word outright', () => {
    expect(liveStatusLabel({ chats: 2, turnActive: true })).toBe('2 agents');
  });
});
