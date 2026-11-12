import type { TabWithPanes } from '../api';

/**
 * The detail of a tab this client JUST CREATED, held for the TabView that is
 * about to open it.
 *
 * `POST /api/tabs` already knows the pane it bootstrapped, so it answers with
 * the same `panes` the detail GET would. Without this hand-off, the new chat
 * could not mount until a second request came back — and that request lands
 * in the middle of the refresh storm the create itself sets off (every client's
 * `tab.added` → a workspace list refetch), so it measured 200–330ms on the live
 * install, all of it in front of the composer.
 *
 * TAKEN ONCE, and short-lived: it is a head start for one mount, not a cache.
 * TabView still issues its detail GET and that answer replaces this one, so a
 * pane that changed in the meantime is corrected a moment later rather than
 * missed.
 */
const primed = new Map<string, { detail: TabWithPanes; at: number }>();
const PRIME_TTL_MS = 10_000;

export function primeTabDetail(detail: TabWithPanes): void {
  primed.set(detail.id, { detail, at: Date.now() });
}

export function takePrimedTabDetail(id: string): TabWithPanes | null {
  const hit = primed.get(id);
  primed.delete(id);
  if (!hit || Date.now() - hit.at > PRIME_TTL_MS) return null;
  return hit.detail;
}
