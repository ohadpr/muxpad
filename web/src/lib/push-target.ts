/**
 * The client half of "tapping a notification lands on the pane that raised it".
 *
 * A tap has to survive three very different situations, and the app used to
 * only really handle the first:
 *
 *   1. COLD  — the PWA isn't running. The tap opens the payload URL, whose
 *              `?ptab=&pane=` params are read at boot (main.tsx).
 *   2. WARM  — the PWA is running. The service worker postMessages the target
 *              here and we route through the SPA router, preserving every
 *              terminal and socket in the window.
 *   3. OPAQUE — the platform brings the app forward and tells us NOTHING.
 *              Exactly what an installed iOS PWA does: no
 *              `WindowClient.navigate()`, and `clients.openWindow()` on an app
 *              that already has a window merely focuses it. The service worker
 *              therefore also deposits the target in Cache Storage, and we
 *              drain that on boot and on every visibility/focus change.
 *
 * Everything here is pure or dependency-injected so all three paths are
 * testable without a browser (see push-target.test.ts).
 */

export interface PushTarget {
  /** Identity of one TAP. Applied at most once — see `alreadyApplied`. */
  id: string;
  /** SPA path, e.g. `/w/dev/t/abc123?ptab=<tabId>&pane=<paneId>`. */
  url: string;
  tab_id: string | null;
  pane_id: string | null;
  /** When the tap happened, ms epoch. */
  ts: number;
}

/**
 * How stale a CACHED target may be and still be applied.
 *
 * The cached target is a dead-drop with no delivery receipt: if the app never
 * comes forward, it just sits there. Applying a two-hour-old one on the next
 * launch would teleport the user somewhere they've long stopped caring about,
 * so anything past this window is dropped on read. Two minutes comfortably
 * covers "tap → iOS foregrounds the PWA → React mounts", which is seconds.
 */
export const PUSH_TARGET_TTL_MS = 120_000;

export const PUSH_CACHE = 'muxpad-push-v1';
export const TARGET_CACHE_URL = '/__muxpad/push-target';

/** Validate an untrusted target (SW message payload / cache entry). */
export function parsePushTarget(raw: unknown): PushTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.url !== 'string' || !o.url) return null;
  const ts = typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : 0;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `${o.url}:${ts}`,
    url: o.url,
    tab_id: typeof o.tab_id === 'string' && o.tab_id ? o.tab_id : null,
    pane_id: typeof o.pane_id === 'string' && o.pane_id ? o.pane_id : null,
    ts,
  };
}

/** Is a cached target still worth honouring? */
export function isFresh(t: PushTarget, now = Date.now()): boolean {
  // ts 0 means "the sender didn't say" — trust it rather than drop the tap.
  if (!t.ts) return true;
  return now - t.ts < PUSH_TARGET_TTL_MS && now - t.ts > -PUSH_TARGET_TTL_MS;
}

/**
 * The workspace/tab a deep-link URL points at.
 *
 * Slugs are percent-decoded: the server encodes them into the payload URL, and
 * the router wants the decoded form (it re-encodes when building the path).
 */
export function routeFromDeepLink(url: string): { wsSlug: string; tabSlug: string } | null {
  const m = url.match(/^\/w\/([^/?#]+)\/t\/([^/?#]+)/);
  if (!m?.[1] || !m[2]) return null;
  try {
    return { wsSlug: decodeURIComponent(m[1]), tabSlug: decodeURIComponent(m[2]) };
  } catch {
    return { wsSlug: m[1], tabSlug: m[2] };
  }
}

/**
 * Ids already routed, so two channels delivering the SAME tap (the SW's
 * postMessage plus the cached dead-drop it always writes) route once. Bounded:
 * a tap id is never revisited, and the app is not a long-lived id sink.
 */
const applied = new Set<string>();
const APPLIED_MAX = 50;

export function alreadyApplied(id: string): boolean {
  return applied.has(id);
}

function markApplied(id: string): void {
  applied.add(id);
  if (applied.size > APPLIED_MAX) {
    const first = applied.values().next();
    if (!first.done) applied.delete(first.value);
  }
}

function unmarkApplied(id: string): void {
  applied.delete(id);
}

/** Test seam — reset the applied-once memory between cases. */
export function resetAppliedPushTargets(): void {
  applied.clear();
}

export interface PushTargetDeps {
  /** Route the SPA to the owning tab, carrying `?pane` for a fresh mount. */
  navigateToTab: (route: { wsSlug: string; tabSlug: string; paneId: string | null }) => void;
  /** Fallback for a payload URL that isn't a workspace/tab deep link. */
  navigateToPath: (path: string) => void;
  /** Persist "this tab was last on that pane" (survives a reload). */
  rememberPane: (tabId: string, paneId: string) => void;
  /** Deterministic once-only focus, consumed by the owning TabView. */
  forceFocusPane: (tabId: string, paneId: string) => void;
  /** Flip an ALREADY-mounted TabView's active pane. */
  showPane: (paneId: string) => void;
  /** Injectable setTimeout. */
  schedule: (fn: () => void, ms: number) => void;
}

/** How many times to re-broadcast show-pane, and how far apart. */
const SHOW_PANE_TRIES = 8;
const SHOW_PANE_INTERVAL_MS = 110;
const SHOW_PANE_DELAY_MS = 60;

/**
 * Apply a tap: route to the owning tab and point it at the pane, through every
 * channel that can win, because which one does depends on whether the target
 * TabView exists yet.
 *
 *   - `rememberPane` seeds a TabView that mounts LATER (cross-workspace deep
 *     links load their tab list asynchronously).
 *   - `forceFocusPane` is the deterministic once-only store consumed on
 *     mount/activate — the backstop for the event below firing too early.
 *   - `showPane` flips a tab that is ALREADY mounted with a different active
 *     pane, which ignores the `?pane` URL seed by design.
 *
 * Returns false when the tap was already applied (deduped).
 */
export function applyPushTarget(target: PushTarget, deps: PushTargetDeps): boolean {
  if (alreadyApplied(target.id)) return false;
  // Marked BEFORE the body so a second channel arriving mid-apply is deduped;
  // rolled back on a throw, because a tap that blew up was not applied and the
  // caller (main.tsx) must be free to let the service worker escalate to a
  // real navigation instead of acking a tap that went nowhere.
  markApplied(target.id);
  try {
    if (target.tab_id && target.pane_id) {
      deps.rememberPane(target.tab_id, target.pane_id);
      deps.forceFocusPane(target.tab_id, target.pane_id);
    }

    const route = routeFromDeepLink(target.url);
    if (route) {
      deps.navigateToTab({ ...route, paneId: target.pane_id });
    } else {
      deps.navigateToPath(target.url);
    }

    if (target.pane_id) {
      const paneId = target.pane_id;
      let tries = 0;
      const fire = () => {
        deps.showPane(paneId);
        if (++tries < SHOW_PANE_TRIES) deps.schedule(fire, SHOW_PANE_INTERVAL_MS);
      };
      deps.schedule(fire, SHOW_PANE_DELAY_MS);
    }
  } catch (err) {
    unmarkApplied(target.id);
    throw err;
  }
  return true;
}

/**
 * The one door every tap goes through, with a HOLDING AREA in front of it.
 *
 * A tap can arrive before the app can act on it. The service worker's
 * dead-drop is drained at module scope — before `createRoot().render()` has
 * run, so before the router has committed a location — and `applyPushTarget`
 * at that moment routes into a router that isn't listening yet. The tap is
 * then simply gone: the app foregrounds on whatever it was showing, which is
 * the exact complaint this whole path exists to fix.
 *
 * So: queue until `ready()`, then apply. And when several taps queue up, apply
 * only the NEWEST — two navigations in a row means the first one was never
 * seen, and the user tapped the second one because that's the one they care
 * about. The losers are marked applied so the other delivery channel can't
 * resurrect them a moment later.
 */
export type PushDelivery =
  /** Routed. */
  | 'applied'
  /** Accepted but not routed yet — the router isn't mounted. */
  | 'held'
  /** Already routed through the other channel. */
  | 'duplicate';

export interface PushTargetSink {
  /** Route now, or hold it until ready(). Throws only if applying throws. */
  deliver: (target: PushTarget) => PushDelivery;
  /** The app can route. Flushes anything held. Idempotent. */
  ready: () => void;
  /** Test seam: is a tap waiting? */
  held: () => PushTarget | null;
}

export function createPushTargetSink(deps: PushTargetDeps): PushTargetSink {
  let open = false;
  let queued: PushTarget | null = null;
  return {
    deliver(target) {
      if (open) return applyPushTarget(target, deps) ? 'applied' : 'duplicate';
      if (alreadyApplied(target.id)) return 'duplicate';
      if (queued && queued.id !== target.id) {
        // Superseded. Burn its id so the dead-drop / postMessage twin of the
        // same tap can't apply it after the newer one has landed.
        markApplied(queued.id);
      }
      queued = target;
      return 'held';
    },
    ready() {
      open = true;
      const t = queued;
      queued = null;
      if (t) applyPushTarget(t, deps);
    },
    held: () => queued,
  };
}

/**
 * Read (and clear) the service worker's dead-drop.
 *
 * Cleared on READ, not on successful apply: an entry we've seen has done its
 * job, and leaving it behind is how a tap from ten minutes ago yanks the user
 * off whatever they navigated to since.
 */
export async function takeStoredPushTarget(now = Date.now()): Promise<PushTarget | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(PUSH_CACHE);
    const hit = await cache.match(TARGET_CACHE_URL);
    if (!hit) return null;
    await cache.delete(TARGET_CACHE_URL);
    const parsed = parsePushTarget(await hit.json());
    if (!parsed || !isFresh(parsed, now)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the dead-drop without reading it (the message channel got there first). */
export async function clearStoredPushTarget(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    await (await caches.open(PUSH_CACHE)).delete(TARGET_CACHE_URL);
  } catch {
    // best effort — a stale entry is TTL-guarded and applied-once anyway
  }
}
