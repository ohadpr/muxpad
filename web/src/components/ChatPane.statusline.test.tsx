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

const px = (v: string | null) => {
  const value = v ?? '';
  return Number.parseFloat(value) * (value.endsWith('rem') ? 16 : 1);
};

describe('the session line cannot become two lines', () => {
  it('is one line, sized by the tool row it sits in', () => {
    // The bar has owned its own height twice — a fixed 1rem under the pill,
    // then 1.375rem as a floating chip. Inside the pill's tool row it is one
    // of two items on a line the ROW sizes, so the invariant moves: the row
    // has a one-line floor, and the bar fills it.
    expect(decl('.chat-status-bar', 'height')).toBe('100%');
    const row = px(decl('.chat-composer-tools', 'min-height'));
    expect(row).toBeGreaterThan(0);
    expect(row).toBeLessThanOrEqual(32);
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

  it('aligns to the PILL, because it is now INSIDE the pill', () => {
    // It used to carry the pill's own 768px box, so a strip laid out against
    // the pane would not sit a long way out from the thing it describes. It no
    // longer needs one: it is a child of the composer, so the pill's box is
    // its box by construction.
    expect(decl('.chat-status-bar', 'max-width')).toBeNull();
  });

  it('is right-aligned, at the far end of the composer tool row', () => {
    // It was CENTRED while it was a full-width row under the pill, to keep
    // the always-populated live cell out of a phone's bottom corner radius.
    // Sharing a row with the tools, right is the only end left — and the gap
    // between what you can ADD to a message and what the chat is RUNNING is
    // the row's whole structure.
    expect(decl('.chat-status-bar', 'justify-content')).toBe('flex-end');
    expect(decl('.chat-composer-tools > .chat-status-bar', 'margin-left')).toBe('auto');
    // AND IT IS IN FLOW. One revision hung it off the composer's top edge —
    // which cost no row, and painted over the last line of the transcript.
    expect(decl('.chat-status-bar', 'position')).toBeNull();
  });

  it('clears the home indicator by max(), never by adding to it', () => {
    // `10px + env(safe-area-inset-bottom)` spent the indicator's 34px AND 10
    // more on top: 44px of nothing under the status line, and an input bar
    // visibly floating. Reported as "move the input bar lower". max() clears
    // the indicator where there is one and keeps the 10px where there isn't.
    const pad = decl('.chat-composer-wrap', 'padding') ?? '';
    expect(pad).not.toMatch(/\+\s*env\(safe-area-inset-bottom/);
    // A floor well clear of the shadow — 10 then 16 then 22, each time for
    // the same reason: the pill carries a drop shadow, and on a theme that
    // draws a hard offset one (memphis puts it 6px down) the floor is spent
    // before any gap begins. The ARITHMETIC is what this test is about — a
    // floor, never a sum — so it pins the shape and a minimum rather than one
    // number somebody will have to come back and edit again.
    const floor = /max\((\d+)px,\s*env\(safe-area-inset-bottom/.exec(pad)?.[1];
    expect(Number(floor)).toBeGreaterThanOrEqual(16);
    // The sides are the rounded corners in landscape, same idiom.
    expect(pad).toMatch(/max\(12px,\s*env\(safe-area-inset-left/);
    expect(pad).toMatch(/max\(12px,\s*env\(safe-area-inset-right/);
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
  // Anchored on the CLASS NAME, not on `<div className=…`: the wrap grew a
  // second prop and biome split it across lines, which silently made this slice
  // empty and the assertions below vacuous. What the test is about is the ORDER
  // of things inside the wrap, and that survives formatting.
  // From the wrap to the END of the component. It used to stop at
  // `chat-composer-main`, which silently excluded everything after the pill —
  // so when the session line moved BELOW the composer the slice no longer
  // contained it at all. Both markers below occur exactly once, so comparing
  // their order over the whole region says precisely what this test means.
  const WRAP = SRC.slice(
    SRC.indexOf('className="chat-composer-wrap"'),
    SRC.indexOf('// Everything that draws an ALREADY-ARRIVED message'),
  );

  it('is in the composer tool row, on every layout', () => {
    // It has been under the pill, above the pill, inside the pill's tool row,
    // in the app's top bar, and in a head of its own — twice. The question
    // came back every time it went to the top of the pane: "why is this at
    // the top right of the chat window?" Because a mock-up drew a header
    // there, and that mock-up's phone had no sidebar naming the chat.
    //
    // The tool row is the chat's own control surface and is already where you
    // attach a file. One place, both layouts.
    expect(WRAP.length).toBeGreaterThan(100);
    expect(SRC).not.toMatch(/chat-head/);
    expect(SRC).toMatch(
      /<div className="chat-composer-tools">\s*\{composerTools\}\s*\{sessionStrip\}/,
    );
    // …and never portalled out of the pane, which read as window chrome and
    // opened its menus over the carrier and the clock.
    expect(SRC).not.toMatch(/MobilePaneChrome/);
  });

  it('cannot move the composer, because its height is not a variable', () => {
    // The original defect, stated as a property rather than a screenshot: the
    // strip was above the input INSIDE a bottom-anchored pill, so a wrapped
    // strip pushed the input down. Its height is now a constant in the
    // stylesheet and the only inline style the composer measures is the
    // reserve's — nothing in this component sizes the strip at runtime.
    expect(decl('.chat-composer-tools', 'min-height')).toBeTruthy();
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

  /**
   * ── THERE IS NO CONTEXT CELL ANY MORE, IN EITHER MODE ────────────────────
   *
   * There was one, and it was the single exception to "Chat mode has no
   * dials": absent until the conversation was nearly full, then present in
   * warn and then danger ink, as the only route to Compact.
   *
   * It earned that exception only while muxpad compacted nothing by itself —
   * with no automatic compaction, the chat had to say the ceiling was coming
   * or the first news of it would be a failed turn. Compaction is automatic
   * again (see the runner's auto-compact), so the cell went back to being a
   * number asking to be watched for no action: "I don't want the user to be
   * thinking about compaction. Compaction should just happen."
   *
   * The METER did not go with it. It is in the session menu, with the token
   * counts and Compact now — strictly more information, one tap away, for the
   * moments somebody actually wants to know.
   */
  it('shows no context cell, at any fullness, in either mode', () => {
    for (const mode of ['chat', 'agent'] as const) {
      for (const pct of [25, 72, 93, 99]) {
        const box = mount({
          mode,
          status: { ...STATUS, context: { pct, tokens: pct * 10_000, max: 1_000_000 } },
        });
        expect(box.querySelector('.chat-status-seg.-ctx'), `${mode} @ ${pct}%`).toBeNull();
      }
    }
  });

  it('keeps the meter and Compact one tap away, in the session menu', async () => {
    const sent: unknown[] = [];
    const box = mount({
      mode: 'agent',
      status: { ...STATUS, context: { pct: 80, tokens: 800_000, max: 1_000_000 } },
      send: (m: unknown) => sent.push(m),
    });
    await act(async () => {
      box.querySelector<HTMLButtonElement>('.chat-status-seg')?.click();
    });
    expect(box.querySelector('.chat-session-bar-fill')).not.toBeNull();
    const compact = [...box.querySelectorAll<HTMLButtonElement>('.chat-session-item')].find((b) =>
      b.textContent?.includes('Compact'),
    );
    expect(compact).toBeTruthy();
    await act(async () => {
      compact?.click();
    });
    const msg = sent[0] as { t: string; cmd: string; args?: string };
    expect(msg.t).toBe('slash');
    expect(msg.cmd).toBe('compact');
    // Unguided, this is where a 216k-token thread becomes 4.7k.
    expect(msg.args).toContain('Preserve the specifics');
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

/**
 * BACKGROUND SHELL COMMANDS — the one piece of live work the cockpit used to
 * show nothing for.
 *
 * A `Bash` call the agent backgrounded keeps running after the turn that
 * started it ends. Nothing rendered while it ran; a completion notice arrived
 * in the log minutes later, and the reasonable reaction to it was "what is
 * this, and why is it not a sub-agent?".
 *
 * The answer the cell has to give is the WORD. A sub-agent is a conversation
 * with a pane, a transcript and a report; this is a process with an exit code,
 * and a cell saying "1 running" beside a rail that counts sub-agents would
 * merge the two in the reader's head.
 */
describe('the background-command cell', () => {
  let host: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  function bar(props: Partial<Parameters<typeof SessionBar>[0]>) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <SessionBar
          paneId="p1"
          folder={null}
          status={null}
          send={() => {}}
          liveLabel={null}
          agents={[]}
          mode="agent"
          {...props}
        />,
      );
    });
    return host;
  }
  const cell = (box: HTMLElement) => box.querySelector('[data-testid="chat-status-bg"]');

  it('renders nothing when no command is running — the common case', () => {
    expect(cell(bar({}))).toBeNull();
    expect(cell(bar({ background: 0 }))).toBeNull();
  });

  it('names the thing — a bg COMMAND, never an agent, never a bare number', () => {
    const text = cell(bar({ background: 1 }))?.textContent ?? '';
    expect(text).toBe('1 bg command');
    expect(text.toLowerCase()).not.toContain('agent');
  });

  it('counts, and pluralises', () => {
    expect(cell(bar({ background: 3 }))?.textContent).toBe('3 bg commands');
  });

  it('spells out in the tooltip what it is and what it is NOT', () => {
    // The cell has two words; the hover is where the distinction can live.
    const title = cell(bar({ background: 2 }))?.getAttribute('title') ?? '';
    expect(title).toContain('Bash');
    expect(title.toLowerCase()).toContain('not a sub-agent');
    expect(title).toContain('exit code');
  });

  it('does not animate — a composer strip that pulses for minutes is worse', () => {
    const css = readFileSync(join(import.meta.dirname, 'ChatPane.css'), 'utf8');
    const rule = /\.chat-status-seg\.-bg\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).not.toContain('animation');
    // And it must not be the cell the line clips away.
    expect(rule).toContain('min-width: max-content');
  });

  it('coexists with the other cells rather than replacing them', () => {
    const box = bar({ background: 1, mode: 'chat', liveLabel: liveStatusLabel({ chats: 2 }) });
    expect(cell(box)).not.toBeNull();
    expect(box.querySelector('.chat-status-seg.-mode')).not.toBeNull();
  });
});

/**
 * BRANCH IS NOT ON THIS STRIP. It was the one chip here that was a verb
 * rather than a fact, and it is a COMMAND — so it moved to where the composer
 * keeps commands (the tool row on a desktop, the `+` sheet on a phone) under
 * the name the report gave it: "btw…". ChatPane.tools.test owns it now.
 */
describe('the session strip carries facts, not commands', () => {
  it('renders no branch control of its own', () => {
    expect(readFileSync(join(__dirname, 'ChatStart.tsx'), 'utf8')).not.toMatch(
      /chat-status-seg -branch/,
    );
    expect(css).not.toMatch(/\.chat-status-seg\.-branch\s*\{/);
  });
});

/**
 * AND ITS MENUS RISE, which is the default and now the only case: the strip
 * is at the bottom of the pane, where up is the one direction with room. The
 * downward anchor existed for the head, which is gone.
 */
describe('a menu opened from the strip', () => {
  it('rises from the chip', () => {
    expect(decl('.chat-status-menu', 'bottom')).toBe('calc(100% + 6px)');
  });

  it('has no downward variant left over from the head', () => {
    expect(bare(css).includes('.chat-head')).toBe(false);
  });
});

/**
 * THE MODE CHIP EXPLAINS ITSELF — AND IS STILL NOT A SWITCH.
 *
 * It carried a native `title` and nothing else, which failed the only reader
 * who needs it: "add some on-hover info, a sentence or something saying what
 * this is." A `title` takes about a second to appear, is unstyled, and does
 * not exist at all on a phone — where this chip lives inside the composer's
 * `+` sheet.
 */
describe('the mode chip', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  function chat(): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <SessionBar
          paneId="p1"
          folder={null}
          status={null}
          send={() => {}}
          liveLabel={null}
          agents={[]}
          mode="chat"
        />,
      );
    });
    return host;
  }

  it('is pressable, and opens a panel rather than a menu of modes', () => {
    const box = chat();
    const chip = box.querySelector<HTMLButtonElement>('.chat-status-seg.-mode');
    expect(chip?.tagName).toBe('BUTTON');
    act(() => chip?.click());
    const panel = box.querySelector('.chat-status-menu');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('dialog');
  });

  it('says what the mode IS, in the words that define it', () => {
    const box = chat();
    act(() => box.querySelector<HTMLButtonElement>('.chat-status-seg.-mode')?.click());
    expect(box.querySelector('.chat-status-menu')?.textContent).toMatch(/muxpad’s assistant/);
  });

  it('answers the next question: how to actually change it', () => {
    // No harness can rewrite a running session's instructions, so a switch
    // here could only deliver the new contract as a message the conversation
    // drifts from. Saying so beats offering a control that under-delivers.
    const box = chat();
    act(() => box.querySelector<HTMLButtonElement>('.chat-status-seg.-mode')?.click());
    const text = box.querySelector('.chat-status-menu')?.textContent ?? '';
    expect(text).toMatch(/keeps the mode it was created in/);
    expect(text).toMatch(/open a new chat in Agent mode/i);
  });

  it('offers no way to switch the running pane', () => {
    const box = chat();
    act(() => box.querySelector<HTMLButtonElement>('.chat-status-seg.-mode')?.click());
    const panel = box.querySelector('.chat-status-menu');
    // Nothing in there is actionable: it is an explanation, not a picker.
    expect(panel?.querySelectorAll('button')).toHaveLength(0);
  });
});

/**
 * ── THE "older build" CELL ───────────────────────────────────────────────
 *
 * A runner outlives every server restart (restarting one kills its in-flight
 * work), so a pane can sit for days on code the server no longer runs — and
 * the only symptom is an agent that does not know about something that
 * shipped since, which reads as the agent being wrong. server/src/
 * runner-build.ts defines what "stale" means; this is the part that says so.
 */
describe('the older-build cell', () => {
  let host: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  function bar(props: Partial<Parameters<typeof SessionBar>[0]>) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <SessionBar
          paneId="p1"
          folder={null}
          status={null}
          send={() => {}}
          liveLabel={null}
          agents={[]}
          mode="agent"
          {...props}
        />,
      );
    });
    return host;
  }
  const cell = (box: HTMLElement) =>
    box.querySelector<HTMLElement>('[data-testid="chat-status-stale"]');

  it('is absent in the healthy case — which is almost every pane', () => {
    expect(cell(bar({}))).toBeNull();
    expect(cell(bar({ stale: false }))).toBeNull();
  });

  it('appears when the runner is on another build, in either mode', () => {
    expect(cell(bar({ stale: true }))?.textContent).toBe('older build');
    expect(cell(bar({ stale: true, mode: 'chat' }))).not.toBeNull();
  });

  it('opens a panel that says what is missing and what restarting costs', () => {
    const box = bar({ stale: true });
    act(() => {
      cell(box)?.click();
    });
    const text = box.querySelector('.chat-status-menu')?.textContent ?? '';
    // The consequence, not the mechanism: the agent is missing what shipped
    // since it started.
    expect(text).toMatch(/instructions/i);
    // …and the cost of the fix, because respawning kills background work.
    expect(text).toMatch(/background work/i);
    expect(text).toMatch(/wake-ups/i);
  });

  it('offers no restart button — the moment is the user’s to pick', () => {
    // A control here would respawn the pane in passing, ending background
    // subagents and scheduled wake-ups it may be holding.
    const box = bar({ stale: true });
    act(() => {
      cell(box)?.click();
    });
    expect(box.querySelector('.chat-status-menu')?.querySelectorAll('button')).toHaveLength(0);
  });

  it('is a warning tone, never the danger colour — nothing is broken', () => {
    // The old folder cell's red `!` told people their chat was broken when it
    // was merely not a project. Same mistake, same cell, do not repeat it.
    const rule = /\.chat-status-seg\.-stale\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).not.toContain('--chat-danger');
    // `--chat-warn`, which resolves to the amber every theme tunes. The
    // assertion used to be `toContain('--warn')` — which `--chat-warn` also
    // satisfies, so it would have gone on passing while the cell was
    // unreadable. See the suite below for what it is actually pinned to now.
    expect(rule).toContain('--chat-warn');
    // Two words that ellipsize to "older…" say nothing.
    expect(rule).toContain('min-width: max-content');
  });
});

/**
 * ── THE LIVE CELL'S COLOUR IS DECLARED ONCE ──────────────────────────────
 *
 * It was measured at 4.06:1 on riso at 11px/600 — below AA, and the dimmest
 * text on a strip where every other cell sat at 8.08. A saturated accent is
 * frequently the dimmest colour a theme owns.
 *
 * The first fix changed nothing, because the rule already ended with
 * `color: var(--chat-accent)` five lines further down and the later
 * declaration won. That is the failure this test exists for: not the value,
 * the DUPLICATE.
 */
describe('the live cell’s ink', () => {
  const rule = (() => {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = flat.indexOf('.chat-status-seg.-live {');
    return i < 0 ? '' : flat.slice(i, flat.indexOf('}', i));
  })();

  it('declares `color` exactly once', () => {
    expect(rule, 'the live rule is missing').not.toBe('');
    expect(rule.match(/(^|[\s;])color:/g) ?? []).toHaveLength(1);
  });

  it('is mixed toward the body ink, not the bare accent', () => {
    expect(rule).toMatch(/color:\s*color-mix\(in srgb, var\(--chat-accent\)/);
    expect(rule).not.toMatch(/color:\s*var\(--chat-accent\)\s*;/);
  });

  it('leaves the spinning MARK on the pure accent', () => {
    // A ring has no reading threshold to clear, and it is what carries the hue.
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = flat.indexOf('.chat-status-seg.-live svg {');
    expect(flat.slice(i, flat.indexOf('}', i))).toMatch(/color:\s*var\(--chat-accent\)/);
  });
});

/**
 * ── THE LIVE CELL YIELDS WHEN NOTHING ELSE CAN ───────────────────────────
 *
 * The first attempt at this measured as doing nothing, twice over: it targeted
 * `.chat-status-seg.-live` when the flex item is the WRAPPER (that rule says
 * so in its own comment), and it sat EARLIER in the file than the label rule
 * it had to beat. Both are pinned here, because "I wrote a rule" and "the rule
 * wins" are different claims and only the second one matters.
 */
describe('the live cell under a narrow composer', () => {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('makes the composer tool row a query container', () => {
    // A pane's width has nothing to do with the viewport's: two panes side by
    // side on a 1500px screen each get a ~400px row.
    const i = flat.indexOf('.chat-composer-tools {');
    const body = flat.slice(i, flat.indexOf('}', i));
    expect(body).toMatch(/container-type:\s*inline-size/);
    expect(body).toMatch(/container-name:\s*composer-tools/);
  });

  it('targets the WRAPPER, which is the flex item', () => {
    const q = flat.slice(flat.indexOf('@container composer-tools'));
    expect(q.slice(0, q.indexOf('\n}\n'))).toContain('.chat-status-seg-wrap.-live');
  });

  it('undoes every "never give way" the base rule sets', () => {
    // The base rule pins flex-shrink, width, max-width and min-width. Naming
    // only min-width and overflow left the button at full width inside a
    // wrapper that had shrunk, so the label was hard-clipped mid-word instead
    // of ellipsized — measured, twice.
    const q = flat.slice(flat.indexOf('@container composer-tools'));
    const block = q.slice(0, q.indexOf('\n}\n'));
    expect(block).toMatch(/flex-shrink:\s*1/);
    expect(block).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('is declared AFTER the rules it has to beat', () => {
    const q = flat.indexOf('@container composer-tools');
    expect(q).toBeGreaterThan(flat.indexOf('.chat-status-seg-wrap.-live {'));
    expect(q).toBeGreaterThan(flat.indexOf('.chat-status-seg.-live .chat-status-seg-label {'));
  });
});

/**
 * ── THE WARNING HUE COMES FROM A TOKEN THEMES DEFINE ─────────────────────
 *
 * It named `--warn`, which NO theme defines, so every one of them fell
 * through to `--hit-bg` — the search-highlight BACKGROUND, a colour chosen to
 * sit behind black text. As text on a light composer that measured about
 * 1.8:1: the one cell whose job is to be noticed, in the one colour nobody
 * could read.
 */
describe('the older-build cell’s colour', () => {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const appCss = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');

  it('does not reach for a token no theme sets', () => {
    expect(flat).not.toMatch(/var\(--warn[,)]/);
    expect(appCss, 'if a theme ever defines --warn this test should be revisited').not.toMatch(
      /--warn:/,
    );
  });

  it('never uses a search-highlight BACKGROUND as text', () => {
    const rule = flat.slice(flat.indexOf('.chat-status-seg.-stale {'));
    expect(rule.slice(0, rule.indexOf('}'))).not.toContain('--hit-bg');
  });

  it('uses the amber the themes actually tune', () => {
    // --status-working is per-theme: #e8b34b on the dark rails, #8a6410 and
    // #96650b on the light ones, which is the whole point.
    expect(flat).toMatch(/--chat-warn:\s*var\(--status-working/);
    const themed = (appCss.match(/--status-working:/g) ?? []).length;
    expect(themed, 'every theme tunes it').toBeGreaterThan(5);
  });
});
