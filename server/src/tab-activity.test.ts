import { describe, expect, it } from 'vitest';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import {
  ACTIVITY_THROTTLE_MS,
  type SortableTab,
  TabActivity,
  compareUnpinnedTabs,
} from './tab-activity.js';

function fixture() {
  const db = openDb(':memory:');
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const tab = tabs.create({ name: 'T', layout: '', workspace_id: ws.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
  const read = (id: string) => tabs.getById(id)?.last_activity_at ?? null;
  return { db, ws, tabs, panes, tab, pane, read };
}

describe('TabActivity — the 60s throttle', () => {
  it('writes the first throttled signal immediately', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    expect(a.touchTab(f.tab.id, { at: 1_000_000 })).toBe(true);
    expect(f.read(f.tab.id)).toBe(1_000_000);
  });

  it('collapses a burst of throttled signals into ONE write per tab per 60s', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { at: t0 });
    let writes = 0;
    // A pane tailing a build: a tick every 200ms for two minutes.
    for (let ms = 200; ms <= 120_000; ms += 200) {
      if (a.touchTab(f.tab.id, { at: t0 + ms })) writes++;
    }
    // Exactly two more windows open in 120s.
    expect(writes).toBe(2);
    expect(f.read(f.tab.id)).toBe(t0 + 120_000);
  });

  it('rejects a throttled signal inside the window and admits it just after', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { at: t0 });
    expect(a.touchTab(f.tab.id, { at: t0 + ACTIVITY_THROTTLE_MS - 1 })).toBe(false);
    expect(f.read(f.tab.id)).toBe(t0); // unchanged — no write happened
    expect(a.touchTab(f.tab.id, { at: t0 + ACTIVITY_THROTTLE_MS })).toBe(true);
    expect(f.read(f.tab.id)).toBe(t0 + ACTIVITY_THROTTLE_MS);
  });

  it('force bypasses the throttle — turn-done and user sends always land', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { at: t0 });
    expect(a.touchTab(f.tab.id, { at: t0 + 1, force: true })).toBe(true);
    expect(f.read(f.tab.id)).toBe(t0 + 1);
    expect(a.touchTab(f.tab.id, { at: t0 + 2, force: true })).toBe(true);
    expect(f.read(f.tab.id)).toBe(t0 + 2);
  });

  it('a forced write also re-arms the throttle window', () => {
    // Otherwise a send (forced) followed by pty chatter would write twice in
    // the same second — the throttle must be about the TAB, not the source.
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { at: t0, force: true });
    expect(a.touchTab(f.tab.id, { at: t0 + 10 })).toBe(false);
  });

  it('throttles per TAB, not globally', () => {
    const f = fixture();
    const other = f.tabs.create({ name: 'T2', layout: '', workspace_id: f.ws.id });
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    expect(a.touchTab(f.tab.id, { at: t0 })).toBe(true);
    expect(a.touchTab(other.id, { at: t0 })).toBe(true);
    expect(a.touchTab(f.tab.id, { at: t0 + 5 })).toBe(false);
  });

  it('touchPane resolves the pane’s tab; an unknown pane is a silent no-op', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    expect(a.touchPane(f.pane.id, { at: 2_000_000, force: true })).toBe(true);
    expect(f.read(f.tab.id)).toBe(2_000_000);
    expect(a.touchPane('nope', { force: true })).toBe(false);
  });

  it('touchPane throttles BEFORE the row read — the expensive part is skipped', () => {
    // The row read (a fresh prepare + row fetch + JSON.parse of `env`) is the
    // costly bit, and pty activity arrives several times a second; filtering
    // only afterwards would defeat the throttle's whole purpose.
    const f = fixture();
    const a = new TabActivity(f.db);
    let reads = 0;
    const store = (a as unknown as { panes: { getById: (id: string) => unknown } }).panes;
    const real = store.getById.bind(store);
    store.getById = (id: string) => {
      reads++;
      return real(id);
    };
    const t0 = 1_000_000;
    a.touchPane(f.pane.id, { at: t0 });
    for (let ms = 200; ms <= 30_000; ms += 200) a.touchPane(f.pane.id, { at: t0 + ms });
    expect(reads).toBe(1); // 150 signals, one read
  });

  it('a forced touchPane always reads through, bypassing the pre-filter', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchPane(f.pane.id, { at: t0 });
    expect(a.touchPane(f.pane.id, { at: t0 + 1, force: true })).toBe(true);
    expect(f.read(f.tab.id)).toBe(t0 + 1);
  });

  it('forgetPane clears the pre-filter so a moved pane bumps its new tab at once', () => {
    const f = fixture();
    const other = f.tabs.create({ name: 'T2', layout: '', workspace_id: f.ws.id });
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchPane(f.pane.id, { at: t0 });
    // Move the pane; without forgetPane the next tick would sit out the rest
    // of the old tab's window and the new tab would look stale.
    f.panes.setTab(f.pane.id, other.id);
    a.forgetPane(f.pane.id);
    expect(a.touchPane(f.pane.id, { at: t0 + 5 })).toBe(true);
    expect(f.read(other.id)).toBe(t0 + 5);
  });

  it('forget drops a deleted tab’s memo (the maps stay bounded)', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { at: t0 });
    expect(a.touchTab(f.tab.id, { at: t0 + 5 })).toBe(false); // throttled
    a.forget(f.tab.id);
    // Memo gone → the window restarts (the row is still there in this test).
    expect(a.touchTab(f.tab.id, { at: t0 + 6 })).toBe(true);
  });

  it('a deleted tab is a silent no-op, not a thrown error', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    f.tabs.delete(f.tab.id);
    // The row is gone; UPDATE matches nothing. Must not throw — this runs
    // inside a ws message handler.
    expect(() => a.touchTab(f.tab.id, { force: true })).not.toThrow();
  });
});

describe('compareUnpinnedTabs — the auto-sorted block', () => {
  const sort = (
    rows: SortableTab[],
    positions: Map<string, number> = new Map(rows.map((r, i) => [r.id, i])),
  ) => [...rows].sort((a, b) => compareUnpinnedTabs(a, b, positions)).map((r) => r.id);

  it('needs-attention first, then recency — busy is NOT a sort key', () => {
    // Busy used to promote a tab above every idle one. It was the same signal
    // twice (a glyph AND a position), so a tab going to work jumped up the
    // list while you were reaching for the row below it. The status rail says
    // "working" from a fixed column; the rail must not also shuffle.
    expect(
      sort([
        { id: 'old', last_activity_at: 1 },
        { id: 'working', last_activity_at: 1 },
        { id: 'recent', last_activity_at: 99 },
        { id: 'attn', attention: true, last_activity_at: 1 },
      ]),
      // 'old' and 'working' tie on recency, so they fall through to position
      // order — which is exactly the point: working no longer moves anything.
    ).toEqual(['attn', 'recent', 'old', 'working']);
  });

  it('attention still promotes — it is rare, it clears when you look, and it is worth moving for', () => {
    expect(
      sort([
        { id: 'recent', last_activity_at: 10_000 },
        { id: 'attn', attention: true, last_activity_at: 1 },
      ]),
    ).toEqual(['attn', 'recent']);
  });

  it('a BLOCKED tab is promoted even with no BEL — agent chats never ring one', () => {
    // The fallback to `attention` is not decoration. `attention` is the raw BEL
    // bit, and a chat-native agent never rings it — so a pane parked on
    // ask_user (the highest-value case there is) would get no promotion at all
    // if this partitioned on `attention` alone.
    expect(
      sort([
        { id: 'recent', status: 'working', last_activity_at: 10_000 },
        { id: 'asking', status: 'blocked', last_activity_at: 1 },
      ]),
    ).toEqual(['asking', 'recent']);
  });

  it('within the attention partition, order is pure recency', () => {
    expect(
      sort([
        { id: 'b', last_activity_at: 5 },
        { id: 'a-old', attention: true, last_activity_at: 1 },
        { id: 'a-new', attention: true, last_activity_at: 2 },
      ]),
    ).toEqual(['a-new', 'a-old', 'b']);
  });

  it('null last_activity_at (migrated rows) sorts LAST, never first', () => {
    expect(
      sort([
        { id: 'never', last_activity_at: null },
        { id: 'ancient', last_activity_at: 1 },
        { id: 'missing' },
      ]),
    ).toEqual(['ancient', 'never', 'missing']); // nulls keep position order between themselves
  });

  it('a null timestamp sorts after a real one, even against an attention row’s partition', () => {
    expect(
      sort([
        { id: 'nullattn', attention: true, last_activity_at: null },
        { id: 'recent', last_activity_at: 10_000 },
      ]),
      // The attention partition still comes first; nulls only lose WITHIN a
      // partition.
    ).toEqual(['nullattn', 'recent']);
  });

  it('ties fall through to position, then id — the order is TOTAL', () => {
    // Identical on every signal: the comparator must still be deterministic,
    // or the sidebar would visibly reshuffle on every 5s poll.
    const rows = [
      { id: 'c', last_activity_at: 5 },
      { id: 'a', last_activity_at: 5 },
      { id: 'b', last_activity_at: 5 },
    ];
    const positions = new Map([
      ['a', 2],
      ['b', 1],
      ['c', 0],
    ]);
    expect(sort(rows, positions)).toEqual(['c', 'b', 'a']);
    // Same data, different input order → same output.
    expect(sort([...rows].reverse(), positions)).toEqual(['c', 'b', 'a']);
  });

  it('two nulls with equal position fall through to id (never NaN-unstable)', () => {
    const positions = new Map([
      ['z', 0],
      ['a', 0],
    ]);
    expect(sort([{ id: 'z', last_activity_at: null }, { id: 'a' }], positions)).toEqual(['a', 'z']);
  });
});
