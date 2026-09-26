import { CHAT_DECAY_DAYS, type Tab, chatClock } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { doneChatCount, groupChats } from './NavTree';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/**
 * A tab, as the server would publish it: the clock derived by the server's own
 * deriver, `done` set the way the server sets it.
 */
function tab(id: string, opts: Partial<Tab> & { agedDays?: number } = {}): Tab {
  const { agedDays = 0, ...rest } = opts;
  const pinned = rest.pinned === true;
  // A SUB-CHAT HAS NO CLOCK — it retires on delivery, not on a timer — so the
  // fixture gives it none. That is not cosmetic: it is what makes these tests
  // fail if anything in the grouping ever reaches for a child's clock again.
  const isSub = rest.spawned_by != null;
  return {
    id,
    name: id,
    slug: id,
    created_at: NOW,
    updated_at: NOW,
    layout: { type: 'pane', id: `${id}-p` },
    ...(isSub ? {} : { clock: chatClock({ started_at: NOW - agedDays * DAY, now: NOW, pinned }) }),
    done: isSub ? false : !pinned && agedDays >= CHAT_DECAY_DAYS,
    ...rest,
  } as Tab;
}

/** Just the ids, in render order — what the rail actually shows. */
const shape = (groups: { chat: Tab; children: Tab[] }[]) =>
  groups.map((g) => [g.chat.id, g.children.map((c) => c.id)] as const);

describe('groupChats', () => {
  it('nests a spawned chat under its parent and never also at top level', () => {
    const { live } = groupChats([tab('a'), tab('kid', { spawned_by: 'a' }), tab('b')]);
    expect(shape(live)).toEqual([
      ['a', ['kid']],
      ['b', []],
    ]);
  });

  it('keeps the server’s order for both parents and children', () => {
    const { live } = groupChats([
      tab('a'),
      tab('k2', { spawned_by: 'a' }),
      tab('k1', { spawned_by: 'a' }),
    ]);
    expect(shape(live)).toEqual([['a', ['k2', 'k1']]]);
  });

  // A chat must never be invisible because of a pointer. The parent may live in
  // another workspace, or have been closed — either way the chat itself is
  // still a chat, and it gets a top-level row rather than disappearing.
  it('promotes a chat whose parent is not in this list, rather than dropping it', () => {
    const { live } = groupChats([tab('a'), tab('orphan', { spawned_by: 'gone' })]);
    expect(shape(live)).toEqual([
      ['a', []],
      ['orphan', []],
    ]);
  });

  it('survives a chat that claims to be its own parent', () => {
    const { live } = groupChats([tab('loop', { spawned_by: 'loop' })]);
    expect(shape(live)).toEqual([['loop', []]]);
  });

  it('moves a decayed chat into the done group', () => {
    const { live, done } = groupChats([tab('fresh'), tab('old', { agedDays: 9 })]);
    expect(shape(live)).toEqual([['fresh', []]]);
    expect(shape(done)).toEqual([['old', []]]);
  });

  it('takes a still-working child into done WITH its parent', () => {
    // The parent has left the live list; its family has no business staying in
    // it. (A child's own state does not rescue it from a retired parent.)
    const { live, done } = groupChats([
      tab('old', { agedDays: 9 }),
      tab('kid', { spawned_by: 'old', done: false }),
    ]);
    expect(live).toEqual([]);
    expect(shape(done)).toEqual([['old', ['kid']]]);
  });

  // ─── THE 41-AGENT CASE ───────────────────────────────────────────────────
  // The whole point of the amendment. A sub-chat retires the moment it
  // delivers, because its result already came back to the parent as a card —
  // so a workspace that spawned forty agents shows the parent and nothing else
  // once they have all reported.
  describe('a sub-chat retires on delivery, on its own', () => {
    it('drops a delivered sub-chat out of the live list immediately', () => {
      const { live, done } = groupChats([
        tab('parent'),
        tab('kid', { spawned_by: 'parent', done: true }),
      ]);
      expect(shape(live)).toEqual([['parent', []]]);
      expect(shape(done)).toEqual([['parent', ['kid']]]);
      expect(done[0]?.contextOnly).toBe(true);
    });

    it('splits one live parent across both lists — working up, delivered down', () => {
      const { live, done } = groupChats([
        tab('parent'),
        tab('working', { spawned_by: 'parent', done: false }),
        tab('delivered', { spawned_by: 'parent', done: true }),
      ]);
      expect(shape(live)).toEqual([['parent', ['working']]]);
      expect(shape(done)).toEqual([['parent', ['delivered']]]);
    });

    it('leaves a parent with forty delivered agents as ONE live row', () => {
      const agents = Array.from({ length: 40 }, (_, i) =>
        tab(`agent${i}`, { spawned_by: 'hunt', done: true, status: 'ready' }),
      );
      const { live, done } = groupChats([tab('hunt'), ...agents]);
      expect(shape(live)).toEqual([['hunt', []]]);
      expect(done[0]?.children).toHaveLength(40);
    });

    // A sub-chat has NO clock, so age must not retire it and must not keep it.
    // Only delivery decides.
    it('ignores a sub-chat’s age entirely — only delivery retires it', () => {
      const { live, done } = groupChats([
        tab('parent'),
        tab('ancient', { spawned_by: 'parent', agedDays: 99, done: false }),
      ]);
      expect(shape(live)).toEqual([['parent', ['ancient']]]);
      expect(done).toEqual([]);
    });

    it('does NOT add a context group when nothing has been delivered', () => {
      const { done } = groupChats([
        tab('parent'),
        tab('kid', { spawned_by: 'parent', done: false }),
      ]);
      expect(done).toEqual([]);
    });
  });

  it('never lets a pinned chat decay, however old', () => {
    const { live, done } = groupChats([tab('pin', { agedDays: 99, pinned: true })]);
    expect(shape(live)).toEqual([['pin', []]]);
    expect(done).toEqual([]);
  });

  // The pin divider is drawn at this index. Counted over the LIVE tops only,
  // or a decayed pinned row would leave the hairline stranded one row low.
  it('counts the pin seam over the live top-level rows only', () => {
    const { livePinned } = groupChats([
      tab('p1', { pinned: true }),
      tab('p2', { pinned: true }),
      tab('kid', { spawned_by: 'p1' }),
      tab('u1'),
      tab('gone', { agedDays: 9 }),
    ]);
    expect(livePinned).toBe(2);
  });

  it('is empty-safe', () => {
    expect(groupChats([])).toEqual({ live: [], done: [], livePinned: 0 });
  });
});

describe('doneChatCount — the number in the done header', () => {
  it('counts the CHATS you will find, not the groups', () => {
    // One decayed top-level chat, plus a live parent with three delivered
    // agents. Four things are in that drawer; two groups hold them.
    const { done } = groupChats([
      tab('decayed', { agedDays: 9 }),
      tab('hunt'),
      tab('a1', { spawned_by: 'hunt', done: true }),
      tab('a2', { spawned_by: 'hunt', done: true }),
      tab('a3', { spawned_by: 'hunt', done: true }),
    ]);
    expect(done).toHaveLength(2);
    expect(doneChatCount(done)).toBe(4);
  });

  it('does not count a context label as a done chat', () => {
    // The parent is live and has a row above; only its one delivered sub-chat
    // is actually in the drawer.
    const { done } = groupChats([tab('hunt'), tab('a1', { spawned_by: 'hunt', done: true })]);
    expect(doneChatCount(done)).toBe(1);
  });

  it('counts a decayed parent AND the family it took with it', () => {
    const { done } = groupChats([tab('old', { agedDays: 9 }), tab('kid', { spawned_by: 'old' })]);
    expect(doneChatCount(done)).toBe(2);
  });

  it('is zero for an empty drawer', () => {
    expect(doneChatCount([])).toBe(0);
  });
});
