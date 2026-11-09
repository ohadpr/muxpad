import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tab } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { groupChats } from './NavTree';

/**
 * WHICH WORKERS THE RAIL SHOWS: NONE.
 *
 * `groupChats` decides what you can see, so it is the one part of the rail
 * tested against a list rather than by eye.
 *
 * This answer has changed five times. The one that holds is the simplest, and
 * it is the owner's: a sub-chat is a sub-chat. It lives in its parent's work
 * drawer in every state, and the rail lists CONVERSATIONS.
 *
 * The version this replaces listed every RUNNING child as a top-level row,
 * sorted first. It was reasoned from a real case — a child still working
 * under a filed-away parent — and then applied to every parent, including the
 * ones whose drawer is one click away. A narrow rescue became a general
 * flattening, and a spawned errand was drawn as prominently as a
 * conversation.
 *
 * The orphan it protected is not lost: a done parent is still in the done
 * drawer, and its own drawer still lists the child. Two clicks, not
 * invisible. One rule beats a rule with an exception.
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

describe('a sub-chat is never a row on the rail', () => {
  it('leaves a RUNNING worker out of the rail — it is in its parent’s drawer', () => {
    const { live, done } = groupChats([
      tab('chat-a'),
      tab('chat-b'),
      tab('worker', { spawned_by: 'chat-a' }),
    ]);
    expect(ids(live)).toEqual(['chat-a', 'chat-b']);
    // …and it is not swept into the archive either.
    expect(ids(done)).toEqual([]);
  });

  it('leaves a DELIVERED worker out too — one rule, not two', () => {
    const { live, done } = groupChats([
      tab('chat-a'),
      tab('worker', { spawned_by: 'chat-a', done: true }),
    ]);
    expect(ids(live)).toEqual(['chat-a']);
    expect(ids(done)).toEqual([]);
  });

  it('keeps a running worker out even when its parent is done', () => {
    // The case the promotion existed for. The parent is still reachable in
    // the done drawer and still lists this child, so nothing renders nowhere
    // — and the rail stays a list of conversations.
    const { live, done } = groupChats([
      tab('chat-a', { done: true }),
      tab('worker', { spawned_by: 'chat-a' }),
    ]);
    expect(ids(live)).toEqual([]);
    expect(ids(done)).toEqual(['chat-a']);
  });

  it('keeps a whole chain of handoffs out, however deep', () => {
    const { live } = groupChats([
      tab('chat-a'),
      tab('w1', { spawned_by: 'chat-a' }),
      tab('w2', { spawned_by: 'w1' }),
    ]);
    expect(ids(live)).toEqual(['chat-a']);
  });

  it('still promotes a chat whose parent is not in this list at all', () => {
    // NOT an exception to the rule above — it is the rule that a chat is
    // never invisible because of a dangling pointer. There is no parent here
    // to hold it, so there is no drawer for it to live in.
    const { live } = groupChats([tab('orphan', { spawned_by: 'elsewhere' })]);
    expect(ids(live)).toEqual(['orphan']);
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
    // Either quote: the formatter owns that choice, the design does not.
    expect(code(CSS)).toMatch(/\[data-worker=['"]true['"]\]/);
    expect(code(TSX)).toContain("data-worker={worker ? 'true' : undefined}");
  });

  it('uses the read-ink token rather than a new colour', () => {
    const rule = code(CSS).match(
      /\[data-worker=['"]true['"]\] \.navtree-name-text \{([^}]*)\}/,
    )?.[1];
    expect(rule).toMatch(/var\(--nt-ink-read\)/);
  });
});
