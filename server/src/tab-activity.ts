// Per-tab "last activity" bookkeeping for the living sidebar.
//
// Three signals feed `tabs.last_activity_at`, and they are NOT equally noisy:
//
//   FORCED (write every time — these are discrete, user-meaningful moments):
//     - an agent turn finishing in one of the tab's panes (ws.ts, next to the
//       agent_turn emit)
//     - a user send being submitted to a pane's agent (ws.ts submitSend)
//
//   THROTTLED (at most one DB write per tab per 60s):
//     - raw pty output/input activity. A pane tailing a build emits activity
//       ticks continuously; writing SQLite on each would be thousands of
//       pointless writes per minute for a value whose only consumer is a
//       coarse "which tab did something recently" sort.
//
// The throttle is in-memory and per-process. A restart forgets it — which this
// file used to describe as costing "at most one extra write per tab". That is
// true of the write COUNT and catastrophically wrong about the VALUE.
//
// On boot every pane's runner reconnects and every pty redraws, so every tab
// takes a throttled write within the same second or two. The result is not a
// few redundant rows: it is EVERY TAB SHARING ONE TIMESTAMP, which collapses
// the sidebar's entire recency order into a tie. Observed live after a routine
// restart — twelve tabs, one identical `last_activity_at`, and a chat used
// minutes ago sorted below ones untouched for weeks.
//
// So throttled (pty) signals are ignored for a grace window. A pty redraw
// caused by our own restart is not the user doing something, and it must never
// be allowed to speak for them. FORCED signals are exempt: a turn finishing or
// a send being submitted during the window is real, and those are the only two
// things this value is actually FOR.
//
// THE WINDOW IS ARMED BY PTYD CONNECTING, not by process start. It was armed by
// process start at first, and that is the wrong event: what it suppresses is a
// pty redraw BURST, and the main server's own boot is only one of the doors
// that produces one. ptyd outlives the main server — and the reverse happens
// too. ptyd crashes (or is kickstarted alone), launchd brings it back, and the
// main server runs on untouched with its grace long expired. Every pane died
// with ptyd; the dead-runner sweep respawns every agent pane inside one 20s
// pass; each respawn types its startup_cmd and each of those is an activity
// tick. Same collapse, same second, through a door the original window never
// watched. ptyd connecting is the precise signal that a burst is coming, and at
// boot it connects within milliseconds — so this strictly generalises the
// process-start version rather than replacing it.
//
// Timestamps are only ever moved FORWARD.
import type { PaneStatus } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

/** Minimum wall-clock gap between two THROTTLED writes for the same tab. */
export const ACTIVITY_THROTTLE_MS = 60_000;

/**
 * How long after process start — or after ptyd (re)connects — a THROTTLED
 * (pty) signal is ignored.
 *
 * Sized to outlast the reconnect burst — runners re-hello, ptyd replays
 * scrollback, shells redraw prompts, and the dead-runner sweep respawns every
 * agent pane within one 20s pass — without swallowing a genuine interaction. A
 * user who types into a pane inside this window still bumps its tab, because a
 * submitted send is FORCED.
 */
export const ACTIVITY_BOOT_GRACE_MS = 90_000;

export class TabActivity {
  private readonly tabs: TabStore;
  private readonly panes: PaneStore;
  /** tabId → epoch ms of the last write we performed (forced or throttled). */
  private readonly lastWriteAt = new Map<string, number>();
  /**
   * paneId → epoch ms of the last THROTTLED signal we let through. Purely a
   * pre-filter so a pty emitting several activity ticks per second doesn't
   * pay a `panes.getById` (a fresh prepare + row read + JSON.parse of `env`)
   * only to be thrown away by the tab-level throttle a moment later.
   *
   * Deliberately NOT a paneId→tabId cache: that would go stale on a pane
   * move and keep bumping the wrong tab forever. This only ever skips work,
   * so the worst case is one delayed bump.
   */
  private readonly lastPaneSignalAt = new Map<string, number>();
  private readonly throttleMs: number;
  private readonly bootGraceMs: number;
  /**
   * When the current grace window opened. Process start to begin with, then
   * re-stamped by every ptyd `connected` (see {@link attach}) — a reconnect
   * means a redraw burst is on its way, and that burst is exactly as much "not
   * the user" as a boot one is. Mutable for that reason, which is also why it
   * is not `readonly`.
   */
  private graceFrom: number;
  /**
   * Called after every actual DB write, with the tab that moved.
   *
   * `last_activity_at` drives the sidebar's recency ORDER, and the writes used
   * to emit nothing at all — so a tab that just did something only climbed the
   * list on the next 5s poll, and never at all in a client whose poll is
   * stopped (collapsed workspace, hidden document). This hook lets the wiring
   * layer fan out a `tab.updated`. It is safe to emit on every write because
   * the writes are ALREADY rate-limited: forced ones are discrete user moments
   * (turn-done, a send) and throttled ones are capped at one per tab per
   * `throttleMs`.
   */
  private readonly onWrite: ((tabId: string) => void) | undefined;

  constructor(
    db: Database.Database,
    opts: {
      throttleMs?: number;
      /** Injected in tests; defaults to ACTIVITY_BOOT_GRACE_MS. */
      bootGraceMs?: number;
      /** Injected in tests so the grace window can be driven deterministically. */
      startedAt?: number;
      onWrite?: (tabId: string) => void;
    } = {},
  ) {
    this.tabs = new TabStore(db);
    this.panes = new PaneStore(db);
    this.throttleMs = opts.throttleMs ?? ACTIVITY_THROTTLE_MS;
    this.bootGraceMs = opts.bootGraceMs ?? ACTIVITY_BOOT_GRACE_MS;
    this.graceFrom = opts.startedAt ?? Date.now();
    this.onWrite = opts.onWrite;
  }

  /**
   * Bind to the ptyd control channel. Two listeners, and they belong together:
   *
   *   `paneActivity` → the raw pty tick this whole throttle exists for.
   *   `connected`    → re-arm the grace window. A reconnect is our own
   *                    restart wearing a different hat; see the head of this
   *                    file.
   *
   * Owned HERE rather than wired in the main entry because the entry is a
   * script and therefore untestable — which left the one line connecting
   * ptyd's ticks to this policy as the only part of the path nothing covered,
   * and it is the part where the second door was missed.
   */
  attach(client: PtydClient): void {
    client.on('paneActivity', (e: { id: string }) => {
      this.touchPane(e.id);
    });
    client.on('connected', () => {
      this.noteReconnect();
    });
  }

  /** Open a fresh grace window. Exposed (and clock-injectable) so a test can
   *  drive the reconnect case deterministically. */
  noteReconnect(at: number = Date.now()): void {
    this.graceFrom = at;
  }

  /**
   * Record activity in a tab. `force: true` bypasses the throttle (turn-done,
   * user send); otherwise the write is skipped when one landed for this tab
   * less than `throttleMs` ago. Returns whether a DB write happened — the
   * tests assert on this, and callers can skip a needless event emit.
   *
   * Best-effort by design: this is sidebar decoration, so a failed write
   * (deleted tab racing the signal) is swallowed rather than surfaced.
   */
  touchTab(tabId: string, opts: { force?: boolean; at?: number } = {}): boolean {
    const at = opts.at ?? Date.now();
    if (!opts.force) {
      // Our own restart is not activity — see the grace note at the head of
      // this file. This is the whole fix for "the sidebar forgot its order",
      // and `graceFrom` moves on every ptyd reconnect because a reconnect is
      // our own restart by another name.
      // Bounded at BOTH ends on purpose. An `at` before `graceFrom` is not
      // "inside the window" — it is a caller supplying its own clock (every
      // test here does), and swallowing those would make the window mean
      // "suppress everything that isn't in the future".
      const sinceGrace = at - this.graceFrom;
      if (sinceGrace >= 0 && sinceGrace < this.bootGraceMs) return false;
      const last = this.lastWriteAt.get(tabId);
      if (last !== undefined && at - last < this.throttleMs) return false;
    }
    try {
      this.tabs.touchActivity(tabId, at);
    } catch {
      return false; // tab gone (cascade delete raced the signal)
    }
    this.lastWriteAt.set(tabId, at);
    try {
      this.onWrite?.(tabId);
    } catch {
      // Decoration only — a failed emit must never fail the activity write.
    }
    return true;
  }

  /**
   * Same, resolving the tab from one of its panes. No-op for an unknown pane.
   *
   * The throttle is checked PER PANE before the row read, not just per tab
   * afterwards: raw pty activity arrives several times a second and the row
   * read is the expensive part, so filtering after it would defeat the point
   * of throttling at all. `force` skips the pre-filter (a forced signal must
   * always land).
   */
  touchPane(paneId: string, opts: { force?: boolean; at?: number } = {}): boolean {
    const at = opts.at ?? Date.now();
    if (!opts.force) {
      const last = this.lastPaneSignalAt.get(paneId);
      if (last !== undefined && at - last < this.throttleMs) return false;
      this.lastPaneSignalAt.set(paneId, at);
    }
    const pane = this.panes.getById(paneId);
    if (!pane) return false;
    return this.touchTab(pane.tab_id, { ...opts, at });
  }

  /** Drop a tab's throttle memo (tab deleted) so the map can't grow forever.
   *  Wired into the tab DELETE handler (routes/tabs.ts). */
  forget(tabId: string): void {
    this.lastWriteAt.delete(tabId);
  }

  /** Drop a pane's pre-filter memo (pane deleted / moved). Same purpose as
   *  {@link forget}: keep the in-memory maps bounded by what still exists. */
  forgetPane(paneId: string): void {
    this.lastPaneSignalAt.delete(paneId);
  }
}

/**
 * Order the UNPINNED block of a workspace's sidebar: wants-you-now first,
 * then most-recently-active. Exported (and pure) so the ordering rules are
 * testable without a server.
 *
 * `busy` used to be a second sort key here, and it is deliberately gone. Busy
 * was encoded TWICE — as a glyph and as sort position — so a tab going to work
 * jumped up the list while you were reaching for the row below it, and going
 * quiet dropped it back. The status rail says "working" perfectly well from a
 * fixed column; the rail should not also shuffle under the cursor. Attention
 * keeps its promotion: "wants you now" is worth moving a row for, it is rare,
 * and it clears when you look at it.
 *
 * Ties and edge cases, all deliberate:
 *  - attention is a boolean, so it partitions rather than sorts; within a
 *    partition the next key applies.
 *  - `last_activity_at` null (never observed — a row migrated in before the
 *    column existed) sorts AFTER every known timestamp, never before.
 *  - equal timestamps fall through to `position` (the stored manual order),
 *    then `id`, so the result is TOTAL: no two tabs can swap places between
 *    two renders of identical data, which would make the sidebar jitter.
 */
export interface SortableTab {
  id: string;
  status?: PaneStatus | undefined;
  attention?: boolean | undefined;
  last_activity_at?: number | null | undefined;
}

/** "This tab wants you NOW" — the one condition still worth reordering for.
 *  Reads `status` when the row carries it and falls back to the deprecated
 *  `attention` alias otherwise. The fallback is not decoration: `attention` is
 *  the raw BEL bit, and an AGENT chat never rings BEL — so a pane parked on
 *  `ask_user`, the highest-value case there is, would get no promotion at all
 *  if this partitioned on `attention` alone. */
function wantsYou(t: SortableTab): boolean {
  return t.status === 'blocked' || t.attention === true;
}

export function compareUnpinnedTabs(
  a: SortableTab,
  b: SortableTab,
  positions: Map<string, number>,
): number {
  const attn = Number(wantsYou(b)) - Number(wantsYou(a));
  if (attn !== 0) return attn;
  // Nulls last: -Infinity is smaller than any real timestamp, and we sort
  // descending, so a never-active tab lands at the bottom of its partition.
  const at =
    (b.last_activity_at ?? Number.NEGATIVE_INFINITY) -
    (a.last_activity_at ?? Number.NEGATIVE_INFINITY);
  // NaN guard: (-Inf) - (-Inf) is NaN, which would make the comparator
  // inconsistent and the sort implementation-defined.
  if (at !== 0 && !Number.isNaN(at)) return at < 0 ? -1 : 1;
  const pos = (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0);
  if (pos !== 0) return pos;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
