import type { Tab, Workspace } from '@muxpad/shared';

/**
 * THE ANSWER THAT ARRIVED BEFORE THE APP DID.
 *
 * `index.html` carries a short inline script that fires
 * `GET /api/boot?w=<slug>` at about 10ms — while the bundle is still
 * downloading — and parks the promise on `window.__muxpadBoot`. This module is
 * the other end: the two stores that would otherwise open those round trips
 * themselves ask here first.
 *
 * ─── What it is worth, measured ───────────────────────────────────────────
 *
 * Cold load, 4× CPU throttle (a rough stand-in for a phone), loopback:
 *
 *    70–112  the bundle arrives
 *   227      the app's FIRST request leaves      ← parse + mount
 *   262      /api/workspaces?all=1
 *   327      /api/tabs?workspaceId=…             ← waits for the id above
 *
 * Both now leave at ~10ms, in ONE request, overlapped with the download and
 * the parse instead of queued behind them. On a tailnet link it also removes a
 * round trip, because the second request no longer has to learn the workspace
 * id from the first.
 *
 * ─── The rules that keep it safe ──────────────────────────────────────────
 *
 * 1. EACH HALF IS USED ONCE. A prefetch is by definition the oldest answer in
 *    the building; handing it to a second reader later — after a write, a
 *    push, a poll — would be a visible rollback.
 * 2. NEVER ACROSS WORKSPACES. The payload states which workspace its `tabs`
 *    belong to, and a reader asking about a different one gets nothing.
 * 3. IT EXPIRES. Past STALE_AFTER_MS the app has been running long enough that
 *    anything this old is a liability, not a saving.
 * 4. EVERY FAILURE IS SILENT AND MEANS "fetch it yourself". A missing global,
 *    a rejected promise, an old server answering 404 — all identical, and all
 *    land on the path that existed before this did.
 */

export interface BootPayload {
  workspaces: Workspace[];
  workspaceId: string | null;
  tabs: Tab[];
}

declare global {
  interface Window {
    /** Set by the inline script in index.html. Explicitly `| undefined`
     *  because a reader clears it by assignment, and this project compiles
     *  with `exactOptionalPropertyTypes`. */
    __muxpadBoot?: Promise<BootPayload | null> | undefined;
    /** `performance.now()` at the moment the inline script ASKED. Set by the
     *  same script — the module's own import time is far too late to measure
     *  age from on a slow bundle download. */
    __muxpadBootAt?: number | undefined;
  }
}

/** Past this, a prefetched list is older than anything the app should be
 *  rendering from. The 5s polls have run; let them own it. */
export const STALE_AFTER_MS = 10_000;

/**
 * How long a reader will WAIT for the prefetch before going to the server
 * itself. Separate from staleness, and just as necessary: a reader that
 * entered while the request was in flight used to await it with no bound at
 * all, so a boot request that hung took the first render with it. Observed in
 * review as a read resolving at sixty seconds and still adopting.
 */
export const WAIT_BUDGET_MS = 1500;

/**
 * When the REQUEST was made, not when this module was imported.
 *
 * A slow bundle download sits between the two, and that is exactly the case
 * where the difference decides whether the answer is still fresh. The inline
 * script stamps it; the fallback is only for a page that somehow has the
 * promise without the stamp.
 */
function askedAt(): number {
  if (typeof window !== 'undefined' && typeof window.__muxpadBootAt === 'number')
    return window.__muxpadBootAt;
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

let usedWorkspaces = false;
let usedTabs = false;

/** Let the payload go once nobody can ask for it again: it is a resolved
 *  promise holding a few hundred KB of parsed JSON, and the page lives for
 *  days. */
function releaseIfSpent(): void {
  if (usedWorkspaces && usedTabs && typeof window !== 'undefined') window.__muxpadBoot = undefined;
}

function expired(): boolean {
  return typeof performance !== 'undefined' && performance.now() - askedAt() > STALE_AFTER_MS;
}

async function payload(): Promise<BootPayload | null> {
  if (typeof window === 'undefined' || !window.__muxpadBoot || expired()) return null;
  try {
    // BOUNDED. Whatever is wrong with a request that has not answered in a
    // second and a half, waiting longer for it is not the fix — and the
    // ordinary path is sitting right there.
    const got = await Promise.race([
      window.__muxpadBoot,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_BUDGET_MS)),
    ]);
    // Re-checked AFTER the await: this is where the time went, so this is
    // where the answer can have gone stale.
    if (expired()) return null;
    return got && Array.isArray(got.workspaces) ? got : null;
  } catch {
    return null;
  }
}

/** Is a prefetch still worth waiting for? Readers ask BEFORE opening their own
 *  request — the answer may be in flight rather than in hand. */
export function bootPending(part: 'workspaces' | 'tabs'): boolean {
  if (typeof window === 'undefined' || !window.__muxpadBoot || expired()) return false;
  return part === 'workspaces' ? !usedWorkspaces : !usedTabs;
}

/** The prefetched workspace list, once. */
export async function bootWorkspaces(): Promise<Workspace[] | null> {
  // Reserved before the await, for the reason spelled out on `bootTabs`.
  if (usedWorkspaces) return null;
  usedWorkspaces = true;
  const got = await payload();
  releaseIfSpent();
  return got?.workspaces?.length ? got.workspaces : null;
}

/**
 * The prefetched tab list for ONE workspace, once.
 *
 * RESERVED BEFORE THE AWAIT, and that ordering is the whole of a bug found in
 * review: the flag used to be set after, so two refreshes that both started
 * while the request was in flight both passed the check and both got the same
 * old snapshot — and the SECOND one, carrying the newest version number,
 * landed it. The version guard cannot help, because by then the stale bytes
 * are indistinguishable from a fresh answer.
 *
 * A caller that reserves and then finds the payload is for another workspace
 * has spent it. That is the right way round: it means the one request this
 * saves is never saved twice, and the loser fetches.
 */
export async function bootTabs(workspaceId: string): Promise<Tab[] | null> {
  if (usedTabs) return null;
  usedTabs = true;
  const got = await payload();
  releaseIfSpent();
  if (!got || got.workspaceId !== workspaceId) return null;
  return got.tabs;
}

/** Forget the prefetch entirely — for a reader that has been overtaken by a
 *  real answer and must not let a later one adopt something older. */
export function dropBoot(): void {
  usedWorkspaces = true;
  usedTabs = true;
  releaseIfSpent();
}

/** Tests only: put the module back to its pre-boot state. */
export function resetBootPrefetchForTests(): void {
  usedWorkspaces = false;
  usedTabs = false;
}
