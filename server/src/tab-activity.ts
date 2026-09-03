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
// The throttle is in-memory and per-process. A restart forgets it, which
// costs at most one extra write per tab — deliberately cheaper than
// persisting throttle state. Timestamps are only ever moved FORWARD.
import type { PaneStatus } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

/** Minimum wall-clock gap between two THROTTLED writes for the same tab. */
export const ACTIVITY_THROTTLE_MS = 60_000;

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
    opts: { throttleMs?: number; onWrite?: (tabId: string) => void } = {},
  ) {
    this.tabs = new TabStore(db);
    this.panes = new PaneStore(db);
    this.throttleMs = opts.throttleMs ?? ACTIVITY_THROTTLE_MS;
    this.onWrite = opts.onWrite;
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
