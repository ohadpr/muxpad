import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('TabActivity — the output throttle', () => {
  it('writes the first throttled signal immediately', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    expect(a.touchTab(f.tab.id, { source: 'output', at: 1_000_000 })).toBe(true);
    expect(f.read(f.tab.id)).toBe(1_000_000);
  });

  it('collapses a burst of throttled signals into ONE write per tab per five seconds', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { source: 'output', at: t0 });
    let writes = 0;
    // A pane tailing a build: a tick every 200ms for two minutes.
    for (let ms = 200; ms <= 120_000; ms += 200) {
      if (a.touchTab(f.tab.id, { source: 'output', at: t0 + ms })) writes++;
    }
    // Continuous output admits one write per five-second window.
    expect(writes).toBe(120_000 / ACTIVITY_THROTTLE_MS);
    expect(f.read(f.tab.id)).toBe(t0 + 120_000);
  });

  it('rejects a throttled signal inside the window and admits it just after', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { source: 'output', at: t0 });
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 + ACTIVITY_THROTTLE_MS - 1 })).toBe(
      false,
    );
    expect(f.read(f.tab.id)).toBe(t0); // unchanged — no write happened
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 + ACTIVITY_THROTTLE_MS })).toBe(true);
    expect(f.read(f.tab.id)).toBe(t0 + ACTIVITY_THROTTLE_MS);
  });

  it('force bypasses the throttle — turn-done and user sends always land', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { source: 'output', at: t0 });
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 + 1, force: true })).toBe(true);
    expect(f.read(f.tab.id)).toBe(t0 + 1);
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 + 2, force: true })).toBe(true);
    expect(f.read(f.tab.id)).toBe(t0 + 2);
  });

  it('a forced write also re-arms the throttle window', () => {
    // Otherwise a send (forced) followed by pty chatter would write twice in
    // the same second — the throttle must be about the TAB, not the source.
    const f = fixture();
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    a.touchTab(f.tab.id, { source: 'output', at: t0, force: true });
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 + 10 })).toBe(false);
  });

  it('throttles per TAB, not globally', () => {
    const f = fixture();
    const other = f.tabs.create({ name: 'T2', layout: '', workspace_id: f.ws.id });
    const a = new TabActivity(f.db);
    const t0 = 1_000_000;
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 })).toBe(true);
    expect(a.touchTab(other.id, { source: 'output', at: t0 })).toBe(true);
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 + 5 })).toBe(false);
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
    for (let ms = 200; ms < ACTIVITY_THROTTLE_MS; ms += 200)
      a.touchPane(f.pane.id, { at: t0 + ms });
    expect(reads).toBe(1); // All ticks inside one output window share one read
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
    a.touchTab(f.tab.id, { source: 'output', at: t0 });
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 + 5 })).toBe(false); // throttled
    a.forget(f.tab.id);
    // Memo gone → the window restarts (the row is still there in this test).
    expect(a.touchTab(f.tab.id, { source: 'output', at: t0 + 6 })).toBe(true);
  });

  it('a deleted tab is a silent no-op, not a thrown error', () => {
    const f = fixture();
    const a = new TabActivity(f.db);
    f.tabs.delete(f.tab.id);
    // The row is gone; UPDATE matches nothing. Must not throw — this runs
    // inside a ws message handler.
    expect(() => a.touchTab(f.tab.id, { source: 'output', force: true })).not.toThrow();
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
      // 'old' and 'working' tie on recency, so they fall through to ID
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
    ).toEqual(['ancient', 'missing', 'never']); // nulls use the canonical wire ID
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

  it('ties ignore caller positions and use wire id — the order is TOTAL', () => {
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
    expect(sort(rows, positions)).toEqual(['a', 'b', 'c']);
    // Same data, different input order → same output.
    expect(sort([...rows].reverse(), positions)).toEqual(['a', 'b', 'c']);
  });

  it('two nulls with equal position fall through to id (never NaN-unstable)', () => {
    const positions = new Map([
      ['z', 0],
      ['a', 0],
    ]);
    expect(sort([{ id: 'z', last_activity_at: null }, { id: 'a' }], positions)).toEqual(['a', 'z']);
  });
});

describe('our own restart is not activity', () => {
  // Observed live: a routine restart left TWELVE tabs sharing one
  // `last_activity_at` to the second, because every runner reconnects and every
  // pty redraws at boot. The recency order didn't degrade — it collapsed into a
  // tie, and a chat used minutes earlier sorted below ones untouched for weeks.
  // The file's own comment called this "at most one extra write per tab", which
  // is true of the count and wrong about the value.
  const t0 = 1_800_000_000_000;

  it('ignores pty signals during the boot grace window', () => {
    const f = fixture();
    const act = new TabActivity(f.db, { startedAt: t0, bootGraceMs: 90_000 });
    expect(act.touchTab(f.tab.id, { source: 'output', at: t0 + 1_000 })).toBe(false);
    expect(act.touchTab(f.tab.id, { source: 'output', at: t0 + 89_000 })).toBe(false);
  });

  it('lets them through once the window has passed', () => {
    const f = fixture();
    const act = new TabActivity(f.db, { startedAt: t0, bootGraceMs: 90_000 });
    expect(act.touchTab(f.tab.id, { source: 'output', at: t0 + 91_000 })).toBe(true);
  });

  it('never suppresses a FORCED signal — a real send during boot still counts', () => {
    // The exemption that keeps this from being a regression: a turn finishing
    // or a message you submitted are the only two things this value is for.
    const f = fixture();
    const act = new TabActivity(f.db, { startedAt: t0, bootGraceMs: 90_000 });
    expect(act.touchTab(f.tab.id, { source: 'output', at: t0 + 1_000, force: true })).toBe(true);
  });
});

describe('a ptyd reconnect is our own restart too', () => {
  // The boot grace above was armed by PROCESS START, which is the wrong event.
  // The thing it suppresses is a pty redraw BURST, and the main server's boot
  // is only one of the doors that produces one.
  //
  // ptyd outlives the main server, and the reverse also happens: ptyd crashes
  // (or is kickstarted alone) and launchd brings it back while the main server
  // runs on, untouched, its grace long expired. Every pane in ptyd died with
  // it, the dead-runner sweep respawns every agent pane within one 20s pass,
  // each respawn types its startup_cmd, and each of those is a paneActivity
  // tick. One throttled write per tab, all inside the same couple of seconds —
  // which is not "a few redundant rows", it is every tab sharing one timestamp
  // and the sidebar's recency order collapsing into a tie. Byte for byte the
  // catastrophe the boot grace exists to prevent, through a door it never
  // watched.
  //
  // So the window is armed by ptyd CONNECTING, which is the precise signal
  // that a redraw burst is coming. At boot ptyd connects within milliseconds,
  // so this strictly generalises the old behaviour rather than replacing it.
  const t0 = 1_800_000_000_000;

  /** The ptyd control channel, reduced to the events TabActivity attaches to. */
  function fakeClient() {
    return new EventEmitter() as unknown as Parameters<TabActivity['attach']>[0] & EventEmitter;
  }

  // THE REPRODUCTION, and it has to be on an injected clock: the burst must
  // land well outside the 60s throttle, or the throttle suppresses it anyway
  // and the test passes with the grace ripped out. (It did, on the first
  // draft — a green test proving nothing, which is the whole failure mode this
  // area keeps producing.)
  it('re-arms the grace on reconnect — a respawn burst cannot flatten the order', () => {
    const f = fixture();
    const other = new TabStore(f.db).create({ name: 'T2', layout: '', workspace_id: f.ws.id });
    const act = new TabActivity(f.db, { startedAt: t0, bootGraceMs: 90_000 });

    // Two tabs used an hour apart. This is the recency order the user made.
    expect(act.touchTab(f.tab.id, { source: 'output', at: t0 + 1_000_000 })).toBe(true);
    expect(act.touchTab(other.id, { source: 'output', at: t0 + 4_600_000 })).toBe(true);
    const settled = { a: f.read(f.tab.id), b: f.read(other.id) };
    expect(settled.a).not.toBe(settled.b);

    // ptyd dies and comes back hours later — far outside every throttle
    // window. The sweep respawns every agent pane in one pass, so the redraw
    // burst reaches every tab inside the same second or two.
    const back = t0 + 10_000_000;
    act.noteReconnect(back);
    expect(act.touchTab(f.tab.id, { source: 'output', at: back + 500 })).toBe(false);
    expect(act.touchTab(other.id, { source: 'output', at: back + 700 })).toBe(false);

    // Untouched — so the order the user produced survives. Without the
    // re-arm both rows are rewritten to within 200ms of each other and the
    // sidebar's recency order collapses into a tie.
    expect(f.read(f.tab.id)).toBe(settled.a);
    expect(f.read(other.id)).toBe(settled.b);
  });

  // …and the listener that calls it. Separate, because the test above proves
  // the POLICY and this proves the WIRING — the part that lived in an
  // unimportable script and is where the second door was missed. Real clock
  // (the listener's own), no prior write, so the grace is the only thing that
  // can suppress this.
  it('the ptyd `connected` event is what arms it', () => {
    const f = fixture();
    const act = new TabActivity(f.db, { startedAt: Date.now() - 3_600_000, bootGraceMs: 90_000 });
    const c = fakeClient();
    act.attach(c);
    (c as EventEmitter).emit('connected');
    expect(act.touchTab(f.tab.id, { source: 'output' })).toBe(false);
    expect(f.read(f.tab.id)).toBe(f.tabs.getById(f.tab.id)?.created_at ?? null);
  });

  it('still lets a FORCED signal through during a reconnect burst', () => {
    const f = fixture();
    const act = new TabActivity(f.db, { startedAt: Date.now() - 3_600_000, bootGraceMs: 90_000 });
    const c = fakeClient();
    act.attach(c);
    (c as EventEmitter).emit('connected');
    // You typing into a pane while ptyd is coming back is still you.
    expect(act.touchTab(f.tab.id, { source: 'output', force: true })).toBe(true);
  });

  it('admits pty signals again once the re-armed window expires', () => {
    const f = fixture();
    const act = new TabActivity(f.db, { startedAt: t0, bootGraceMs: 90_000 });
    // Injected clock here, so the window's EDGES are exact rather than racing
    // the wall clock.
    act.noteReconnect(t0);
    expect(act.touchTab(f.tab.id, { source: 'output', at: t0 + 89_000 })).toBe(false);
    expect(act.touchTab(f.tab.id, { source: 'output', at: t0 + 91_000 })).toBe(true);
  });

  it('routes paneActivity through touchPane, so the wiring is the tested thing', () => {
    // The listener used to live in index.ts, which is a SCRIPT and therefore
    // untestable — so the one line connecting ptyd's ticks to this policy was
    // the only part nothing covered. Owning both listeners here means a test
    // can drive the real path end to end.
    const f = fixture();
    const act = new TabActivity(f.db, { startedAt: t0, bootGraceMs: 0 });
    const c = fakeClient();
    act.attach(c);
    (c as EventEmitter).emit('paneActivity', { id: f.pane.id });
    expect(f.read(f.tab.id)).not.toBeNull();
  });
});

describe('terminal input survives sampling and reconnect', () => {
  afterEach(() => vi.useRealTimers());

  it.each([0, 90_000])(
    'ordinary terminal input immediately overtakes a newer tab (grace %s)',
    (bootGraceMs) => {
      vi.useFakeTimers();
      const now = Date.now();
      const f = fixture();
      const other = f.tabs.create({ name: 'B', layout: '', workspace_id: f.ws.id });
      const writes: string[] = [];
      const a = new TabActivity(f.db, {
        startedAt: now,
        bootGraceMs,
        onWrite: (id) => writes.push(id),
      });
      a.touchTab(f.tab.id, { force: true, at: now });
      a.touchTab(other.id, { force: true, at: now + 30_000 });
      expect(a.touchTab(f.tab.id, { at: now + 40_000 })).toBe(true);
      expect(f.read(f.tab.id)).toBeGreaterThan(f.read(other.id)!);
      expect(writes).toEqual([f.tab.id, other.id, f.tab.id]);
    },
  );

  it('flushes the last key of a short burst within one second, without further input', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const f = fixture();
    const writes: number[] = [];
    const a = new TabActivity(f.db, {
      startedAt: now,
      onWrite: () => writes.push(f.read(f.tab.id)!),
    });
    a.touchTab(f.tab.id);
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(100);
      a.touchTab(f.tab.id);
    }
    expect(writes).toEqual([now]);
    vi.advanceTimersByTime(100);
    expect(writes).toEqual([now, now + 900]);
    vi.advanceTimersByTime(90_000);
    expect(writes).toHaveLength(2);
  });

  it('forget cancels a deleted tab’s pending input flush', () => {
    vi.useFakeTimers();
    const f = fixture();
    const onWrite = vi.fn();
    const a = new TabActivity(f.db, { onWrite });
    a.touchTab(f.tab.id);
    vi.advanceTimersByTime(100);
    a.touchTab(f.tab.id);
    a.forget(f.tab.id);
    vi.advanceTimersByTime(1000);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it('a forced completion supersedes pending keys without a stale trailing emit', () => {
    vi.useFakeTimers();
    const f = fixture();
    const onWrite = vi.fn();
    const a = new TabActivity(f.db, { onWrite });
    a.touchTab(f.tab.id);
    vi.advanceTimersByTime(100);
    a.touchTab(f.tab.id);
    vi.advanceTimersByTime(100);
    a.touchTab(f.tab.id, { force: true });
    const completed = f.read(f.tab.id);
    vi.advanceTimersByTime(1000);
    expect(onWrite).toHaveBeenCalledTimes(2);
    expect(f.read(f.tab.id)).toBe(completed);
  });
});

describe('output has a five-second budget, without a second pane window', () => {
  it('does not double the write gap after an offset forced event', () => {
    const f = fixture();
    const now = Date.now();
    const writes: number[] = [];
    const a = new TabActivity(f.db, {
      bootGraceMs: 0,
      onWrite: () => writes.push(f.read(f.tab.id)!),
    });
    a.touchPane(f.pane.id, { at: now });
    a.touchTab(f.tab.id, { force: true, at: now + 1000 });
    for (let ms = 2000; ms <= 6000; ms += 1000) a.touchPane(f.pane.id, { at: now + ms });
    expect(writes.map((at) => at - now)).toEqual([0, 1000, 6000]);
  });

  it('a suppressed tick at grace end cannot extend startup suppression', () => {
    const f = fixture();
    const now = Date.now();
    const a = new TabActivity(f.db, { startedAt: now });
    expect(a.touchPane(f.pane.id, { at: now + 89_000 })).toBe(false);
    expect(a.touchPane(f.pane.id, { at: now + 90_000 })).toBe(true);
    expect(f.read(f.tab.id)).toBe(now + 90_000);
  });
});
