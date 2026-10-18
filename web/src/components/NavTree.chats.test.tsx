import { CHAT_DECAY_DAYS, type Tab, chatClock } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { doneChatCount, groupChats, subChatChip, subChatChipTitle, subsStatus } from './NavTree';

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

/**
 * ─── WHAT A SHUT GROUP SAYS ABOUT ITSELF ────────────────────────────────────
 *
 * Both of these decide what the reader learns WITHOUT opening anything, which
 * is the entire bargain of collapsing sub-chats by default. They are pure for
 * the same reason `groupChats` is: a rule about what you can see must not be
 * checked by eye.
 */
describe('subsStatus — the pill answers for the WORKERS, not for the chat', () => {
  const kid = (status?: Tab['status']) => tab(`k-${status ?? 'idle'}`, { spawned_by: 'a', status });

  it('IGNORES the parent entirely, which is the whole correction', () => {
    // It used to take the parent's own state too, and that was right while it
    // fed the parent ROW's mark. The pill is not the row: it counts sub-chats,
    // names sub-chats in its title and opens sub-chats, so a hue from the
    // parent makes one object say two things about two subjects.
    //
    // Measured on the live rail at 03:48, one worker finished and the chat
    // mid-turn:  data-state="working"  title="1 sub-chat (1 ready)".  The dot
    // was about the parent, the words about the child, and nothing told the
    // reader which was which.
    expect(subsStatus([kid('ready')])).toBe('ready');
    expect(subsStatus([kid()])).toBeUndefined();
  });

  it('wears the loudest state among them', () => {
    expect(subsStatus([kid('blocked')])).toBe('blocked');
    expect(subsStatus([kid('working'), kid('blocked'), kid('ready')])).toBe('blocked');
  });

  it('ranks working above ready, so a shut group is never still while work runs', () => {
    // "A still rail means nothing is running" is a claim about the WHOLE rail;
    // a collapsed family with a turn inside it cannot be the exception.
    expect(subsStatus([kid('ready'), kid('working')])).toBe('working');
  });

  it('ranks dead below ready — findable, not shouting', () => {
    expect(subsStatus([kid('ready'), kid('dead')])).toBe('ready');
    expect(subsStatus([kid('dead')])).toBe('dead');
  });

  it('stays undefined when every worker is idle — the pill goes quiet', () => {
    // The quiet form is what `[data-state="idle"]` styles: the rail's own ink
    // rather than a status hue, because "nothing is happening" is not a state
    // the status channel owns. Returning 'idle' would be the same pixel and a
    // different claim.
    expect(subsStatus([kid(), kid()])).toBeUndefined();
    expect(subsStatus([])).toBeUndefined();
  });
});

describe('subChatChip', () => {
  const kid = (status?: Tab['status'], n = 0) => tab(`k${n}`, { spawned_by: 'a', status });

  it('counts the quiet case in the shortest form there is', () => {
    expect(subChatChip([kid(), kid()])).toBe('2 sub-chats');
    expect(subChatChip([kid()])).toBe('1 sub-chat');
  });

  it('leads with the total, then the states, loudest first', () => {
    const chip = subChatChip([
      kid('working', 1),
      kid('working', 2),
      kid('blocked', 3),
      kid('ready', 4),
      kid(undefined, 5),
    ]);
    expect(chip).toBe('5 (1 needs you · 2 running · 1 ready · 1 idle)');
  });

  it('spells the noun out in the TITLE, which has room for it', () => {
    // The visible line cannot afford "sub-chats" — measured, 228px of text in
    // 204px, and the ellipsis would eat the `idle` segment that makes the
    // numbers add up. The glyph carries the noun on screen; the words live
    // here and in the accessible name.
    expect(subChatChipTitle([kid('ready', 1), kid(undefined, 2)])).toBe(
      '2 sub-chats (1 ready \u00b7 1 idle)',
    );
    expect(subChatChipTitle([kid(undefined, 1)])).toBe('1 sub-chat');
  });

  it('ACCOUNTS FOR EVERYONE — the segments sum to the total', () => {
    // Reported with a screenshot: "no working indicator but if only 6 are
    // ready then what are the other 3 doing?", against a chip reading
    // "9 · 6 ready". A total promises an account of everyone; listing only the
    // loud states delivered part of one and left the reader doing subtraction
    // with no answer.
    const states = [undefined, 'working', 'blocked', 'ready', 'dead'] as const;
    for (let mask = 1; mask < 5 ** 4; mask++) {
      const kids = [];
      let m = mask;
      for (let i = 0; i < 4; i++) {
        kids.push(kid(states[m % 5], i));
        m = Math.floor(m / 5);
      }
      const chip = subChatChip(kids);
      // Every number in the line: the total, then one per segment. The
      // parens are punctuation, not a boundary the arithmetic cares about.
      const nums = [...chip.matchAll(/(\d+)/g)].map((x) => Number(x[1]));
      if (nums.length < 2) continue; // the all-idle form: "4 sub-chats"
      const [total, ...segments] = nums;
      expect(segments.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('says nothing about a state nobody is in', () => {
    expect(subChatChip([kid('working'), kid('working')])).toBe('2 (2 running)');
  });

  it('counts the dead, last — a quiet worker is not an absent one', () => {
    // "6 sub-chats" over three exited runners is the shut group lying by
    // omission: dead is the one state that never makes a noise of its own.
    expect(subChatChip([kid('dead', 1), kid('dead', 2), kid(undefined, 3)])).toBe(
      '3 (2 dead \u00b7 1 idle)',
    );
    expect(subChatChip([kid('blocked', 1), kid('dead', 2)])).toBe('2 (1 needs you \u00b7 1 dead)');
  });

  it("uses the mark's own words, not a second vocabulary for the rail", () => {
    // MARK_TITLES.blocked is "Waiting on you"; the chip's "needs you" is the
    // same claim at chip length. What matters is that it is NOT "1 blocked" —
    // the rail says what a thing needs, never what state machine it is in.
    expect(subChatChip([kid('blocked')])).toContain('needs you');
  });
});
