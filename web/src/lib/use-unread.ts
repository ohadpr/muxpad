import type { Tab, Workspace } from '@muxpad/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTabs } from '../tabs';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';
import { railUnreadRows } from './chat-sections';
import { type SearchableTab, type WorkspaceTabs, toSearchableTabs } from './nav-search';
import { cachedUnreadTabs, loadUnreadTabs, subscribeUnreadTabs } from './unread-tabs';

/**
 * React readers of the inbox store (lib/unread-tabs). Unread lists and badges
 * read these; Activity and search stay on the live corpus (use-all-chats).
 */

/** The inbox, subscribed. Every mounted reader shares one request. */
export function useUnreadTabs(): WorkspaceTabs[] | null {
  const [groups, setGroups] = useState(() => cachedUnreadTabs());
  useEffect(() => {
    const off = subscribeUnreadTabs(setGroups);
    void loadUnreadTabs().then(() => {
      const held = cachedUnreadTabs();
      if (held) setGroups(held);
    });
    return off;
  }, []);
  return groups;
}

/**
 * Visible workspaces' unread rows, flattened for chat-sections — workspace
 * order and names from the workspace store (a rename shows at once), rows in
 * the server's stored order.
 */
export function unreadCorpusFor(
  workspaces: readonly Workspace[],
  groups: readonly WorkspaceTabs[] | null,
): SearchableTab[] {
  const byId = new Map((groups ?? []).map((g) => [g.id, g.tabs]));
  return toSearchableTabs(
    workspaces.map((w) => ({ id: w.id, slug: w.slug, name: w.name, tabs: byId.get(w.id) ?? [] })),
  );
}

export function useUnreadCorpus(): SearchableTab[] {
  const { workspaces } = useWorkspaces();
  const groups = useUnreadTabs();
  return useMemo(
    () => unreadCorpusFor(visibleWorkspaces(workspaces), groups),
    [workspaces, groups],
  );
}

/**
 * Put the chat you are ON into the unread rows, where it sorts.
 *
 * Opening an unread chat reads it, and the inbox then drops it — a row
 * vanishing from under the click would punish using the list. So the active
 * row is taken from its own workspace's full list (which holds finished chats
 * too) and placed where the stored order puts it: before the first listed row
 * of that workspace that follows it, else after the workspace's last listed
 * row, else where the workspace itself sorts.
 */
export function withActiveRow(
  rows: readonly SearchableTab[],
  active: SearchableTab | null,
  workspaceTabs: readonly Tab[],
  workspaceOrder: readonly string[],
): SearchableTab[] {
  if (!active) return [...rows];
  if (rows.some((r) => r.tabId === active.tabId)) return [...rows];
  const order = new Map(workspaceTabs.map((t, i) => [t.id, i]));
  const at = order.get(active.tabId) ?? Number.POSITIVE_INFINITY;
  const wsAt = workspaceOrder.indexOf(active.workspaceId);
  let insert = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as SearchableTab;
    if (r.workspaceId === active.workspaceId) {
      if ((order.get(r.tabId) ?? Number.POSITIVE_INFINITY) > at) {
        insert = i;
        break;
      }
      continue;
    }
    if (workspaceOrder.indexOf(r.workspaceId) > wsAt) {
      insert = i;
      break;
    }
  }
  return [...rows.slice(0, insert), active, ...rows.slice(insert)];
}

/**
 * The rail's Unread view rows, with the chat you are on kept in place.
 * Returns the active tab's id too — it is resolved from the workspace's own
 * list, which (unlike the live corpus) still holds a finished chat.
 */
export function useRailUnreadRows(
  activeWorkspaceSlug: string,
  activeTabSlug: string | null,
): { rows: SearchableTab[]; activeTabId: string | null; corpus: SearchableTab[] } {
  const { workspaces } = useWorkspaces();
  const corpus = useUnreadCorpus();
  const visible = useMemo(() => visibleWorkspaces(workspaces), [workspaces]);
  const ws = visible.find((w) => w.slug === activeWorkspaceSlug);
  const { tabs } = useTabs(ws?.id ?? '');
  const activeTab = activeTabSlug ? tabs.find((t) => t.slug === activeTabSlug) : undefined;
  const rows = useMemo(() => {
    const active =
      ws && activeTab
        ? (toSearchableTabs([{ id: ws.id, slug: ws.slug, name: ws.name, tabs: [activeTab] }])[0] ??
          null)
        : null;
    const merged = withActiveRow(
      corpus,
      active,
      tabs,
      visible.map((w) => w.id),
    );
    return railUnreadRows(merged, active?.tabId ?? null);
  }, [corpus, ws, activeTab, tabs, visible]);
  return { rows, activeTabId: activeTab?.id ?? null, corpus };
}
