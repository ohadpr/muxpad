import type { Workspace } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Hook returning the list of top-level workspaces — INCLUDING hidden system
 * workspaces (fetched with ?all=1) so a slug lookup still resolves if one is
 * reached by a direct URL. User-facing enumerations (the nav tree, redirects,
 * move-to targets) must go through visibleWorkspaces().
 *
 * Backed by a module-level cache so the chrome switcher and any other
 * consumers all see the same data. Refreshes on mount, visibility, focus,
 * on a BroadcastChannel ping from another same-browser tab, and on a 5s
 * poll while the tab is visible.
 *
 * The poll is what surfaces per-workspace attention rollups (used by the
 * favicon and the switcher trigger badge) when a background workspace
 * fires BEL — without it, a browser tab parked on Workspace A wouldn't
 * learn that Workspace B has activity until A loses/regains focus.
 * Cross-device sync still piggybacks on the same channel.
 * Components that mutate workspaces should call refreshWorkspaces()
 * directly after the mutation succeeds.
 */
const VISIBLE_POLL_MS = 5000;
let cache: Workspace[] = [];
const listeners = new Set<(w: Workspace[]) => void>();
let version = 0;

// Same-origin tabs share this channel. A successful refresh broadcasts a
// 'refreshed' tick; peers respond by re-fetching (without rebroadcasting,
// so there's no ping-pong loop). BroadcastChannel doesn't deliver to the
// sending tab, which is what we want.
const CHANNEL_NAME = 'muxpad:workspaces';
const channel: BroadcastChannel | null =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

export async function refreshWorkspaces(opts?: { broadcast?: boolean }): Promise<Workspace[]> {
  const shouldBroadcast = opts?.broadcast !== false;
  const myVersion = ++version;
  const next = await api.listWorkspaces({ all: true });
  if (myVersion < version) return next;
  cache = next;
  for (const fn of listeners) fn(cache);
  if (shouldBroadcast) channel?.postMessage({ type: 'refreshed' });
  return next;
}

/** The workspaces user-facing UI may enumerate — hidden system workspaces
 *  are excluded; they're reachable only via a direct URL. */
export function visibleWorkspaces(all: Workspace[]): Workspace[] {
  return all.filter((w) => !w.hidden);
}

/**
 * Optimistically reorder the cached workspaces so the sidebar moves the row
 * immediately, before the reorder round-trip. Bumps `version` so an in-flight
 * poll-refresh (with the old order) is discarded rather than clobbering this;
 * the caller's own refreshWorkspaces() afterwards reconciles with server truth.
 * `ids` covers the VISIBLE set only (the sidebar can't drag what it can't
 * see); hidden workspaces keep their relative order after it. No-op if `ids`
 * doesn't exactly cover the current visible set.
 */
export function applyWorkspaceOrder(ids: string[]): void {
  const byId = new Map(cache.map((w) => [w.id, w]));
  const picked = ids.map((id) => byId.get(id)).filter((w): w is Workspace => w !== undefined);
  if (picked.length !== ids.length) return; // unknown id — stale drag
  const idSet = new Set(ids);
  const rest = cache.filter((w) => !idSet.has(w.id));
  if (rest.some((w) => !w.hidden)) return; // ids didn't cover the visible set
  version++;
  cache = [...picked, ...rest];
  for (const fn of listeners) fn(cache);
}

/**
 * ONE poll for the whole document, not one per subscriber.
 *
 * The timer, the focus/visibility handlers and the BroadcastChannel handler
 * used to be installed inside `useWorkspaces`'s effect, so they scaled with
 * MOUNTED COMPONENTS: every sidebar TabRow has a `useWorkspaces()`, and so does
 * every visited (permanently mounted) TabView. Fifty sidebar rows plus twenty
 * visited tabs meant ~70 full `GET /api/workspaces?all=1` every five seconds,
 * and a burst of ~70 on every focus and every cross-tab broadcast. Each of
 * those synchronously walks workspaces → tabs → panes through better-sqlite3,
 * so ordinary use could stall the server's event loop. The module cache
 * de-duplicated the RESULT but never the REQUEST.
 *
 * Now the subscriber count only decides whether the single shared driver is
 * running: first subscriber arms it, last one tears it down.
 */
let driverRefs = 0;
let pollTimer: number | null = null;

/**
 * Mount-time refresh, shared across every component mounting in the same tick.
 * Deliberately NOT applied to the exported `refreshWorkspaces`: callers use
 * that right after a mutation and must not be handed a reply from a request
 * that was already in flight before their write landed.
 */
let inFlightMount: Promise<Workspace[]> | null = null;
function refreshOnMount(): void {
  if (inFlightMount) return;
  inFlightMount = refreshWorkspaces().finally(() => {
    inFlightMount = null;
  });
  inFlightMount.catch(() => {
    // a failed refresh just leaves the cache as it was; the poll retries
  });
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => void refreshWorkspaces(), VISIBLE_POLL_MS);
}
function stopPolling(): void {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}
const onVisible = () => {
  if (document.visibilityState === 'visible') {
    void refreshWorkspaces();
    startPolling();
  } else {
    stopPolling();
  }
};
const onFocus = () => void refreshWorkspaces();
const onChannel = (e: MessageEvent) => {
  // Receiver refreshes silently — broadcast: false — so we don't loop.
  if (e.data?.type === 'refreshed') void refreshWorkspaces({ broadcast: false });
};

function acquireDriver(): void {
  driverRefs += 1;
  if (driverRefs > 1) return;
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onFocus);
  channel?.addEventListener('message', onChannel);
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') startPolling();
}

function releaseDriver(): void {
  driverRefs -= 1;
  if (driverRefs > 0) return;
  driverRefs = 0;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onFocus);
  channel?.removeEventListener('message', onChannel);
  stopPolling();
}

export function useWorkspaces(): {
  workspaces: Workspace[];
  refresh: () => Promise<Workspace[]>;
} {
  const [state, setState] = useState<Workspace[]>(cache);
  useEffect(() => {
    listeners.add(setState);
    // Mount-time refresh is also coalesced: N components mounting in the same
    // tick share one in-flight request.
    refreshOnMount();
    acquireDriver();
    return () => {
      listeners.delete(setState);
      releaseDriver();
    };
  }, []);
  return { workspaces: state, refresh: refreshWorkspaces };
}
