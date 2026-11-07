import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tab } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { groupChats } from './NavTree';

/**
 * WHICH WORKERS THE RAIL SHOWS, AND WHERE.
 *
 * `groupChats` decides what you can see, so it is the one part of the rail
 * tested against a list rather than by eye. The rule changed shape here: it
 * used to be about KIND — a sub-chat is a detail of a chat, so it lives in
 * that chat's drawer — and it is now about STATE. Still working and it is a
 * row, because something is happening that you may want to look at or stop;
 * delivered and it is a detail, because its result is already a card in its
 * parent's log.
 */
const tab = (id: string, o: Partial<Tab> = {}): Tab =>
  ({
    id,
    name: id,
    slug: id,
    created_at: 1,
    updated_at: 1,
    layout: '' as never,
    ...o,
  }) as Tab;

const ids = (gs: { chat: Tab }[]) => gs.map((g) => g.chat.id);

describe('running workers are rows, and they come first', () => {
  it('lists a running worker above the conversations', () => {
    const { live } = groupChats([
      tab('chat-a'),
      tab('chat-b'),
      tab('worker', { spawned_by: 'chat-a' }),
    ]);
    expect(ids(live)).toEqual(['worker', 'chat-a', 'chat-b']);
  });

  it('marks it as a worker, which is how the row reads as subordinate', () => {
    const { live } = groupChats([tab('chat-a'), tab('worker', { spawned_by: 'chat-a' })]);
    expect(live[0]?.worker).toBe(true);
    expect(live[1]?.worker).toBeUndefined();
  });

  it('hides a DELIVERED worker — its result is a card in the parent’s log', () => {
    const { live, done } = groupChats([
      tab('chat-a'),
      tab('worker', { spawned_by: 'chat-a', done: true }),
    ]);
    expect(ids(live)).toEqual(['chat-a']);
    // …and it does not clutter the archive either, which is what the drawer
    // was introduced to fix.
    expect(ids(done)).toEqual([]);
  });

  it('keeps a running worker whose parent has retired', () => {
    // The case the old hand-written exception existed for. Now it is just the
    // ordinary rule, so there is one path instead of two.
    const { live, done } = groupChats([
      tab('chat-a', { done: true }),
      tab('worker', { spawned_by: 'chat-a' }),
    ]);
    expect(ids(live)).toEqual(['worker']);
    expect(ids(done)).toEqual(['chat-a']);
  });

  it('flattens a chain of handoffs to the root, and lists each running link', () => {
    const { live } = groupChats([
      tab('chat-a'),
      tab('w1', { spawned_by: 'chat-a' }),
      tab('w2', { spawned_by: 'w1' }),
    ]);
    expect(ids(live)).toEqual(['w1', 'w2', 'chat-a']);
  });

  it('promotes a worker whose parent is not in this list', () => {
    const { live } = groupChats([tab('orphan', { spawned_by: 'elsewhere' })]);
    expect(ids(live)).toEqual(['orphan']);
    // It is nobody's worker HERE, so it is not drawn as one.
    expect(live[0]?.worker).toBeUndefined();
  });

  it('survives a spawned_by cycle without losing anybody', () => {
    const { live } = groupChats([tab('a', { spawned_by: 'b' }), tab('b', { spawned_by: 'a' })]);
    expect(ids(live).sort()).toEqual(['a', 'b']);
  });
});

describe('the row says it in the ink', () => {
  const CSS = readFileSync(join(import.meta.dirname, 'NavTree.css'), 'utf8');
  const TSX = readFileSync(join(import.meta.dirname, 'NavTree.tsx'), 'utf8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('styles the attribute it emits — both halves, like the guard requires', () => {
    expect(code(CSS)).toContain("[data-worker='true']");
    expect(code(TSX)).toContain("data-worker={worker ? 'true' : undefined}");
  });

  it('uses the read-ink token rather than a new colour', () => {
    const rule = code(CSS).match(/\[data-worker='true'\] \.navtree-name-text \{([^}]*)\}/)?.[1];
    expect(rule).toMatch(/var\(--nt-ink-read\)/);
  });
});
