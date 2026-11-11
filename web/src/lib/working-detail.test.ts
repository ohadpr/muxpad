import { describe, expect, it } from 'vitest';
import { workingRowDetail, workingRowLabel } from './live-status';

/**
 * THE ROW SAYS WHAT IT IS WORKING ON, NOT WHAT IT IS CALLED.
 *
 * `› 7 actions · Bash ×7 · Running Bash…` — three cells, one word, and the
 * word was the tool's name. "The word bash repeats itself a lot, try to think
 * of something more useful." The useful thing was already in the call.
 */
describe('workingRowDetail', () => {
  it('prefers the description — the sentence a person can read at a glance', () => {
    // The expanded row wants the exact command; a one-line glance does not.
    expect(
      workingRowDetail('Bash', {
        command: 'cd /Users/x && pnpm --filter web test -- --run ChatPane 2>&1 | tail -20',
        description: 'Run the ChatPane test suite',
      }),
    ).toBe('Run the ChatPane test suite');
  });

  it('falls back to the command, which still beats the tool’s name', () => {
    expect(workingRowDetail('Bash', { command: 'git log --oneline -1' })).toBe(
      'git log --oneline -1',
    );
  });

  it('names the FILE for a read or an edit', () => {
    expect(workingRowDetail('Read', { file_path: '/repo/web/src/components/ChatPane.tsx' })).toBe(
      '/repo/web/src/components/ChatPane.tsx',
    );
  });

  it('truncates rather than wrapping the row it shares', () => {
    const long = workingRowDetail('Bash', { command: 'x'.repeat(400) });
    expect(long).not.toBeNull();
    expect((long as string).length).toBeLessThanOrEqual(72);
    expect(long).toMatch(/…$/);
  });

  it('collapses newlines — a heredoc must not become three lines of chrome', () => {
    expect(workingRowDetail('Bash', { command: 'cat <<EOF\nline one\nline two\nEOF' })).toBe(
      'cat <<EOF line one line two EOF',
    );
  });

  it('gives up rather than printing JSON at somebody', () => {
    // `summarizeToolInput` falls back to a stringified object, which is worse
    // than the tool's name. That is what workingRowLabel is still for.
    expect(workingRowDetail('Weird', { depth: 3, flags: [1, 2] })).toBeNull();
    expect(workingRowLabel('Weird')).toBe('Running Weird…');
  });

  it('is null with no tool at all, so the dots stand alone', () => {
    expect(workingRowDetail(null, { command: 'ls' })).toBeNull();
  });
});
