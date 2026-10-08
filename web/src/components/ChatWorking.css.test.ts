import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE WORKING INDICATOR IS A BALL WITH WEIGHT.
 *
 * ── THE MISTAKE THESE EXIST TO STOP REPEATING ───────────────────────────────
 * The previous one was a 120px moiré field, shipped on the strength of looking
 * superb AT 3× ZOOM ON A DARK BACKGROUND. The app is used on a LIGHT theme at
 * 1×, where 0.8px lines on a 2.3px pitch alias into grey hatching — the
 * interference never resolves and it reads as a rendering artifact, a full line
 * wide. "This just takes up a full line and is meh."
 *
 * So the first thing pinned here is SIZE, because the failure was not taste, it
 * was judging a 1× element at 4×. The rest pin the parts that make a shape read
 * as mass rather than as a loop — each has an obvious-looking tidy-up that
 * would quietly kill it.
 */
const css = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? null : css.slice(i, css.indexOf('\n}', i));
};

describe('the working indicator', () => {
  it('stays small enough not to own a line', () => {
    const r = rule('.chat-typing') ?? '';
    const w = Number(r.match(/width:\s*(\d+)px/)?.[1]);
    const h = Number(r.match(/height:\s*(\d+)px/)?.[1]);
    expect(w).toBeLessThanOrEqual(40); // the moiré was 120
    expect(h).toBeLessThanOrEqual(20);
  });

  it('squashes against the GROUND, not toward its own middle', () => {
    // `transform-origin: 50% 100%` is the one line that separates landing from
    // deflating. The default (50% 50%) shrinks the ball in place and the whole
    // illusion of weight goes with it.
    expect(rule('.chat-typing i')).toContain('transform-origin: 50% 100%');
  });

  it('keeps the shadow, which is the half that sells it', () => {
    // Without it this is a dot sliding up and down a line — the height means
    // nothing because there is no ground to be above.
    expect(rule('.chat-typing u')).toBeTruthy();
    const sh = rule('@keyframes chat-bounce-shadow') ?? '';
    // It must both SPREAD and FADE as the ball rises; either alone reads flat.
    expect(sh).toMatch(/scale\(0?\.\d+, 1\)/);
    expect(sh).toMatch(/opacity: 0\.0\d/);
  });

  it('hangs at the top instead of metronoming', () => {
    // The rise and fall are deliberately not symmetric: an even split reads as
    // a metronome, which is exactly the "it is on a loop" quality being avoided.
    const k = rule('@keyframes chat-bounce') ?? '';
    const stops = [...k.matchAll(/^\s*(\d+)% \{/gm)].map((m) => Number(m[1]));
    expect(stops).toContain(48);
    const rise = 48 - (stops.find((s) => s > 0 && s < 48) ?? 0);
    const fall = (stops.find((s) => s > 48 && s < 100) ?? 100) - 48;
    expect(rise).not.toBe(fall);
  });

  it('animates nothing but transform and opacity', () => {
    // Several panes can be working at once; this stays on the compositor and
    // never touches layout or paint.
    for (const k of ['@keyframes chat-bounce', '@keyframes chat-bounce-shadow']) {
      const r = rule(k) ?? '';
      expect(r).toMatch(/transform:/);
      expect(r).not.toMatch(/(width|height|background|filter|left|top|bottom):/);
    }
  });

  it('holds a static frame under reduced motion', () => {
    // `animation: none`, not `display: none` — the row must not change height
    // for somebody who asked for less movement.
    const i = css.indexOf('prefers-reduced-motion');
    const block = css.slice(i, i + 260);
    expect(block).toContain('.chat-typing i');
    expect(block).toContain('.chat-typing u');
    expect(block).toContain('animation: none');
  });
});
