import { describe, it, expect } from 'vitest';
import { WorkspaceSchema, PaneSpecSchema, LayoutNodeSchema } from './types';

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
      workspace_id: 'w1',
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
      layout: 'pane-1',
      created_at: 0,
      updated_at: 0,
    });
    expect(w.slug).toBe('dev');
  });
});
