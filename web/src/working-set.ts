import { type Tab, WORKING_SET_DECAY_MS, type Workspace } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { req } from './api';
import { subscribe, subscribeResync } from './events';

/**
 * THE WORKING-SET STRIP, client side.
 *
 * One shared cache and one shared subscription, like `workspaces.ts` and for
 * the same reason: the strip renders in the rail and the sheet at once, and
 * two components must not mean two sockets' worth of fetches.
 *
 * The server owns the list — entering a slot happens because you sent a chat a
 * message, which only the server sees (TabActivity.noteUserMessage). The
 * client reads it and asks for removals; it never writes a slot.
 */
/**
 * One rendered slot. The server sends the ROW, not just an id: tabs are
 * fetched per workspace and only while that workspace is expanded, so a slot
 * pointing into a collapsed one would be unrenderable — and a collapsed
 * workspace is exactly the case the strip is for.
 */
export interface WorkingRow {
  at: number;
  tab: Tab;
  workspace: { id: string; slug: string; name: string };
}

let cache: WorkingRow[] = [];
const listeners = new Set<(s: WorkingRow[]) => void>();
let inflight: Promise<WorkingRow[]> | null = null;

function publish(next: WorkingRow[]): void {
  cache = next;
  for (const fn of listeners) fn(next);
}

export async function refreshWorkingSet(): Promise<WorkingRow[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = (await req<{ slots?: WorkingRow[] }>('/api/working-set')) ?? {};
      publish(
        (r.slots ?? []).filter(
          (s) => s && typeof s.at === 'number' && s.tab?.id && s.workspace?.slug,
        ),
      );
    } catch {
      // A strip is a convenience. It may never be the reason a rail fails to
      // render, so a failed read leaves the last good answer on screen.
    } finally {
      inflight = null;
    }
    return cache;
  })();
  return inflight;
}

/** "Not now" — free the slot. Optimistic, because the answer is a foregone
 *  conclusion and a row that lingers after you dismissed it reads as broken. */
export async function dropFromWorkingSet(tabId: string): Promise<void> {
  publish(cache.filter((s) => s.tab.id !== tabId));
  try {
    await req(`/api/working-set/${encodeURIComponent(tabId)}`, { method: 'DELETE' });
  } catch {
    void refreshWorkingSet(); // put it back if the server disagreed
  }
}

export function useWorkingSet(): WorkingRow[] {
  const [slots, setSlots] = useState<WorkingRow[]>(cache);
  useEffect(() => {
    listeners.add(setSlots);
    void refreshWorkingSet();
    // The server announces only SHAPE changes (see the event's note), so this
    // fires about ten times a day rather than on every message.
    const off = subscribe((e) => {
      if (e.type === 'working_set.changed') void refreshWorkingSet();
    });
    const offResync = subscribeResync(() => void refreshWorkingSet());
    return () => {
      listeners.delete(setSlots);
      off();
      offResync();
    };
  }, []);
  // Pruned again HERE, on every render, because decay is a function of the
  // clock and nothing pushes when a slot goes stale. Without this, a tab left
  // open overnight shows yesterday's strip until something else happens.
  const now = Date.now();
  return slots.filter((s) => now - s.at <= WORKING_SET_DECAY_MS);
}
