// Sidebar activity has three policies: discrete sends/completions are forced,
// terminal input is leading + trailing batched at one second, and background
// output is sampled every five seconds. Only output observes reconnect grace:
// replayed scrollback must not erase the user's recency order.
import type Database from 'better-sqlite3';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

/** Output may reorder within one visible-poll interval, at most 12 writes/min
 * per continuously active tab. Sixty seconds made ordinary work look stale. */
export const ACTIVITY_THROTTLE_MS = 5_000;
/** Bound input fan-out while retaining even the final key of a short burst. */
export const INPUT_ACTIVITY_THROTTLE_MS = 1_000;

/**
 * How long after process start — or after ptyd (re)connects — a THROTTLED
 * (pty) signal is ignored.
 *
 * Sized to outlast runner reconnects, scrollback replay, and the 20s respawn
 * sweep. Terminal input bypasses this window; redraw/output does not.
 */
export const ACTIVITY_BOOT_GRACE_MS = 90_000;

export class TabActivity {
  private readonly tabs: TabStore;
  private readonly panes: PaneStore;
  /** tabId → epoch ms of the last write we performed (forced or throttled). */
  private readonly lastWriteAt = new Map<string, number>();
  /** Pane pre-filter uses the TAB's last admitted write, never rejected ticks.
   * Ownership is read again at each eligible tick so pane moves cannot leave
   * a persistent pane-to-tab cache pointing at the old tab. */
  private readonly lastPaneSignalAt = new Map<string, number>();
  private readonly lastInputWriteAt = new Map<string, number>();
  private readonly pendingInput = new Map<
    string,
    {
      at: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
   * (turn-done, a send), input is batched at one second, and output is
   * sampled at `throttleMs`.
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

  /** Direct tab calls are terminal INPUT (the ws keyboard path). Background
   * ptyd activity arrives through touchPane and explicitly selects output.
   * Returns whether this call wrote synchronously; a batched input also emits
   * onWrite when its trailing flush lands, even if the terminal goes quiet. */
  touchTab(
    tabId: string,
    opts: { force?: boolean; at?: number; source?: 'input' | 'output' } = {},
  ): boolean {
    const at = opts.at ?? Date.now();
    if (opts.force) return this.writeTab(tabId, at);
    if (opts.source === 'output') {
      if (this.inGrace(at)) return false;
      const last = this.lastWriteAt.get(tabId);
      if (last !== undefined && at - last < this.throttleMs) return false;
      return this.writeTab(tabId, at);
    }

    // Input has its own budget: a background write must not hide a user's
    // first keystroke. Keep the latest key's time, not the timer's firing time.
    const last = this.lastInputWriteAt.get(tabId);
    if (last === undefined || at - last >= INPUT_ACTIVITY_THROTTLE_MS) {
      this.lastInputWriteAt.set(tabId, at);
      return this.writeTab(tabId, at);
    }
    const pending = this.pendingInput.get(tabId);
    if (pending) {
      pending.at = Math.max(pending.at, at);
    } else {
      const due = last + INPUT_ACTIVITY_THROTTLE_MS;
      const entry = {
        at,
        timer: setTimeout(
          () => {
            this.pendingInput.delete(tabId);
            this.lastInputWriteAt.set(tabId, due);
            this.writeTab(tabId, entry.at);
          },
          Math.max(0, due - at),
        ),
      };
      entry.timer.unref();
      this.pendingInput.set(tabId, entry);
    }
    return false;
  }

  private inGrace(at: number): boolean {
    const sinceGrace = at - this.graceFrom;
    return sinceGrace >= 0 && sinceGrace < this.bootGraceMs;
  }

  private writeTab(tabId: string, at: number): boolean {
    const pending = this.pendingInput.get(tabId);
    if (pending && pending.at <= at) {
      clearTimeout(pending.timer);
      this.pendingInput.delete(tabId);
    }
    try {
      this.tabs.touchActivity(tabId, at);
    } catch {
      return false;
    }
    this.lastWriteAt.set(tabId, Math.max(at, this.lastWriteAt.get(tabId) ?? at));
    try {
      this.onWrite?.(tabId);
    } catch {
      // Decoration only — a failed emit must never fail the activity write.
    }
    return true;
  }

  /** Background output, resolving ownership only after the cheap pre-filter.
   * Neither a rejected tab write nor grace advances the pane's clock. */
  touchPane(paneId: string, opts: { force?: boolean; at?: number } = {}): boolean {
    const at = opts.at ?? Date.now();
    if (!opts.force) {
      if (this.inGrace(at)) return false;
      const last = this.lastPaneSignalAt.get(paneId);
      if (last !== undefined && at - last < this.throttleMs) return false;
    }
    const pane = this.panes.getById(paneId);
    if (!pane) return false;
    const wrote = this.touchTab(pane.tab_id, { ...opts, at, source: 'output' });
    const last = this.lastWriteAt.get(pane.tab_id);
    if (last !== undefined) this.lastPaneSignalAt.set(paneId, last);
    return wrote;
  }

  /** Drop a tab's throttle memo (tab deleted) so the map can't grow forever.
   *  Wired into the tab DELETE handler (routes/tabs.ts). */
  forget(tabId: string): void {
    this.lastWriteAt.delete(tabId);
    this.lastInputWriteAt.delete(tabId);
    const pending = this.pendingInput.get(tabId);
    if (pending) clearTimeout(pending.timer);
    this.pendingInput.delete(tabId);
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
 *  - equal timestamps fall through to the shared wire `id`, so the result is
 *    total: identical data cannot jitter between renders or between clients.
 */
// The sidebar order moved to @muxpad/shared so the CLIENT can apply it to a
// pushed row instead of waiting for its next poll — see shared/src/tab-order.ts
// for why that wait was the bug. Re-exported here because this module is where
// the rest of the server has always imported it from.
export { type SortableTab, compareUnpinnedTabs, tabWantsYou } from '@muxpad/shared';
