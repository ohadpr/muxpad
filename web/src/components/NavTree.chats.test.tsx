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

  it('PROMOTES a still-working child when its parent retires', () => {
    // The parent has left the live list and the drawer holds top-level chats
    // only — so a child that has NOT delivered would render nowhere at all.
    // That shipped briefly and is the bug this arm exists for: a sub-chat with
    // a turn still running, gone from the rail.
    //
    // It is rule 2 arriving from a second direction. A chat whose `spawned_by`
    // does not resolve is promoted rather than orphaned, because a chat is
    // never invisible on account of a pointer; a parent that retired out from
    // under a running child is that situation with the pointer still intact.
    const { live, done } = groupChats([
      tab('old', { agedDays: 9 }),
      tab('kid', { spawned_by: 'old', done: false }),
    ]);
    expect(shape(live)).toEqual([['kid', []]]);
    expect(shape(done)).toEqual([['old', []]]);
  });

  it('does NOT promote a delivered child — it files under the subs instead', () => {
    // The other half, and the thing that keeps the drawer's top level clean: a
    // sub-chat that reported is not live work, so it never gets a live row —
    // it goes one disclosure further in, under its parent's name.
    const { live, done, doneSubs } = groupChats([
      tab('old', { agedDays: 9 }),
      tab('kid', { spawned_by: 'old', done: true }),
    ]);
    expect(live).toEqual([]);
    expect(shape(done)).toEqual([['old', []]]);
    expect(shape(doneSubs)).toEqual([['old', ['kid']]]);
  });

  // ─── THE 41-AGENT CASE ───────────────────────────────────────────────────
  // The whole point of the amendment. A sub-chat retires the moment it
  // delivers, because its result already came back to the parent as a card —
  // so a workspace that spawned forty agents shows the parent and nothing else
  // once they have all reported.
  describe('a sub-chat retires on delivery, on its own', () => {
    it('files a delivered sub-chat under doneSubs, not in the done list', () => {
      // THE DRAWER'S TOP LEVEL IS YOURS. A delivered sub-chat used to land in
      // `done` itself and the archive filled with machine-named work nobody
      // recognised; it was then dropped from everywhere, which fixed the noise
      // by removing the only place it could be found. It is in the drawer's own
      // second disclosure now — present, and never at the top.
      const { live, done, doneSubs } = groupChats([
        tab('parent'),
        tab('kid', { spawned_by: 'parent', done: true }),
      ]);
      expect(shape(live)).toEqual([['parent', []]]);
      expect(done).toEqual([]);
      expect(shape(doneSubs)).toEqual([['parent', ['kid']]]);
      // The parent is a LABEL there — it has a live row above.
      expect(doneSubs[0]?.contextOnly).toBe(true);
    });

    it('splits a live parent three ways — working up, delivered into the subs', () => {
      const { live, done, doneSubs } = groupChats([
        tab('parent'),
        tab('working', { spawned_by: 'parent', done: false }),
        tab('delivered', { spawned_by: 'parent', done: true }),
      ]);
      expect(shape(live)).toEqual([['parent', ['working']]]);
      // Nothing of a LIVE parent's belongs in the archive's top level.
      expect(done).toEqual([]);
      expect(shape(doneSubs)).toEqual([['parent', ['delivered']]]);
    });

    it('leaves a parent with forty delivered agents as ONE live row and an EMPTY drawer', () => {
      // The case the whole rule is for. Forty errands that reported used to be
      // forty rows in the drawer, which buried the chats you actually
      // abandoned — the only thing the drawer is for.
      const agents = Array.from({ length: 40 }, (_, i) =>
        tab(`agent${i}`, { spawned_by: 'hunt', done: true, status: 'ready' }),
      );
      const { live, done, doneSubs } = groupChats([tab('hunt'), ...agents]);
      expect(shape(live)).toEqual([['hunt', []]]);
      // The forty are ONE line in the drawer until you ask for them, and they
      // are below the chats you archived yourself, not above.
      expect(done).toEqual([]);
      expect(doneSubs[0]?.children).toHaveLength(40);
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

  it('is empty-safe', () => {
    expect(groupChats([])).toEqual({ live: [], done: [], doneSubs: [] });
  });
});

describe('doneChatCount — the number in the done header', () => {
  it("counts the CHATS you will find at the drawer's TOP level", () => {
    // One decayed top-level chat, plus a live parent with three delivered
    // agents. The agents are behind their own disclosure and have their own
    // number, so this one is 1 — and the invariant is unchanged: the header's
    // number has to be what you find when you open it.
    const { done } = groupChats([
      tab('decayed', { agedDays: 9 }),
      tab('hunt'),
      tab('a1', { spawned_by: 'hunt', done: true }),
      tab('a2', { spawned_by: 'hunt', done: true }),
      tab('a3', { spawned_by: 'hunt', done: true }),
    ]);
    expect(done).toHaveLength(1);
    expect(doneChatCount(done)).toBe(1);
  });

  it('is zero when only sub-chats have delivered', () => {
    // The parent is live and has a row above it; its delivered sub-chat is in
    // the nested section with its own count, so the top level is empty and the
    // head says so. It used to say "1" and open onto a stranger.
    const { done } = groupChats([tab('hunt'), tab('a1', { spawned_by: 'hunt', done: true })]);
    expect(doneChatCount(done)).toBe(0);
  });

  it('counts a decayed parent ONCE, not the family it took with it', () => {
    const { done } = groupChats([tab('old', { agedDays: 9 }), tab('kid', { spawned_by: 'old' })]);
    expect(doneChatCount(done)).toBe(1);
  });

  it('is zero for an empty drawer', () => {
    expect(doneChatCount([])).toBe(0);
  });
});

/**
 * DEPTH — a chat spawned by a chat that was itself spawned.
 *
 * `groupChats` was one hop deep: a chat's group was keyed on its IMMEDIATE
 * parent, and only the tops were read back out. So a grandchild went into
 * `childrenOf[itsParent.id]`, which nothing read, and it appeared in NEITHER
 * list — not mis-nested, gone, and uncounted by the done header.
 *
 * It was survivable while the phone rendered a flat list, because a grandchild
 * still reached the DOM as a top-level row. Turning grouping on for BOTH
 * surfaces turned it into a disappearance on the device the grouping was turned
 * on for. And a chain of handoffs is exactly a chain of grandchildren, so this
 * is the ordinary case on this branch.
 *
 * The fix FLATTENS to one level rather than truncating at one level: the design
 * is a single indent — a child's mark in its parent's mark column, every child
 * name on one shared x — and neither survives arbitrary depth. Everything a chat
 * spawned, however deep, lists under it.
 *
 * Every case here was run against the old implementation first; the first three
 * failed.
 */
describe('a grandchild lists under the root, not into a hole', () => {
  it('keeps a depth-2 chat in the tree at all', () => {
    const { live, done } = groupChats([
      tab('root'),
      tab('child', { spawned_by: 'root' }),
      tab('grandchild', { spawned_by: 'child' }),
    ]);
    // One level, so BOTH descendants sit under root — not grandchild under child.
    expect(shape(live)).toEqual([['root', ['child', 'grandchild']]]);
    expect(shape(done)).toEqual([]);
  });

  it('resolves a delivered grandchild to its root, and then drops it', () => {
    // The bug this guards is the grandchild going into `childrenOf[child.id]`,
    // which nothing reads — a row in NEITHER list. It still has to resolve to
    // the root; what changed is where it lands once it has. A delivered
    // sub-chat is not listed at any depth, so it leaves the live list and does
    // not appear in the drawer either.
    const { live, done, doneSubs } = groupChats([
      tab('root'),
      tab('child', { spawned_by: 'root' }),
      tab('grandchild', { spawned_by: 'child', done: true }),
    ]);
    expect(shape(live)).toEqual([['root', ['child']]]);
    expect(done).toEqual([]);
    expect(shape(doneSubs)).toEqual([['root', ['grandchild']]]);
  });

  it('carries a whole chain of handoffs, four deep', () => {
    // What `agent-orchestration` actually produces: a hands off to b hands off
    // to c. Every one of them lists under the chat that started it.
    const { live } = groupChats([
      tab('root'),
      tab('a', { spawned_by: 'root' }),
      tab('b', { spawned_by: 'a' }),
      tab('c', { spawned_by: 'b' }),
    ]);
    expect(shape(live)).toEqual([['root', ['a', 'b', 'c']]]);
  });

  it('takes the DELIVERED family down when the ROOT is done, and promotes the rest', () => {
    // Restated at depth, and it is the promotion that needs saying here: both
    // descendants resolve to `root`, so when root retires they are both
    // children of a done parent — and neither has delivered, so both are still
    // running work and both get a row. Flattened to one level, as everywhere.
    const { live, done } = groupChats([
      tab('root', { done: true }),
      tab('child', { spawned_by: 'root' }),
      tab('grandchild', { spawned_by: 'child' }),
    ]);
    expect(shape(live)).toEqual([
      ['child', []],
      ['grandchild', []],
    ]);
    // The drawer is the root alone — nothing is re-listed underneath it.
    expect(shape(done)).toEqual([['root', []]]);
  });

  it('promotes a chat whose chain leaves this list', () => {
    // `child`'s parent is in another workspace, so `child` is a top-level row —
    // and `grandchild` resolves up to `child`, not into a hole.
    const { live } = groupChats([
      tab('child', { spawned_by: 'elsewhere' }),
      tab('grandchild', { spawned_by: 'child' }),
    ]);
    expect(shape(live)).toEqual([['child', ['grandchild']]]);
  });

  it('does not spin on a spawned_by cycle', () => {
    // Should be impossible. This function decides whether a row renders at all,
    // which makes it the wrong place to find out that it wasn't.
    const { live, done } = groupChats([
      tab('a', { spawned_by: 'b' }),
      tab('b', { spawned_by: 'a' }),
    ]);
    expect(live.length + done.length).toBeGreaterThan(0);
  });
});
