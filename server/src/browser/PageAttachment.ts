/**
 * Noticing that the page underneath us has been swapped.
 *
 * The host attaches a CDP session to one page target at startup and keeps it
 * forever. Chrome does not guarantee that target survives: navigating away from
 * `chrome://newtab` — which is where every browser starts, so this is the FIRST
 * navigation of every session — can move the page into a new target, and an
 * agent that opens a tab and closes the original moves it too.
 *
 * When that happens the session is not an error. It is silently attached to
 * something that no longer exists: input goes nowhere, the screencast refuses
 * with "Not attached to an active page", and the viewer is black for good.
 * Caught in the wild, with a real page loaded and the host holding a session for
 * a target that had gone.
 *
 * It is also invisible from outside — /healthz probes the BROWSER endpoint,
 * which is perfectly healthy. Hence this: the host re-checks what it is holding,
 * and the health check is answered on the page session so a blind host reports
 * as broken instead of fine.
 */

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** A DevTools window is a page target too; streaming the debugger is not useful. */
function isRealPage(t: TargetInfo): boolean {
  return t.type === 'page' && !t.url.startsWith('devtools://');
}

/**
 * Whether the session should be re-attached, and to what.
 *
 * Returns the target to attach to, or null to keep what we have.
 *
 * NEVER re-attaches when the current target is still there. Re-attaching
 * needlessly drops the screencast and every enabled domain for a blink, which
 * on a page somebody is typing into is worse than the problem.
 *
 * And a browser with NO page at all returns null rather than throwing: that is
 * the instant between one page closing and the next opening, and tearing the
 * session down for it would turn a blink into a fault.
 */
export function targetToAttach(
  currentTargetId: string | null,
  targets: readonly TargetInfo[],
): TargetInfo | null {
  const pages = targets.filter(isRealPage);
  if (currentTargetId && pages.some((t) => t.targetId === currentTargetId)) return null;
  return pages[0] ?? null;
}
