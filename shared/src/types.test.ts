import { describe, expect, it } from 'vitest';
import {
  LayoutNodeSchema,
  PaneSpecSchema,
  type PaneStatus,
  STATUS_ORDER,
  WorkspaceSchema,
  maxStatus,
  rollupStatus,
} from './types';

describe('domain schemas', () => {
  it('parses a leaf layout node', () => {
    expect(LayoutNodeSchema.parse('pane-abc')).toBe('pane-abc');
  });

  it('parses a split layout node', () => {
    const node = { direction: 'row' as const, splitPercentage: 50, first: 'a', second: 'b' };
    expect(LayoutNodeSchema.parse(node)).toEqual(node);
  });

  it('parses a deeply nested layout', () => {
    const node = {
      direction: 'row' as const,
      first: { direction: 'column' as const, first: 'a', second: 'b' },
      second: 'c',
    };
    expect(LayoutNodeSchema.parse(node)).toEqual(node);
  });

  it('rejects unknown direction', () => {
    expect(() =>
      LayoutNodeSchema.parse({ direction: 'diagonal', first: 'a', second: 'b' }),
    ).toThrow();
  });

  it('parses a pane spec with defaults', () => {
    const p = PaneSpecSchema.parse({
      id: 'p1',
      tab_id: 't1',
      shell: '/bin/zsh',
      cwd: '/tmp',
      created_at: 0,
    });
    expect(p.startup_cmd).toBeNull();
    expect(p.env).toBeNull();
  });

  it('parses a workspace', () => {
    const w = WorkspaceSchema.parse({
      id: 'w1',
      slug: 'dev',
      name: 'Dev',
      position: 0,
      created_at: 0,
      updated_at: 0,
      tab_count: 0,
    });
    expect(w.slug).toBe('dev');
  });

  it('rolls statuses up in STATUS_ORDER precedence', () => {
    expect(rollupStatus([])).toBe('idle');
    expect(rollupStatus(['idle', 'ready', 'working'])).toBe('working');
    // dead outranks done: "it crashed" must not be masked by "it finished".
    expect(rollupStatus(['ready', 'dead'])).toBe('dead');
    expect(rollupStatus(['dead', 'blocked', 'working'])).toBe('blocked');
    expect(STATUS_ORDER.indexOf('dead')).toBeLessThan(STATUS_ORDER.indexOf('ready'));
  });

  it('clamps an UNKNOWN status to the bottom instead of letting it win', () => {
    // `indexOf` returns -1 for a value not in STATUS_ORDER, which compares as
    // the HIGHEST precedence — so one unrecognised string (a newer server, a
    // hand-built row) used to outrank `blocked` and swallow every real signal
    // in the rollup. Losing information about the unknown is fine; losing the
    // whole status rail is not.
    const bogus = 'sideways' as PaneStatus;
    expect(maxStatus('blocked', bogus)).toBe('blocked');
    expect(maxStatus(bogus, 'blocked')).toBe('blocked');
    expect(maxStatus('idle', bogus)).toBe('idle');
    expect(rollupStatus([bogus, 'working'])).toBe('working');
    expect(rollupStatus([bogus])).toBe('idle');
  });
});
