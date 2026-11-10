import type { Tab, Workspace } from '@muxpad/shared';
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

/** What the strip is holding right now. For tests, and for any caller that
 *  wants the band without subscribing to it. */
export function cachedWorkingSet(): WorkingRow[] {
  return cache;
}

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

/**
 * ── THE ROW IS A SNAPSHOT, AND IT HAS TO KEEP UP ────────────────────────────
 *
 * The server announces only SHAPE changes — a chat entering or leaving the
 * band — which is right: a push per message would be a churn feed. But the
 * slot carries the whole `Tab`, including its rolled-up `status`, and that
 * went stale the moment the set stopped changing. A chat that was working
 * when it entered the band kept a spinner in Recently Active for hours after
 * it finished, beside its own sidebar row showing idle. Same truth, two
 * clocks — the second time this exact shape has been fixed in this app (see
 * the corpus note in tabs.ts).
 *
 * So the strip listens for the push that everything else already acts on and
 * patches the row it holds. No fetch, no new event, and the SET is still
 * owned by the server: this only ever replaces a tab the strip is already
 * showing, never adds or reorders one.
 */
subscribe((e) => {
  /**
   * ── AND A CHAT THAT NO LONGER EXISTS HAS TO GO ────────────────────────
   *
   * This listener handled `tab.updated` and returned on everything else, so
   * a DELETED chat kept its slot: the row sat in Recently Active with the
   * name and status it had when it died, and clicking it opened nothing.
   *
   * It is also the whole reason "delete doesn't work, only archive works"
   * was a reasonable thing to believe. Archive emits `tab.updated` — the
   * patch below runs, the row visibly becomes done, the action looks like it
   * landed. Delete emits `tab.removed` and NOTHING here listened, so the one
   * action that really did destroy the chat was the one that appeared to do
   * nothing. The two actions differed on screen by exactly the event this
   * function ignored.
   *
   * Dropping a row is the one shape change the strip may make on its own.
   * The SET is still the server's: this never adds a chat and never reorders
   * one, it only stops drawing something that is gone — and the server's
   * next `working_set.changed` refills the slot.
   */
  if (e.type === 'tab.removed') {
    const without = cache.filter((s) => s.tab.id !== e.tab_id);
    if (without.length !== cache.length) publish(without);
    return;
  }
  if (e.type !== 'tab.updated') return;
  const i = cache.findIndex((s) => s.tab.id === e.tab.id);
  if (i === -1) return;
  const held = cache[i];
  if (!held) return;
  // Identity check on the fields a row actually draws, so an event that
  // changed nothing visible does not re-render six rows.
  const before = `${held.tab.status ?? ''}|${held.tab.agents ?? 0}|${held.tab.unread ?? false}|${held.tab.name}`;
  const after = `${e.tab.status ?? ''}|${e.tab.agents ?? 0}|${e.tab.unread ?? false}|${e.tab.name}`;
  if (before === after) return;
  const next = [...cache];
  // `at` is the strip's own ordering key and belongs to the SET, not to the
  // tab — taking it from the event would let a push reorder the band.
  next[i] = { ...held, tab: e.tab };
  publish(next);
});

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
  // ── NOT PRUNED HERE ANY MORE ──────────────────────────────────────────
  // This filtered stale slots out on every render, "because decay is a
  // function of the clock and nothing pushes when a slot goes stale". True,
  // and the consequence was that a slot aging out REMOVED a tab and every tab
  // after it slid along — which as a tab bar is the one move that is never
  // allowed, and was reported as exactly that.
  //
  // Decay decides who gets REPLACED now, not who is shown (see `isStale` in
  // shared/working-set). A stale slot keeps its place until a new chat takes
  // it, so nothing moves on a clock and the strip you come back to still
  // loses its stale slots — to something, rather than to time passing.
  return slots;
}
