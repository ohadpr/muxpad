import type { Tab } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { groupChats } from '../components/NavTree';
import {
  type FlatChatGroup,
  displayedNameKey,
  flatDoneCount,
  flattenChats,
  needsWorkspaceLabel,
} from './flat-chats';

const T = 1_800_000_000_000;
const HOUR = 3_600_000;

function tab(
  id: string,
  o: {
    name?: string;
    userAt?: number;
    activityAt?: number;
    spawnedBy?: string;
    pinned?: boolean;
    done?: boolean;
    retired?: boolean;
    status?: Tab['status'];
  } = {},
): Tab {
  return {
    id,
    slug: id,
    name: o.name ?? id,
    layout: '',
    view_mode: 'tabbed',
    pinned: o.pinned ?? false,
    last_activity_at: o.activityAt ?? o.userAt ?? T,
    last_user_at: o.userAt ?? T,
    ...(o.spawnedBy ? { spawned_by: o.spawnedBy } : {}),
    ...(o.status ? { status: o.status } : {}),
    done: o.done ?? o.retired ?? false,
    ...(o.retired ? { done_reason: 'delivered' as const } : {}),
    created_at: 1,
    updated_at: 1,
  } as Tab;
}

const ws = (slug: string) => ({ id: `w-${slug}`, slug, name: slug.toUpperCase() });

/** What the surfaces do: group each workspace on its own, then merge. */
function flattenOf(...spaces: [ReturnType<typeof ws>, Tab[]][]) {
  return flattenChats(
    spaces.map(([workspace, tabs]) => {
      const { live, done } = groupChats(tabs);
      return { workspace, live, done };
    }),
  );
}

const ids = (rows: { group: { chat: Tab } }[]) => rows.map((r) => r.group.chat.id);

describe('flattenChats — one list across every workspace', () => {
  it('orders by when YOU last touched a chat, not by what the machine did', () => {
    // The reason this whole branch exists. `noisy` is a chat left tailing a
    // log: seconds-old activity, week-old attention. It must not lead a list
    // whose job is answering "what was I just doing".
    const flat = flattenOf(
      [
        ws('personal'),
        [tab('noisy', { userAt: T - 7 * 24 * HOUR, activityAt: T, status: 'working' })],
      ],
      [ws('trayo'), [tab('mine', { userAt: T - HOUR })]],
    );
    expect(ids(flat.live)).toEqual(['mine', 'noisy']);
  });

  it('interleaves workspaces — that is the entire point of the view', () => {
    const flat = flattenOf(
      [ws('personal'), [tab('p1', { userAt: T }), tab('p2', { userAt: T - 4 * HOUR })]],
      [ws('trayo'), [tab('t1', { userAt: T - 2 * HOUR })]],
    );
    expect(ids(flat.live)).toEqual(['p1', 't1', 'p2']);
  });

  it('keeps a chat that WANTS YOU at the very top, from any workspace', () => {
    const flat = flattenOf(
      [ws('personal'), [tab('fresh', { userAt: T })]],
      [ws('trayobot'), [tab('asking', { userAt: T - 10 * 24 * HOUR, status: 'blocked' })]],
    );
    expect(ids(flat.live)).toEqual(['asking', 'fresh']);
  });
});

describe('flattenChats — a CHILD travels with its parent', () => {
  it('nests under its own parent even when its key would rank it elsewhere', () => {
    // THE nesting test. `kid` was touched more recently than every root here,
    // so a list that sorted rows rather than GROUPS would put it at the top —
    // an indented line with a dot, under a chat that did not spawn it. The
    // child's position is its parent's, entirely.
    const flat = flattenOf([
      ws('personal'),
      [
        tab('parent', { userAt: T - 6 * HOUR }),
        tab('kid', { spawnedBy: 'parent', userAt: T }),
        tab('other', { userAt: T - HOUR }),
      ],
    ]);
    expect(ids(flat.live)).toEqual(['other', 'parent']);
    const parent = flat.live.find((r) => r.group.chat.id === 'parent');
    expect(parent?.group.children.map((k) => k.id)).toEqual(['kid']);
    // …and it is NOT also a root. A chat rendered twice is two places to tap
    // for one destination, and the second one goes on lighting up as it works.
    expect(flat.live.flatMap((r) => r.group.children.map((k) => k.id))).toEqual(['kid']);
  });

  it('carries a GRANDCHILD too — the disappearance that shipped once', () => {
    // 7e4ecfc: a chat spawned by a chat that was itself spawned went into
    // neither list and vanished from the sidebar — on the phone, which is the
    // device grouping had just been turned on for. A chain of handoffs is
    // exactly a chain of grandchildren, so this is the common case here.
    const flat = flattenOf([
      ws('personal'),
      [
        tab('root', { userAt: T - 3 * HOUR }),
        tab('kid', { spawnedBy: 'root', userAt: T - 2 * HOUR }),
        tab('grandkid', { spawnedBy: 'kid', userAt: T - HOUR }),
      ],
    ]);
    const everyId = flat.live.flatMap((r) => [
      r.group.chat.id,
      ...r.group.children.map((k) => k.id),
    ]);
    expect(everyId.sort()).toEqual(['grandkid', 'kid', 'root']);
    // Flattened to ONE level under the root, not nested two deep: the design is
    // one indent step and one mark column, and neither survives arbitrary depth.
    expect(ids(flat.live)).toEqual(['root']);
  });

  it('does NOT let a working child drag its parent up the list', () => {
    // Tempting and rejected: promoting on a child's key is the machine moving
    // a row again, which is the churn the recency key exists to remove.
    const flat = flattenOf(
      [
        ws('personal'),
        [
          tab('old-parent', { userAt: T - 20 * HOUR }),
          tab('busy-kid', { spawnedBy: 'old-parent', userAt: T, activityAt: T, status: 'working' }),
        ],
      ],
      [ws('trayo'), [tab('recent', { userAt: T - HOUR })]],
    );
    expect(ids(flat.live)).toEqual(['recent', 'old-parent']);
  });

  it('leaves a CROSS-WORKSPACE child a root, exactly as the grouped view does', () => {
    // Resolvable here (this function holds every workspace's tabs) and
    // deliberately not resolved: the two views must not disagree about what a
    // child is, on one screen, with no way to tell why.
    const flat = flattenOf(
      [ws('personal'), [tab('parent', { userAt: T - HOUR })]],
      [ws('trayo'), [tab('exile', { spawnedBy: 'parent', userAt: T })]],
    );
    expect(ids(flat.live)).toEqual(['exile', 'parent']);
    expect(flat.live.flatMap((r) => r.group.children)).toEqual([]);
  });
});

describe('flattenChats — a group ranks on its ROOT, save for the one bit that is yours', () => {
  it('floats a group whose CHILD wants you — the child cannot float on its own', () => {
    // The screenshot: `muxpad` at the very BOTTOM of a long flat list with one
    // sub-chat indented under it. A sub-chat has no position of its own (it
    // rides its parent's, because it has no clock of its own), so ranking the
    // group on the root ALONE meant the surface's one loud signal — `blocked`,
    // the bit `compareByUserTouch` promotes above all recency — could never
    // fire for exactly the rows that cannot raise it themselves. An agent
    // asking you a question sat at the bottom of the list, indented, silent.
    const flat = flattenOf(
      [ws('personal'), [tab('fresh', { userAt: T })]],
      [
        ws('trayo'),
        [
          tab('stale', { userAt: T - 30 * 24 * HOUR }),
          tab('asking', { spawnedBy: 'stale', status: 'blocked' }),
        ],
      ],
    );
    expect(ids(flat.live)).toEqual(['stale', 'fresh']);
  });

  it('does NOT float a group whose child is merely WORKING — that is the machine', () => {
    // THE boundary the whole design rests on. `blocked` is you being asked for
    // something; `working` is a machine printing a line. Letting the second one
    // reorder is precisely the churn `userTouchAt` and migration v33 exist to
    // remove — measured at 6 of 58 chats holding 6 of the global top 7, all
    // under a minute old, none of them anything the user had done.
    const flat = flattenOf(
      [ws('personal'), [tab('fresh', { userAt: T })]],
      [
        ws('trayo'),
        [
          tab('stale', { userAt: T - 30 * 24 * HOUR }),
          tab('busy', { spawnedBy: 'stale', status: 'working', activityAt: T }),
        ],
      ],
    );
    expect(ids(flat.live)).toEqual(['fresh', 'stale']);
  });

  it('keeps RECENCY on the root alone — a freshly created child promotes nothing', () => {
    // A spawned chat is stamped `last_user_at = now` at birth (TabStore), on
    // the stated grounds that "it nests under its parent anyway, so its own key
    // decides nothing on screen". A cron that spawns a worker is not you
    // touching anything, so that stamp may never rank a group.
    const flat = flattenOf(
      [ws('personal'), [tab('yours', { userAt: T - HOUR })]],
      [
        ws('trayo'),
        [
          tab('stale', { userAt: T - 30 * 24 * HOUR }),
          tab('just-spawned', { spawnedBy: 'stale', userAt: T }),
        ],
      ],
    );
    expect(ids(flat.live)).toEqual(['yours', 'stale']);
  });

  it('lets a chat that wants you itself outrank one whose worker does', () => {
    // Both are in the attention partition; inside it the root's own state still
    // wins, because a chat asking you something is nearer than a chat whose
    // agent is asking something.
    const flat = flattenOf(
      [ws('personal'), [tab('itself', { userAt: T - 40 * HOUR, status: 'blocked' })]],
      [
        ws('trayo'),
        [
          tab('via-kid', { userAt: T - HOUR }),
          tab('kid', { spawnedBy: 'via-kid', status: 'blocked' }),
        ],
      ],
    );
    expect(ids(flat.live)).toEqual(['itself', 'via-kid']);
  });

  it('reads the rows the group DRAWS — a `contextOnly` heading is not one', () => {
    // The same discipline as the workspace label: the set that can raise the
    // group is the set the group renders. A live parent's row is up in the live
    // list, so its state must not also rank its retired workers' drawer entry.
    // `lead` is the OLDER of the two by user-touch, so recency alone settles
    // the drawer's order and its `blocked` state is the only thing that could
    // flip it. It must not: that state belongs to its row up in the live list.
    const flat = flattenOf([
      ws('personal'),
      [
        tab('lead', { userAt: T - 5 * HOUR, status: 'blocked' }),
        tab('gone', { spawnedBy: 'lead', retired: true }),
        tab('plain-done', { userAt: T, done: true }),
      ],
    ]);
    expect(ids(flat.done)).toEqual(['plain-done', 'lead']);
    // …while the same chat's LIVE row keeps every bit of that state.
    expect(ids(flat.live)).toEqual(['lead']);
  });
});

describe('flattenChats — every chat lands in exactly one place, at every depth', () => {
  it('accounts for a whole three-deep family across both lists', () => {
    // The constraint behind 7e4ecfc, stated as arithmetic rather than as a
    // grouping rule: a grandchild was in NEITHER list and nothing noticed. A
    // `contextOnly` group's root is a HEADING for a row that is still live
    // above, so "exactly once" has to skip it or the root is counted twice.
    const flat = flattenOf([
      ws('personal'),
      [
        tab('root', { userAt: T }),
        tab('kid', { spawnedBy: 'root' }),
        tab('grandkid', { spawnedBy: 'kid' }),
        tab('gone', { spawnedBy: 'root', retired: true }),
        tab('decayed', { userAt: T - 9 * 24 * HOUR, done: true }),
      ],
    ]);
    const drawn = [...flat.live, ...flat.done].flatMap((r) => [
      ...(r.group.contextOnly ? [] : [r.group.chat.id]),
      ...r.group.children.map((k) => k.id),
    ]);
    expect(drawn.sort()).toEqual(['decayed', 'gone', 'grandkid', 'kid', 'root']);
    // …and the drawer's header equals what opening it shows: `gone` + `decayed`.
    expect(flatDoneCount(flat.done)).toBe(2);
  });
});

describe('flattenChats — pins and the done drawer', () => {
  it('floats every pinned chat above every unpinned one, across workspaces', () => {
    const flat = flattenOf(
      [ws('personal'), [tab('fresh', { userAt: T })]],
      [ws('trayo'), [tab('kept', { userAt: T - 30 * 24 * HOUR, pinned: true })]],
    );
    expect(ids(flat.live)).toEqual(['kept', 'fresh']);
    expect(flat.livePinned).toBe(1);
  });

  it('orders the pin block by the same key — there is no cross-workspace manual order', () => {
    // `position` is stored per workspace, so two workspaces both have a first
    // pinned tab and nothing anywhere says which outranks the other. Ranking
    // them by recency is honest; inventing a sequence would not be.
    const flat = flattenOf(
      [ws('personal'), [tab('pa', { userAt: T - 5 * HOUR, pinned: true })]],
      [ws('trayo'), [tab('pb', { userAt: T - HOUR, pinned: true })]],
    );
    expect(ids(flat.live)).toEqual(['pb', 'pa']);
    expect(flat.livePinned).toBe(2);
  });

  it('collects every workspace’s done chats into ONE drawer, newest first', () => {
    const flat = flattenOf(
      [ws('personal'), [tab('old-done', { userAt: T - 9 * 24 * HOUR, done: true })]],
      [ws('trayo'), [tab('just-archived', { userAt: T - HOUR, done: true })]],
    );
    expect(ids(flat.done)).toEqual(['just-archived', 'old-done']);
    expect(flat.live).toEqual([]);
  });

  it('counts CHATS in the drawer, not groups — the header must match what opens', () => {
    // A live parent with delivered workers contributes a `contextOnly` group:
    // its own row is up in the live list, so it must not be counted, while the
    // workers under it must be.
    const flat = flattenOf([
      ws('personal'),
      [
        tab('lead', { userAt: T }),
        tab('w1', { spawnedBy: 'lead', retired: true }),
        tab('w2', { spawnedBy: 'lead', retired: true }),
        tab('decayed', { userAt: T - 9 * 24 * HOUR, done: true }),
      ],
    ]);
    expect(ids(flat.live)).toEqual(['lead']);
    // 2 delivered workers + 1 decayed chat = 3, and the parent label is not one.
    expect(flatDoneCount(flat.done)).toBe(3);
  });

  it('is empty-safe', () => {
    expect(flattenChats([])).toEqual({ live: [], done: [], livePinned: 0 });
  });
});

describe('needsWorkspaceLabel — the trailing label’s budget', () => {
  type Row = FlatChatGroup<ReturnType<typeof ws>>;
  /** Exactly which rows of a rendered list would draw the label, by chat id. */
  const labelled = (rows: Row[], activeSlug: string) =>
    rows
      .filter((r) => needsWorkspaceLabel(r, activeSlug, rows))
      .map((r) => r.group.chat.id)
      .sort();

  it('labels a row that leaves the workspace you are in, and only that row', () => {
    const [here, there] = [ws('personal'), ws('trayo')];
    const flat = flattenOf([here, [tab('mine')]], [there, [tab('theirs')]]);
    const row = (id: string) =>
      flat.live.find((r) => r.group.chat.id === id) as (typeof flat.live)[0];
    expect(needsWorkspaceLabel(row('mine'), 'personal', flat.live)).toBe(false);
    expect(needsWorkspaceLabel(row('theirs'), 'personal', flat.live)).toBe(true);
    // And it follows you: the same row is unlabelled from the other side.
    expect(needsWorkspaceLabel(row('theirs'), 'trayo', flat.live)).toBe(false);
  });

  it('labels BOTH halves of a name two workspaces share — the pair from the screenshot', () => {
    // THE bug. Two rows called 'Main'; the Trayo one said TRAYO and the
    // Personal one said nothing, because a row in the workspace you are already
    // in was never labelled. One labelled row above an identical bare one reads
    // as a rendering fault rather than as two chats that happen to share a name.
    const flat = flattenOf(
      [ws('personal'), [tab('p-main', { name: 'Main' })]],
      [ws('trayo'), [tab('t-main', { name: 'Main' })]],
    );
    expect(labelled(flat.live, 'personal')).toEqual(['p-main', 't-main']);
    // …and from either side. Whichever workspace you are in, both Mains speak.
    expect(labelled(flat.live, 'trayo')).toEqual(['p-main', 't-main']);
  });

  it('still says nothing on a UNIQUE row, however many collisions are elsewhere', () => {
    // The budget the first rule bought is not handed back: the collision rule
    // spends labels on the ambiguous rows and on no others.
    const flat = flattenOf(
      [ws('personal'), [tab('p-main', { name: 'Main' }), tab('quiet', { name: 'Reading list' })]],
      [ws('trayo'), [tab('t-main', { name: 'Main' })]],
    );
    expect(labelled(flat.live, 'personal')).toEqual(['p-main', 't-main']);
  });

  it('reads the name as a human does — case and stray whitespace are not distinctions', () => {
    // 'Main' and 'main ' are the same word on a screen, so the pair is just as
    // ambiguous and has to be labelled just the same.
    const flat = flattenOf(
      [ws('personal'), [tab('p-main', { name: '  Main' })]],
      [ws('trayo'), [tab('t-main', { name: 'main ' })]],
    );
    expect(labelled(flat.live, 'personal')).toEqual(['p-main', 't-main']);
  });

  it('says nothing when the collision is INSIDE one workspace — the label cannot help', () => {
    // Writing PERSONAL on both of these tells the user nothing they did not
    // already know, and costs the name cell up to 84px twice. Two rows that
    // were merely ambiguous would become ambiguous AND truncated.
    const flat = flattenOf([
      ws('personal'),
      [tab('a', { name: 'Main' }), tab('b', { name: 'Main' })],
    ]);
    expect(labelled(flat.live, 'personal')).toEqual([]);
    // But a third Main elsewhere does put every one of them on the record —
    // each same-workspace row now collides with a row the label distinguishes.
    const spread = flattenOf(
      [ws('personal'), [tab('a', { name: 'Main' }), tab('b', { name: 'Main' })]],
      [ws('trayo'), [tab('c', { name: 'Main' })]],
    );
    expect(labelled(spread.live, 'personal')).toEqual(['a', 'b', 'c']);
  });

  it('counts collisions per RENDERED list — the done drawer is a different list', () => {
    // The drawer is collapsed by default, so counting across the seam would
    // make a live row sprout a label when you open it and drop the label when
    // you close it — a label coming and going on a row nothing happened to.
    const flat = flattenOf(
      [ws('personal'), [tab('live-main', { name: 'Main' })]],
      [ws('trayo'), [tab('done-main', { name: 'Main', done: true })]],
    );
    expect(labelled(flat.live, 'personal')).toEqual([]);
    // The archived one still says where it goes, by the first rule.
    expect(labelled(flat.done, 'personal')).toEqual(['done-main']);
  });

  it('ignores names that can never carry a label — children and drawer headings', () => {
    // The set compared has to be the set labelled, or the half-labelled pair
    // comes straight back in a new shape. A CHILD is drawn under its parent,
    // which is the row that says where the pair lives, so the caller exempts
    // it — and it must not make its parent's namesake speak either.
    const kids = flattenOf(
      [ws('personal'), [tab('p-main', { name: 'Main' })]],
      [
        ws('trayo'),
        [tab('lead', { userAt: T - HOUR }), tab('t-kid', { name: 'Main', spawnedBy: 'lead' })],
      ],
    );
    expect(labelled(kids.live, 'personal')).toEqual(['lead']);
    // Same for a `contextOnly` group's root: it is a heading over someone's
    // retired workers, not a row, and it is never labelled.
    const drawer = flattenOf(
      [ws('personal'), [tab('p-done', { name: 'Main', done: true })]],
      [
        ws('trayo'),
        [tab('main', { name: 'Main' }), tab('w1', { spawnedBy: 'main', retired: true })],
      ],
    );
    expect(drawer.done.some((r) => r.group.contextOnly)).toBe(true);
    expect(labelled(drawer.done, 'personal')).toEqual([]);
  });
});

describe('displayedNameKey — the name as a human sees it', () => {
  it('folds case and collapses whitespace', () => {
    expect(displayedNameKey('  Main   Chat ')).toBe(displayedNameKey('main chat'));
    expect(displayedNameKey('Main')).not.toBe(displayedNameKey('Mail'));
  });

  it('folds case WITHOUT asking the locale, so two devices agree', () => {
    // `toLocaleLowerCase` would let the browser's locale decide whether two
    // rows collide: under tr-TR it lowercases 'I' to 'ı', so the very same list
    // would label differently on a phone than on the laptop beside it.
    expect(displayedNameKey('INBOX')).toBe('inbox');
  });

  it('keys Hebrew by its glyphs, not by which code points happened to be typed', () => {
    // Escaped rather than pasted on purpose: these two are the SAME glyph on
    // screen, so written literally the assertion below would read as a typo.
    // U+FB2E is alef-with-patah as one character; U+05D0 U+05B7 is the letter
    // plus its mark. Two strings, one glyph, and NFC is what joins them.
    const oneChar = '\uFB2E';
    const letterPlusMark = '\u05D0\u05B7';
    expect(oneChar).not.toBe(letterPlusMark);
    expect(displayedNameKey(oneChar)).toBe(displayedNameKey(letterPlusMark));
  });

  it('drops the invisible marks pasted Hebrew carries', () => {
    // An RLM draws nothing, so it cannot be what tells two rows apart. Nor can
    // a zero-width space, which `\s` does not even count as whitespace.
    const shalom = '\u05E9\u05DC\u05D5\u05DD';
    expect(displayedNameKey(`\u200F${shalom}\u200E`)).toBe(displayedNameKey(shalom));
    expect(displayedNameKey('\u05E9\u200B\u05DC\u05D5\u05DD')).toBe(displayedNameKey(shalom));
  });
});
