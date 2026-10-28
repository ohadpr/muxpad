import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A THEME OWNS HOW THINGS LOOK. IT MUST NOT OWN WHAT STATE THEY ARE IN.
 *
 * `[data-theme="memphis"] .chat-bubble` is specificity (0,2,0); a state rule
 * written as `.chat-bubble-queued` is (0,1,0) and loses. So a message still
 * sitting in the queue rendered as an ordinary sent one on memphis, riso and
 * blueprint — same border, same offset shadow, nothing to say it had not gone
 * anywhere. Reported as "in some themes, pending messages are not styled
 * differently from regular messages". The same collision had quietly taken
 * the composer's Queue and mic buttons.
 *
 * THE RULE THIS FILE ENFORCES IS NOT "WIN THE CASCADE". Raising specificity
 * holds until the next theme writes a longer selector, and a theme is
 * SUPPOSED to own a bubble's shape. There are three honest resolutions, and
 * each of the three fixes used one:
 *   · say it with a property no theme sets (opacity, outline) — the queued
 *     bubble;
 *   · say it in WORDS, which no border can erase — the queued bubble again;
 *   · stop claiming the themed class, when the element is not that thing —
 *     the mic, which is not the composer's primary action.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(HERE, '..', 'styles.css'), 'utf8');
const CHAT = readFileSync(join(HERE, 'ChatPane.css'), 'utf8');

/** `selector { body }` pairs, comments stripped, one entry per comma'd part. */
function rulesOf(css: string): Array<{ sel: string; body: string }> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  const out: Array<{ sel: string; body: string }> = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    for (const part of (m[1] ?? '').split(','))
      if (part.trim()) out.push({ sel: part.trim().replace(/\s+/g, ' '), body: m[2] ?? '' });
  return out;
}
const classCount = (sel: string) => (sel.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length;
const propsOf = (body: string) =>
  new Set(
    body
      .split(';')
      .map((d) => d.split(':')[0]?.trim())
      .filter((p): p is string => !!p),
  );

describe('chat state survives every theme', () => {
  /** What the themes paint, keyed by the chat class they paint it on. */
  const themed = new Map<string, Array<{ sel: string; props: Set<string>; weight: number }>>();
  for (const { sel, body } of rulesOf(STYLES)) {
    if (!sel.includes('[data-theme=')) continue;
    const classes = sel.match(/\.(chat-[\w-]+)/g);
    const last = classes?.[classes.length - 1]?.slice(1);
    if (!last) continue;
    const list = themed.get(last) ?? [];
    list.push({ sel, props: propsOf(body), weight: classCount(sel) });
    themed.set(last, list);
  }

  it('finds theme rules on chat classes at all, so this cannot pass vacuously', () => {
    expect(themed.size).toBeGreaterThanOrEqual(3);
  });

  it('has no state rule a theme outranks on the same property', () => {
    const losses: string[] = [];
    for (const { sel, body } of rulesOf(CHAT)) {
      // A STATE rule: a second class or attribute on the same element, e.g.
      // `.chat-send.is-queue` or `.chat-chip[data-state="queued"]`.
      if (!/\.chat-[\w-]+[.[]/.test(sel)) continue;
      const base = /\.(chat-[\w-]+)/.exec(sel)?.[1];
      if (!base) continue;
      for (const theme of themed.get(base) ?? []) {
        const clash = [...propsOf(body)].filter((p) => theme.props.has(p));
        // Ties lose too: same weight is decided by file order, which is a
        // bundler's business and not a design decision.
        if (clash.length > 0 && classCount(sel) <= theme.weight)
          losses.push(`${sel} loses ${clash.join(', ')} to ${theme.sel}`);
      }
    }
    expect(losses, 'these states are erased by a theme').toEqual([]);
  });

  it('says PENDING with properties and words no theme can take away', () => {
    const flat = CHAT.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = flat.indexOf('.chat-bubble-queued {');
    const rule = flat.slice(i, flat.indexOf('}', i));
    // Orthogonal to every border, fill and shadow a theme draws.
    expect(rule).toMatch(/opacity:/);
    expect(rule).toMatch(/outline:/);
    // …and the word, which is the part that needs no convention to read.
    expect(flat).toMatch(/\.chat-bubble-queued::before\s*\{[^}]*content:\s*"Queued"/);
  });
});
