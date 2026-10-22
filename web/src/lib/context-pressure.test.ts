import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_INSTRUCTIONS,
  CONTEXT_HIGH_PCT,
  CONTEXT_WARN_PCT,
  compactionBlurb,
  contextLevel,
} from './context-pressure';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('context pressure', () => {
  it('says nothing until the number starts to matter', () => {
    // The meter has always lived in the session menu. A cell on the strip at
    // 12% would be one more thing on a line that cannot afford five.
    expect(contextLevel(0)).toBe('ok');
    expect(contextLevel(69)).toBe('ok');
    expect(contextLevel(CONTEXT_WARN_PCT)).toBe('warn');
    expect(contextLevel(CONTEXT_HIGH_PCT)).toBe('high');
    expect(contextLevel(100)).toBe('high');
  });

  it('is silent when there is no reading at all', () => {
    // A pane whose runner has not reported yet must not render a warning
    // about a number it does not have.
    expect(contextLevel(undefined)).toBe('ok');
    expect(contextLevel(Number.NaN)).toBe('ok');
  });

  it('warns with room left to decide', () => {
    // The whole design rests on this: nothing compacts by itself, so the
    // warning has to arrive while there is still space to act in. 70% of a
    // 1M window is ~300k tokens of headroom.
    expect(CONTEXT_WARN_PCT).toBeLessThanOrEqual(75);
    expect(CONTEXT_HIGH_PCT).toBeLessThan(95);
  });

  it('names what a compaction must keep, not how long it may be', () => {
    // The observed default on a 216k-token thread produced 4,663 tokens — the
    // shape of the conversation, without the things it was made of.
    for (const must of ['names', 'numbers', 'dates', 'decisions', 'open', 'recent'])
      expect(COMPACT_INSTRUCTIONS.toLowerCase()).toContain(must);
    // A token budget would be a request the compactor has no contract to
    // honour; content is something it can act on.
    expect(COMPACT_INSTRUCTIONS).not.toMatch(/\d+\s*(k|tokens)/i);
  });

  it('says out loud that compaction cannot be undone', () => {
    const blurb = compactionBlurb(700_000, 1_000_000);
    expect(blurb).toContain('cannot be undone');
    expect(blurb).toContain('70%');
  });
});

describe('nothing compacts on its own', () => {
  /**
   * The runner setting is the whole guarantee behind the UI in this module.
   * If it is ever re-pointed at a window, the chat silently goes back to
   * rewriting itself and every test above still passes — so this reads it.
   */
  const runner = readFileSync(
    join(HERE, '..', '..', '..', 'server', 'src', 'agent-runner', 'backends', 'claude.ts'),
    'utf8',
  );

  it('the runner disables auto-compaction rather than capping the window', () => {
    expect(runner).toContain('autoCompactEnabled: false');
    expect(runner).not.toMatch(/settings:\s*\{\s*autoCompactWindow/);
  });

  it('keeps the MANUAL compaction the button depends on', () => {
    // DISABLE_COMPACT would turn off /compact as well, which is the one path
    // left for a user who decides to compact.
    //
    // COMMENTS STRIPPED FIRST. The runner's own comment NAMES that variable,
    // to say why it is not the one being used — a test that searched the raw
    // file would fail on the sentence explaining the correct choice. (Same
    // mistake this repo already made once, reading a token name out of a CSS
    // comment.)
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toContain('autoCompactEnabled: false');
    expect(code).not.toContain('DISABLE_COMPACT');
    expect(code).not.toContain('DISABLE_AUTO_COMPACT');
  });
});
