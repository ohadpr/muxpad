import { describe, expect, it } from 'vitest';
import { WATCH_TEXT_MAX, boundText, hashReading, runWatch, withWatchReading } from './watch.js';

/**
 * The point of a watch is that NOTHING HAPPENS when nothing happened.
 *
 * Measured the evening this was written: a three-minute watcher spending a
 * full model turn per check to report no change, staying quiet only because
 * its prompt asked it to. A change detector is not a judgement call, so it
 * does not belong to the model.
 */
describe('reading a watch', () => {
  it('is the same reading for the same output, and a different one when it moves', async () => {
    const a = await runWatch('printf hello');
    const b = await runWatch('printf hello');
    const c = await runWatch('printf hellp');
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
    expect(a.text).toBe('hello');
    expect(a.status).toBe('ok');
  });

  it('treats a command that STARTS FAILING as news, not as silence', async () => {
    // The failure this prevents: a watcher that goes quiet at exactly the
    // moment the thing it watches breaks.
    const ok = await runWatch('printf up');
    const bad = await runWatch('printf up; exit 3');
    expect(bad.status).toBe('exit 3');
    expect(bad.hash).not.toBe(ok.hash);
  });

  it('separates the output from the status, so neither can forge the other', () => {
    // Without a separator, output "x" + status "y" and output "xy" + status ""
    // would hash the same, and a command whose output ends in its own exit
    // text could mask a change.
    expect(hashReading('x', 'y')).not.toBe(hashReading('xy', ''));
  });

  it('does not throw on a command that cannot run', async () => {
    const r = await runWatch('definitely-not-a-real-binary-xyz');
    expect(r.status).toMatch(/^exit /);
    expect(r.hash).toBeTruthy();
  });

  it('times out rather than holding the tick forever', async () => {
    const r = await runWatch('sleep 5', { timeoutMs: 150 });
    expect(r.status).toMatch(/^timeout after 150ms/);
  }, 10_000);
});

describe('what rides into the prompt', () => {
  it("keeps the END of a long reading — a log's news is at the bottom", () => {
    const text = `${'a'.repeat(WATCH_TEXT_MAX)}THE-NEW-PART`;
    const out = boundText(text);
    expect(out).toContain('THE-NEW-PART');
    expect(out).toContain('earlier characters omitted');
    expect(out.length).toBeLessThanOrEqual(WATCH_TEXT_MAX);
  });

  it('leaves a short reading exactly as it is', () => {
    expect(boundText('  two lines\nof it  ')).toBe('two lines\nof it');
  });

  it('hands the agent the output it already has', () => {
    // Otherwise the agent's first move on every fire is a second round trip
    // to fetch what the server just fetched.
    const p = withWatchReading('summarise the change', {
      text: 'DIFF HERE',
      hash: 'h',
      status: 'ok',
    });
    expect(p).toContain('DIFF HERE');
    expect(p).toContain('do not run the command again');
    expect(p).toContain('summarise the change');
  });

  it('is the prompt untouched when there is no watch', () => {
    expect(withWatchReading('plain', null)).toBe('plain');
  });
});
