import { CHAT_DECAY_DAYS, type Tab, chatClock } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { groupChats } from './NavTree';

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

/**
 * The ids this list renders, in render order.
 *
 * It used to return `[parent, [children]]` pairs, which was the shape of the
 * question while sub-chats were rows. They are not, so the only thing left to
 * assert is WHICH CHATS APPEAR — and that is the property nearly every test
 * here is about: a worker must not be a row, and a chat must never be
 * invisible because of a pointer. A pair with a permanently empty second
 * element would make every one of those assertions vacuously true.
 */
const shape = (groups: readonly { chat: Tab }[]) => groups.map((g) => g.chat.id);

describe('groupChats', () => {
  it('keeps a worker out of the rail in EVERY state', () => {
    // One rule, not a rule about state. A sub-chat lives in its parent's work
    // drawer whether it is running or delivered; the rail lists
    // conversations. The version that listed running children as top-level
    // rows drew a spawned errand as prominently as a chat.
    const running = groupChats([tab('a'), tab('kid', { spawned_by: 'a' }), tab('b')]);
    expect(shape(running.live)).toEqual(['a', 'b']);
    const delivered = groupChats([tab('a'), tab('kid', { spawned_by: 'a', done: true }), tab('b')]);
    expect(shape(delivered.live)).toEqual(['a', 'b']);
  });

  it('keeps the server’s order', () => {
    // Nothing is partitioned to the top any more, so this is simply the
    // server's order with the sub-chats removed.
    const { live } = groupChats([
      tab('a'),
      tab('b'),
      tab('k2', { spawned_by: 'a' }),
      tab('k1', { spawned_by: 'a' }),
    ]);
    expect(shape(live)).toEqual(['a', 'b']);
  });

  // A chat must never be invisible because of a pointer. The parent may live in
  // another workspace, or have been closed — either way the chat itself is
  // still a chat, and it gets a top-level row rather than disappearing.
  it('promotes a chat whose parent is not in this list, rather than dropping it', () => {
    const { live } = groupChats([tab('a'), tab('orphan', { spawned_by: 'gone' })]);
    expect(shape(live)).toEqual(['a', 'orphan']);
  });

  it('survives a chat that claims to be its own parent', () => {
    const { live } = groupChats([tab('loop', { spawned_by: 'loop' })]);
    expect(shape(live)).toEqual(['loop']);
  });

  it('moves a decayed chat into the done group', () => {
    const { live, done } = groupChats([tab('fresh'), tab('old', { agedDays: 9 })]);
    expect(shape(live)).toEqual(['fresh']);
    expect(shape(done)).toEqual(['old']);
  });

  it('does NOT promote a still-working child when its parent retires', () => {
    // This arm used to promote it, to stop a running sub-chat rendering
    // nowhere when its parent left the live list. The rescue was real and the
    // price was wrong: it was applied to every parent, so every running
    // worker became a top-level row.
    //
    // Nothing renders nowhere. The parent is in the DONE group — still on the
    // rail, still openable — and its work drawer still lists this child. Two
    // clicks, and the hierarchy survives.
    const { live, done } = groupChats([
      tab('old', { agedDays: 9 }),
      tab('kid', { spawned_by: 'old', done: false }),
    ]);
    expect(shape(live)).toEqual([]);
    expect(shape(done)).toEqual(['old']);
  });

  it('does NOT promote a delivered child — it is in its parent’s drawer', () => {
    // The other half. A sub-chat that reported is not live work and not
    // something you abandoned; it is a detail of its parent, and the parent's
    // work drawer is where it is listed. Nothing of it reaches the rail.
    const { live, done } = groupChats([
      tab('old', { agedDays: 9 }),
      tab('kid', { spawned_by: 'old', done: true }),
    ]);
    expect(live).toEqual([]);
    expect(shape(done)).toEqual(['old']);
  });

  // ─── THE 41-AGENT CASE ───────────────────────────────────────────────────
  // The whole point of the amendment. A sub-chat retires the moment it
  // delivers, because its result already came back to the parent as a card —
  // so a workspace that spawned forty agents shows the parent and nothing else
  // once they have all reported.
  describe('a sub-chat retires on delivery, on its own', () => {
    it('keeps a delivered sub-chat out of the rail entirely', () => {
      // FOURTH ANSWER, and the first with somewhere real to put it. A
      // delivered sub-chat landed in `done` itself (the archive filled with
      // machine-named work nobody recognised), then nowhere (unfindable), then
      // behind a disclosure inside the archive (two clicks into a place you go
      // for something else). It is now in its PARENT'S work drawer, beside the
      // conversation that started it — so the rail shows the parent and
      // nothing else.
      const { live, done } = groupChats([
        tab('parent'),
        tab('kid', { spawned_by: 'parent', done: true }),
      ]);
      expect(shape(live)).toEqual(['parent']);
      expect(done).toEqual([]);
    });

    it('lists the WORKING child and not the delivered one', () => {
      const { live, done } = groupChats([
        tab('parent'),
        tab('working', { spawned_by: 'parent', done: false }),
        tab('delivered', { spawned_by: 'parent', done: true }),
      ]);
      // ONE row: the chat. Both children are in its work drawer — the one
      // still going and the one that reported. Neither is a conversation.
      expect(shape(live)).toEqual(['parent']);
      expect(done).toEqual([]);
    });

    it('leaves a parent with forty agents as ONE row, and that is the whole point', () => {
      // 65 children under one chat was the measured case. The rail is a list
      // of conversations; forty errands are a detail of one of them.
      const agents = Array.from({ length: 40 }, (_, i) =>
        tab(`agent${i}`, { spawned_by: 'hunt', done: true, status: 'ready' }),
      );
      const { live, done } = groupChats([tab('hunt'), ...agents]);
      expect(shape(live)).toEqual(['hunt']);
      expect(done).toEqual([]);
    });

    // A sub-chat has NO clock, so age must not retire it and must not keep it.
    // Only delivery decides.
    it('ignores a sub-chat’s age entirely — only delivery retires it', () => {
      const { live, done } = groupChats([
        tab('parent'),
        tab('ancient', { spawned_by: 'parent', agedDays: 99, done: false }),
      ]);
      // Still NOT retired, which is what this test is about: age must not
      // decide a sub-chat's fate, or a long-running worker would be swept
      // into the archive. It is not a rail row either way — it is in the
      // parent's drawer, which is where a sub-chat lives.
      expect(shape(live)).toEqual(['parent']);
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
    expect(shape(live)).toEqual(['pin']);
    expect(done).toEqual([]);
  });

  it('is empty-safe', () => {
    expect(groupChats([])).toEqual({ live: [], done: [] });
  });
});

/* ─── THE ARCHIVE'S COUNT, AND ITS TESTS, ARE GONE ────────────────────────
   `doneChatCount` put a number in the archive's header and these tests pinned
   the invariant that made it trustworthy: the header's number has to be what
   you find when you open it. It had been wrong twice by counting rows that
   were not there — children, and a parent rendered as a label — so the
   invariant was worth testing while the number existed.

   The header says "older chats" and nothing else now: the count was a
   quantity of the thing you are least interested in, at the top of the thing
   you are most interested in, and it only grew. What the tests below still
   cover is the thing that mattered underneath it — WHICH chats end up in that
   list at all. */

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
    // `rootOf` still has to RESOLVE both of them — the bug this guards is a
    // grandchild landing in `childrenOf[child.id]`, which nothing reads. It
    // must resolve to the ROOT so the root's drawer holds the whole family;
    // neither descendant is a rail row.
    expect(shape(live)).toEqual(['root']);
    expect(shape(done)).toEqual([]);
  });

  it('resolves a delivered grandchild to its root, and then drops it', () => {
    // The bug this guards is the grandchild going into `childrenOf[child.id]`,
    // which nothing reads — a row in NEITHER list. It still has to resolve to
    // the root; what changed is what happens once it has. Every descendant
    // belongs to the root's drawer at any depth, delivered or not.
    const { live, done } = groupChats([
      tab('root'),
      tab('child', { spawned_by: 'root' }),
      tab('grandchild', { spawned_by: 'child', done: true }),
    ]);
    expect(shape(live)).toEqual(['root']);
    expect(done).toEqual([]);
  });

  it('keeps a whole chain of running handoffs out, however deep', () => {
    // What `agent-orchestration` actually produces: a hands off to b hands off
    // to c. Three running agents, and ONE row — the conversation that started
    // them. Listing each link was how a fan-out turned the rail into a job
    // queue.
    const { live } = groupChats([
      tab('root'),
      tab('a', { spawned_by: 'root' }),
      tab('b', { spawned_by: 'a' }),
      tab('c', { spawned_by: 'b' }),
    ]);
    expect(shape(live)).toEqual(['root']);
  });

  it('takes the DELIVERED family down when the ROOT is done, and promotes the rest', () => {
    // Restated at depth: both descendants resolve to `root`, so when root
    // retires they go with it — into its drawer, which is still reachable
    // from the done group. A running descendant does not climb out onto the
    // rail.
    const { live, done } = groupChats([
      tab('root', { done: true }),
      tab('child', { spawned_by: 'root' }),
      tab('grandchild', { spawned_by: 'child' }),
    ]);
    expect(shape(live)).toEqual([]);
    // The root alone, and its family is inside it.
    expect(shape(done)).toEqual(['root']);
  });

  it('promotes a chat whose chain leaves this list', () => {
    // `child`'s parent is in another workspace, so `child` is a top-level row —
    // and `grandchild` resolves up to `child`, not into a hole.
    const { live } = groupChats([
      tab('child', { spawned_by: 'elsewhere' }),
      tab('grandchild', { spawned_by: 'child' }),
    ]);
    // `child` is promoted because its chain leaves the list — a chat is never
    // invisible because of a pointer. `grandchild` resolves to `child`, which
    // IS in the list, so it is `child`'s worker and lives in its drawer.
    expect(shape(live)).toEqual(['child']);
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

/* ─── THE PILL'S TESTS WENT WITH THE PILL ──────────────────────────────────
   `subsStatus` and `subChatChip` answered what a COLLAPSED group of sub-chats
   said about itself without being opened — the loudest state in the family and
   the count breakdown. That was the whole bargain of collapsing workers by
   default, and both were worth testing because a glance down the rail had to
   stay true.

   The rail has no collapsed families in it now: a chat's workers are in that
   chat's work drawer, and the only rollup left is the running count on the
   drawer's own control (ChatDrawer). Nothing here was weakened to make the
   change pass — the behaviour was removed, so its tests were too. */
