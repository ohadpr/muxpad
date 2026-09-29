import type { Tab } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { groupChats } from '../components/NavTree';
import { flatDoneCount, flattenChats, needsWorkspaceLabel } from './flat-chats';

const T = 1_800_000_000_000;
const HOUR = 3_600_000;

function tab(
  id: string,
  o: {
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
    name: id,
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
  it('labels a row that leaves the workspace you are in, and only that row', () => {
    const [here, there] = [ws('personal'), ws('trayo')];
    const flat = flattenOf([here, [tab('mine')]], [there, [tab('theirs')]]);
    const row = (id: string) =>
      flat.live.find((r) => r.group.chat.id === id) as (typeof flat.live)[0];
    expect(needsWorkspaceLabel(row('mine'), 'personal')).toBe(false);
    expect(needsWorkspaceLabel(row('theirs'), 'personal')).toBe(true);
    // And it follows you: the same row is unlabelled from the other side.
    expect(needsWorkspaceLabel(row('theirs'), 'trayo')).toBe(false);
  });
});
