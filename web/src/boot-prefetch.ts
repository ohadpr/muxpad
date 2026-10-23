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
  }
}

/** Past this, a prefetched list is older than anything the app should be
 *  rendering from. The 5s polls have run; let them own it. */
export const STALE_AFTER_MS = 10_000;

const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
let usedWorkspaces = false;
let usedTabs = false;

/** Let the payload go once nobody can ask for it again: it is a resolved
 *  promise holding a few hundred KB of parsed JSON, and the page lives for
 *  days. */
function releaseIfSpent(): void {
  if (usedWorkspaces && usedTabs && typeof window !== 'undefined') window.__muxpadBoot = undefined;
}

function expired(): boolean {
  return typeof performance !== 'undefined' && performance.now() - startedAt > STALE_AFTER_MS;
}

async function payload(): Promise<BootPayload | null> {
  if (typeof window === 'undefined' || !window.__muxpadBoot || expired()) return null;
  try {
    const got = await window.__muxpadBoot;
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
  if (usedWorkspaces) return null;
  usedWorkspaces = true;
  const got = await payload();
  releaseIfSpent();
  return got?.workspaces?.length ? got.workspaces : null;
}

/** The prefetched tab list for ONE workspace, once. Null for any other
 *  workspace — a list from elsewhere is not a cheaper version of this one. */
export async function bootTabs(workspaceId: string): Promise<Tab[] | null> {
  if (usedTabs) return null;
  const got = await payload();
  if (!got || got.workspaceId !== workspaceId) return null;
  usedTabs = true;
  releaseIfSpent();
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
