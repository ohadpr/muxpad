import type { Tab, Workspace } from '@muxpad/shared';
import { api } from '../api';
import { applyTabUnread, refreshTabs } from '../tabs';
import { refreshWorkspaces } from '../workspaces';
import { setTabUnread as setTabUnreadAction } from './tab-unread';

/**
 * Everything a chat row can DO, for one workspace — archive, delete, unread,
 * icon, pin.
 *
 * Extracted from `TabList` when a SECOND list started rendering the same rows:
 * the flat cross-workspace 'recent' view (lib/flat-chats). Every one of these
 * is a write plus a specific set of refreshes, and getting the refresh set
 * wrong is invisible until a count chip goes stale — which is exactly the
 * shape of bug this file exists to make impossible. `TabStore.delete` has the
 * comment for it: "Three hand-written copies of the same rule is how two of
 * them end up disagreeing."
 *
 * A plain factory rather than a hook, deliberately. The flat list needs one
 * bundle PER ROW (its rows come from different workspaces), and a hook cannot
 * be called in a loop.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * Merge, add-pane and move-pane-here. All three are drop targets, all three
 * need the dragged payload, and the flat list has no drag: pinned reordering is
 * a per-workspace MANUAL order that does not exist across workspaces (see
 * flat-chats), so there is no gesture for a drop to mean there. They stay in
 * `TabList`, where a drag can actually start.
 */
export interface TabRowActions {
  archive: (tab: Tab) => Promise<void>;
  remove: (tab: Tab) => Promise<void>;
  setUnread: (tab: Tab, want: boolean) => void;
  setIcon: (tab: Tab, icon: string) => Promise<void>;
  setPinned: (tab: Tab, pinned: boolean) => Promise<void>;
}

export function tabRowActions(workspace: Workspace | { id: string }): TabRowActions {
  const refresh = async () => {
    await refreshTabs(workspace.id);
    // The workspace rollups (tab_count chips, the collapsed row's state mark)
    // are derived from its tabs, so anything that changes the set has to
    // refresh both or the chip outlives the change.
    await refreshWorkspaces();
  };

  return {
    /**
     * ARCHIVE — the row's one-click action, and the manual path to exactly
     * where decay leads. Nothing is deleted: the chat drops into the done group
     * with its transcript intact, stays findable by `@`, and a message revives
     * it.
     *
     * No confirm, and that is the point of the change rather than an oversight.
     * The × used to DELETE, which is precisely why it was never used — a
     * one-click irreversible action on a row you are only tidying is one you
     * learn not to touch, so the rail filled up instead.
     */
    archive: async (tab) => {
      try {
        await api.archiveTab(tab.id);
        await refresh();
      } catch (err) {
        console.error('archiveTab failed', err);
        window.alert(`Failed to archive chat: ${String(err)}`);
      }
    },

    /**
     * DELETE — permanent, and reachable only from the context menu.
     *
     * It keeps its confirm BECAUSE it is now the rare path: the common action
     * (archive) is one click and reversible, so the destructive one can afford
     * to ask. window.confirm is flaky in the iOS PWA, so the guard is the
     * menu's own depth plus this prompt on desktop.
     */
    remove: async (tab) => {
      if (!window.confirm(`Delete “${tab.name}” permanently? This cannot be undone.`)) return;
      try {
        await api.deleteTab(tab.id);
        await refresh();
      } catch (err) {
        console.error('deleteTab failed', err);
        window.alert(`Failed to delete chat: ${String(err)}`);
      }
    },

    /**
     * Manual unread toggle — the context menu (right-click / long-press) and
     * the sheet's swipe tray. `want=true` flags the attention dot; `want=false`
     * clears it (the same path as viewing the tab).
     *
     * The body lives in lib/tab-unread so those surfaces cannot drift: it
     * patches the cached row FIRST (so the bold name and the `ready` dot land
     * on the tap's own frame instead of after the round trip, and long before
     * the 5s poll), then writes, then refetches to reconcile. A failed write
     * rolls the patch back.
     *
     * The failure path stays console-only, matching every other write here. It
     * is the one place the optimistic patch costs something: a write that fails
     * now shows the mark and then silently takes it away. Judged the smaller
     * evil than a bespoke toast for the least consequential write in the app —
     * the mark is a reminder, not data, and the row it rolls back to is the
     * truthful one.
     */
    setUnread: (tab, want) => {
      void setTabUnreadAction(
        {
          markUnread: api.markTabUnread,
          markSeen: api.markTabSeen,
          patch: applyTabUnread,
          refresh,
        },
        tab.id,
        want,
      ).catch((err: unknown) => {
        console.error('set tab unread failed', err);
      });
    },

    setIcon: async (tab, icon) => {
      try {
        await api.patchTab(tab.id, { icon });
        await refreshTabs(workspace.id);
      } catch (err) {
        console.error('set tab icon failed', err);
      }
    },

    /**
     * Pin / unpin. Optimistic only in the sense that we refetch immediately —
     * the server may also MOVE the tab (a newly-pinned tab goes to the end of
     * the pinned block), so a local guess would flicker against the truth.
     */
    setPinned: async (tab, pinned) => {
      try {
        await api.patchTab(tab.id, { pinned });
        await refreshTabs(workspace.id);
      } catch (err) {
        console.error('pin tab failed', err);
      }
    },
  };
}
