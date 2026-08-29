import type { PaneSpec } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { subscribe, subscribeReconnect } from '../events';

/**
 * Live view of the singleton CEO pane (see server/src/ceo.ts).
 *
 * Resolution is server-side (GET /api/ceo ensures + returns ids AND the
 * workspace/tab slugs that route to it), so every device lands on the same
 * pane. The decorated pane row seeds from GET /api/panes/:id and is kept
 * live by pane.updated events — the same signal source TabRow badges use.
 * The resolved ids are cached at module scope so the sheet's remounting
 * NavTree doesn't refetch /api/ceo per open.
 */

export interface CeoIds {
  pane_id: string;
  tab_id: string;
  workspace_slug: string;
  tab_slug: string;
}

let cachedIds: CeoIds | null = null;
let idsPromise: Promise<CeoIds> | null = null;

export async function resolveCeoIds(): Promise<CeoIds> {
  if (cachedIds) return cachedIds;
  idsPromise ??= api.getCeo().then((ids) => {
    cachedIds = ids;
    return ids;
  });
  try {
    return await idsPromise;
  } catch (err) {
    idsPromise = null; // let a later mount retry
    throw err;
  }
}

/** The CEO's resolved ids + route slugs; null until the first resolve lands.
 *  Used by the pinned sidebar row (to Link into the workspace-tab route and
 *  compute its active state) and the /ceo redirect. */
export function useCeoIds(): CeoIds | null {
  const [ids, setIds] = useState<CeoIds | null>(cachedIds);
  useEffect(() => {
    if (ids) return;
    let alive = true;
    resolveCeoIds()
      .then((v) => {
        if (alive) setIds(v);
      })
      .catch((err) => console.warn('CEO ids resolve failed', err));
    return () => {
      alive = false;
    };
  }, [ids]);
  return ids;
}

export function useCeoPane(): PaneSpec | null {
  const [pane, setPane] = useState<PaneSpec | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const ids = await resolveCeoIds();
        const p = await api.getPane(ids.pane_id);
        if (alive) setPane(p);
      } catch (err) {
        console.warn('CEO pane resolve failed', err);
      }
    };
    void load();
    // Badge liveness: merge pane.updated events for the CEO pane; refetch
    // the baseline on every event-socket reconnect (events aren't replayed).
    const unsubEvents = subscribe((e) => {
      if (e.type === 'pane.updated' && e.pane.id === cachedIds?.pane_id) {
        if (alive) setPane(e.pane);
      }
    });
    const unsubReconnect = subscribeReconnect(() => void load());
    return () => {
      alive = false;
      unsubEvents();
      unsubReconnect();
    };
  }, []);

  return pane;
}
