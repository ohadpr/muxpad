import type { Tab, Workspace } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { cachedTabsFor } from '../tabs';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';
import { cachedAllTabs, loadAllTabs, subscribeAllTabs } from './all-tabs';

/**
 * Every visible workspace's tabs, for the navigator's flat 'recent' view.
 *
 * ─── IT NEVER BLOCKS THE OPEN, AND THAT IS THE WHOLE COST QUESTION ───────────
 * `all-tabs.ts` is lazy on purpose — "the user has complained about mobile load
 * time" is written into its header — and a default view that reads it turns one
 * request per time you go looking for something into one per sheet open. So it
 * was measured against the live cockpit rather than assumed, over loopback,
 * five runs each:
 *
 *   GET /api/tabs/all              40.9 KB   5.6–8.8 ms
 *   GET /api/tabs?workspaceId=…    35.6 KB   4.4–5.6 ms   ← already on every open
 *
 * A delta of 5.3 KB and about a millisecond, because the workspace you are in
 * holds most of the corpus anyway (28 of 38 live chats). The reason the lazy
 * rule was written still holds — this is not a reason to fetch it at FIRST
 * PAINT — but paying it when a navigator opens is not the cost that rule was
 * protecting.
 *
 * It is still not paid synchronously. The first render answers from two caches
 * that are already in memory — whatever `/api/tabs/all` last returned, and the
 * per-workspace `useTabs` caches for every workspace already mounted, which
 * always includes the one you are in — so the list is on screen on the opening
 * frame and the fetch only ever fills in the workspaces you have not visited.
 * `loadAllTabs` skips the round trip entirely while its answer is under 4s old,
 * which covers opening and closing the sheet.
 *
 * ─── VISIBLE ONLY ────────────────────────────────────────────────────────────
 * The route returns every workspace including HIDDEN ones (the apps container),
 * and those are excluded here for the reason MobileNavSwitcher already excludes
 * them: the apps container holds long-lived server panes whose pty output makes
 * them read as `working` forever. In a flat global list they would sit at the
 * top of every render, permanently, which is the churn feed in its purest form.
 *
 * The workspace's NAME and SLUG come from the workspace store rather than from
 * the corpus, so a rename shows up on the rows immediately — the store is
 * refreshed by the same pushes and the corpus is not re-fetched for a rename.
 */
export function useAllChats(): { workspace: Workspace; tabs: Tab[] }[] {
  const { workspaces } = useWorkspaces();
  const [corpus, setCorpus] = useState(() => cachedAllTabs());

  useEffect(() => {
    const off = subscribeAllTabs(setCorpus);
    // Ask for one. Coalesced, and a no-op while the cached answer is fresh.
    void loadAllTabs().then((groups) => {
      // An empty answer is real (no workspaces) but must not replace a usable
      // fallback when it came from a failed request — `loadAllTabs` resolves to
      // `cache ?? []` rather than rejecting. Same guard NavSearch uses.
      if (groups.length > 0 || cachedAllTabs()) setCorpus(groups);
    });
    return off;
  }, []);

  const byId = new Map((corpus ?? []).map((g) => [g.id, g.tabs]));
  return visibleWorkspaces(workspaces).map((w) => ({
    workspace: w,
    // The corpus if we have it, else whatever this workspace's own poll has
    // already cached — which for the workspace you are in is always something.
    tabs: byId.get(w.id) ?? cachedTabsFor(w.id),
  }));
}
