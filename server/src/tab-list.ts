import type { Tab } from '@muxpad/shared';
import { CHAT_DECAY_MS, sortSidebarTabs } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { type PtydCache, cronsByTab, decorateTab } from './ptyd-cache.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { type ClockSnapshot, clockSnapshot } from './tab-clock.js';

/**
 * One workspace's navigation rows, including its historical done group.
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
  /** Full reports belong to parent-scoped spawn-round reads. */
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
  // The live corpus below uses a selected snapshot instead; this path also
  // serves the workspace tree's historical done group.
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

/** Full report prose is loaded only for one parent's children, never globally. */
function stripReportText(t: Tab): Tab {
  if (!t.spawn_report) return t;
  const { spawn_report: _dropped, ...rest } = t;
  return rest as Tab;
}

/** Decorate a selected set without a whole-history clock or pane snapshot. */
export function decorateSelectedTabs(
  db: Database.Database,
  cache: PtydCache,
  rows: Tab[],
  now = Date.now(),
): Tab[] {
  const store = new TabStore(db);
  const ids = rows.map((t) => t.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const children = db
    .prepare(`
    SELECT id FROM tabs INDEXED BY tabs_corpus_children
      WHERE spawned_by IS NOT NULL AND spawned_by IN (${placeholders}) AND retired_at IS NULL
    UNION SELECT id FROM tabs INDEXED BY tabs_corpus_pinned
      WHERE pinned = 1 AND spawned_by IN (${placeholders})`)
    .all(...ids, ...ids) as { id: string }[];
  const ownClocks = store.clockRowsFor([...new Set([...ids, ...children.map((c) => c.id)])]);
  const parentIds = [...new Set(ownClocks.flatMap((r) => (r.spawned_by ? [r.spawned_by] : [])))];
  const index = new Map([...store.clockRowsFor(parentIds), ...ownClocks].map((r) => [r.id, r]));
  const childrenOf = new Map<string, string[]>();
  for (const r of ownClocks) {
    if (!r.spawned_by) continue;
    const list = childrenOf.get(r.spawned_by) ?? [];
    list.push(r.id);
    childrenOf.set(r.spawned_by, list);
  }
  const clocks: ClockSnapshot = { now, index, childrenOf };
  const panesByTab = new PaneStore(db).byTabs([...index.keys()]);
  const manualUnread = new Set(
    (db.prepare('SELECT id FROM tabs WHERE unread = 1').all() as { id: string }[]).map((r) => r.id),
  );
  const crons = cronsByTab(db);
  return sortSidebarTabs(
    rows.map((t) =>
      stripReportText(decorateTab(cache, db, t, manualUnread, crons, clocks, panesByTab)),
    ),
  );
}

/** The hot corpus carries live work only. Retirement alone cannot decide it:
 * an automatically retired worker may still own an unparked running pane. */
export function liveCorpusTabs(db: Database.Database, cache: PtydCache, now = Date.now()): Tab[] {
  const candidates = new TabStore(db).corpusCandidates(now - CHAT_DECAY_MS, cache.livePaneIds());
  return decorateSelectedTabs(db, cache, candidates, now).filter((t) => t.corpus_live);
}
