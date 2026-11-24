import type { Tab } from '@muxpad/shared';
import { sortSidebarTabs } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { type PtydCache, cronsByTab, decorateTab } from './ptyd-cache.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { type ClockSnapshot, clockSnapshot } from './tab-clock.js';

/**
 * ONE WORKSPACE'S TABS, IN THE ORDER EVERY SURFACE MUST SHOW THEM.
 *
 * Extracted from routes/tabs.ts so a second route can serve the identical
 * list: `GET /api/boot` hands the sidebar its first two rungs in one answer,
 * and a prefetch that returned a DIFFERENT shape or a different order from the
 * endpoint it stands in for would be worse than no prefetch — the app would
 * render one list and then rearrange it.
 *
 * The rest of the reasoning (why the sort lives on the server, why the clock
 * snapshot is passed in rather than rebuilt per workspace) is in the comments
 * below, where it has always been.
 */
export function orderedTabsForWorkspace(
  db: Database.Database,
  cache: PtydCache,
  workspaceId: string,
  shared?: ClockSnapshot,
  /** Drop each row's `spawn_report` TEXT. See {@link stripReportText}. */
  opts?: { omitReportText?: boolean },
): Tab[] {
  const tabs = new TabStore(db);
  const raw = tabs.listByWorkspace(workspaceId);
  // Fold in the two independent per-tab signals:
  //   attention (red dot, "wants you NOW") = any pane rang BEL since you
  //     last interacted. Purely runtime.
  //   unread (bold name, "done, unreviewed") = the tab was manually marked
  //     unread, OR any pane is unread (an agent finished a turn there while
  //     you weren't looking). DB-persisted.
  // Panes whose runtime isn't running (lazy-spawn, no client) contribute
  // false to attention/busy; their persisted `unread` still counts.
  // decorateTab is the ONE place this composition lives (mirroring
  // decoratePane) — every tab.updated / tab.added emitter routes through it
  // too, so the list and the live events can't describe a tab differently.
  const manualUnreadIds = tabs.unreadIdsByWorkspace(workspaceId);
  // One cron query per workspace (see cronsByTab) — the sidebar polls this
  // route every 5s, so a per-row lookup would be the hottest query in the app.
  const cronIds = cronsByTab(db, workspaceId);
  // And one clock read for the whole list, for the same reason — plus one of
  // its own: a child chat's clock is its PARENT's, so resolving a row needs
  // rows the workspace-scoped read above may not contain.
  // (`/all` builds it once and passes it down — the index is global, so
  //  rebuilding it per workspace there would be the same scan N times.)
  const clocks = shared ?? clockSnapshot(db);
  // …and one panes read for the whole workspace, which was the last per-row
  // query here: `decorateTab` needs a tab's panes for its status, attention
  // and subagent rollups, and it was fetching them one tab at a time — 657
  // round trips per `GET /api/tabs/all`, on a route polled every five seconds
  // per device. It is the only cost on this path that grows with the number
  // of CHATS, which is the number that grows forever.
  const panesByTab = new PaneStore(db).byTabForWorkspace(workspaceId);
  const decorated = raw
    .map((t) => decorateTab(cache, db, t, manualUnreadIds, cronIds, clocks, panesByTab))
    .map((t) => (opts?.omitReportText ? stripReportText(t) : t));
  // STORE ORDER, pinned block first. `listByWorkspace` already reads
  // `ORDER BY position, created_at, id`, which is the manual order a drag
  // writes and the place a new chat is appended to — so this adds nothing to
  // it but the pinned/unpinned split the sidebar's divider needs. The unpinned
  // block used to be re-sorted here by attention then recency; see
  // shared/tab-order for why it is not.
  return sortSidebarTabs(decorated);
}

/**
 * THE SAME ROW WITHOUT ITS REPORT'S PROSE.
 *
 * `spawn_report` is a finished worker's whole summary, and it was 56.5% of
 * this list — 479 KB of a 1.19 MB answer, measured on 1,136 rows — on a route
 * the sidebar re-polls 250ms after EVERY `pane.updated` edge, to each of 98
 * open connections, while forty agents make those edges continuously. The
 * server's main thread was spending its time turning those rows into JS
 * objects and then into JSON, and chat opens queued behind it.
 *
 * NOBODY ON THIS ROUTE READS IT. It feeds the sidebar rows, the mobile list,
 * the workspace layout and TabView — a name, a state, a clock. The surface
 * that DOES render report prose is the spawn card, and its corpus comes from
 * `/api/tabs/all` (web/src/lib/use-all-chats → chat-mention), which keeps the
 * text. So this is a narrowing of the hot route, not a feature change.
 *
 * `spawn_report_state` and `spawn_report_at` STAY. They are a word and a
 * number, they are what says a report exists at all, and a row that lost them
 * would be a row that claims a finished worker produced nothing.
 */
function stripReportText(t: Tab): Tab {
  if (!t.spawn_report) return t;
  const { spawn_report: _dropped, ...rest } = t;
  return rest as Tab;
}
