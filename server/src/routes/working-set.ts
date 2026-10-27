import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { EventBus } from '../events.js';
import { type PtydCache, decorateTab } from '../ptyd-cache.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { WorkingSet } from '../working-set.js';

/**
 * REST for the working-set strip — see shared/src/working-set.ts for what it
 * is and server/src/working-set.ts for where it lives.
 *
 * Two routes and no POST. Entering the strip is not something a client asks
 * for: it happens because you sent a chat a message, which the server already
 * sees in one place (TabActivity.noteUserMessage). A client that could add a
 * slot would be a second definition of "working on", and the two would drift.
 */
export function workingSetRoutes(deps: {
  db: Database.Database;
  cache: PtydCache;
  events?: EventBus | undefined;
}): Hono {
  const app = new Hono();
  const set = new WorkingSet(deps.db);

  /**
   * Pruned on read — for decay and for rows that no longer exist — so this is
   * always what the strip should render, with no sweep anywhere.
   *
   * IT RETURNS THE ROWS, not just the ids. The client cannot resolve them:
   * tabs are fetched per workspace and only while that workspace is EXPANDED
   * (NavTree's `useTabs`), so a slot pointing into a collapsed workspace would
   * be unrenderable — and a collapsed workspace is exactly the case the strip
   * exists for. Decorated the same way the list path decorates, so the row
   * carries the same status, unread and clock as it does in the tree.
   */
  app.get('/', (c) => {
    const tabs = new TabStore(deps.db);
    const workspaces = new WorkspaceStore(deps.db);
    // The TAB type carries no `workspace_id` — the list path always knows the
    // workspace from the route — so it is read alongside rather than guessed.
    const wsOf = deps.db.prepare('SELECT workspace_id AS w FROM tabs WHERE id = ?');
    const slots = set.list().flatMap((s) => {
      const tab = tabs.getById(s.tabId);
      if (!tab) return [];
      const row = wsOf.get(s.tabId) as { w: string } | undefined;
      const ws = row ? workspaces.getById(row.w) : null;
      if (!ws) return [];
      return [
        {
          at: s.at,
          tab: decorateTab(deps.cache, deps.db, tab),
          workspace: { id: ws.id, slug: ws.slug, name: ws.name },
        },
      ];
    });
    return c.json({ slots });
  });

  // "Not now." Frees the slot and touches nothing else about the chat: it is
  // not archived, not retired, not moved. A destructive action on a
  // convenience strip would make the strip frightening to reach for.
  app.delete('/:tabId', (c) => {
    const changed = set.remove(c.req.param('tabId'));
    if (changed) deps.events?.emit({ type: 'working_set.changed' });
    return c.json({ ok: true, changed });
  });

  return app;
}
