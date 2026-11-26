import type { Tab, Workspace } from '@muxpad/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
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
 * WHICH CHAT THE UNREAD LIST HOLDS OPEN A PLACE FOR — pure, because the rule
 * is the whole subtlety and it is otherwise buried in a ref.
 *
 * `withActiveRow` exists so that clicking an unread row does not make it
 * vanish from under the click: opening it reads it, and the inbox drops it.
 * But it was implemented as "always show the chat you are on", which is a
 * much bigger claim — so arriving at Unread from anywhere else put a chat in
 * the list that had nothing unread in it. "When standing on a chat and
 * clicking 'unread' it always shows that same chat as well, weird."
 *
 * The narrower rule is the one that was meant: a chat keeps its place only if
 * it was unread AT SOME POINT WHILE IT WAS THE CHAT YOU ARE ON. So the row
 * you just clicked stays; a chat you were already in when you opened Unread
 * does not appear. Moving to another chat forgets it, so this holds one id
 * rather than growing with everything ever read.
 *
 * @param held  what the previous call kept (null = nothing)
 * @param activeTabId  the chat being looked at now
 * @param unreadNow  whether the inbox currently lists that chat
 */
export function stickyUnreadRow(
  held: string | null,
  activeTabId: string | null,
  unreadNow: boolean,
): string | null {
  if (!activeTabId) return null;
  if (unreadNow) return activeTabId;
  return held === activeTabId ? activeTabId : null;
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
  // The one chat the list is holding a place for — see stickyUnreadRow. A ref
  // rather than state: it is derived from what is already being rendered and
  // must not cause a render of its own.
  const held = useRef<string | null>(null);
  const activeTabId = activeTab?.id ?? null;
  held.current = stickyUnreadRow(
    held.current,
    activeTabId,
    corpus.some((c) => c.tabId === activeTabId),
  );
  const kept = held.current;
  const rows = useMemo(() => {
    const active =
      ws && activeTab && kept === activeTab.id
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
  }, [corpus, ws, activeTab, tabs, visible, kept]);
  // `activeTabId` still marks the row when it IS listed — that is the rail's
  // "you are here" mark, which is a different question from whether the list
  // holds a place for it.
  return { rows, activeTabId, corpus };
}
