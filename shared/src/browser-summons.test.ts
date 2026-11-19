import { describe, expect, it } from 'vitest';
import { SUMMONS_HOLD_MS } from './browser-summons.js';

/**
 * ONE NUMBER, and the test is about the fact that it is one.
 *
 * It was declared twice — server (browser/AwaitingPerson) for "is the chat
 * still parked and the browser still held", web (lib/browser-card) for "does
 * the card still offer Done". The two disagreeing contradicts the product in
 * the worst available direction: a card past the server's hold wakes an agent
 * about an errand already written off, and a card that stops early leaves a
 * parked agent with no mechanical way back — which is the lost evening this
 * mechanism exists because of.
 */
describe('SUMMONS_HOLD_MS', () => {
  it('is two hours — long enough for the 41-minute absence it was measured on', () => {
    expect(SUMMONS_HOLD_MS).toBe(2 * 60 * 60 * 1000);
    // The other harness's 30 minutes would have lost that page.
    expect(SUMMONS_HOLD_MS).toBeGreaterThan(41 * 60 * 1000);
  });

  it('is declared exactly once in the repo', async () => {
    // The point of the module. A second `export const SUMMONS_HOLD_MS`
    // anywhere is the bug coming back, and it comes back by being convenient.
    const { execFileSync } = await import('node:child_process');
    const root = new URL('../..', import.meta.url).pathname;
    const out = execFileSync(
      'grep',
      [
        '-rn',
        '--include=*.ts',
        '--include=*.tsx',
        'const SUMMONS_HOLD_MS',
        `${root}server/src`,
        `${root}web/src`,
        `${root}shared/src`,
      ],
      { encoding: 'utf8' },
    ).trim();
    const declarations = out.split('\n').filter((l) => l.includes('SUMMONS_HOLD_MS ='));
    expect(declarations.map((l) => l.replace(root, ''))).toEqual([
      expect.stringContaining('shared/src/browser-summons.ts'),
    ]);
  });
});
