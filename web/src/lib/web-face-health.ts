import type { LivenessReason, UrlLiveness } from './face-switch';

/**
 * The web face's health loop, as a pure step function.
 *
 * ShellPaneBody polls {@link probeUrlLive} and feeds each result through here;
 * this decides three things the component then just obeys — whether to show
 * the "not responding" notice, whether to remount the iframe, and when to
 * probe next. Pure so all three are testable without a DOM.
 *
 * Two behaviours live here that the old inline `setWebDead(!ok)` didn't have:
 *
 * 1. DEBOUNCE. One failed probe is a blip — a server mid-restart, a slow first
 *    byte, a proxy 502ing for the two seconds vite takes to bind. Replacing
 *    the app with an error card on that is worse than showing nothing. Two
 *    consecutive failures is a story; at the 3s dead cadence the notice
 *    appears within a few seconds of a genuine outage.
 *
 * 2. RECOVERY RELOAD. The iframe is keyed by URL, so it does NOT reload when
 *    the backend comes back — the URL never changed. Behind a proxy that is
 *    exactly the trap: tailscale serve returned a 502 error page, the iframe
 *    cached it, and the app coming back leaves that stale page on screen
 *    forever. So an observed dead → alive transition demands a remount, and
 *    it fires on the RAW probe result, not on the notice: the common case is a
 *    single dead probe (never shown) whose 502 page is nonetheless stuck in
 *    the iframe.
 */

/** How many consecutive dead probes before we replace the app with a notice. */
const DEAD_STREAK_TO_SHOW = 2;
/** Dead → probe often, recovery should feel immediate. */
export const DEAD_RECHECK_MS = 3000;
/** Alive → occasional re-check catches a server that dies while you watch. */
export const ALIVE_RECHECK_MS = 15000;

export interface WebFaceHealth {
  /** Consecutive failed probes. */
  deadStreak: number;
  /**
   * Result of the previous probe. Starts TRUE: the face mounts optimistically
   * (the iframe is already there), so a first probe that comes back alive is
   * not a "recovery" and must not remount a perfectly good page.
   */
  lastAlive: boolean;
}

export const initialWebFaceHealth: WebFaceHealth = { deadStreak: 0, lastAlive: true };

export interface WebFaceHealthStep {
  state: WebFaceHealth;
  /** Reason to show in the notice, or null to show the app. */
  deadReason: LivenessReason | null;
  /** Status behind that reason, when the server probe read one. */
  deadStatus: number | null;
  /** Remount the iframe — the backend came back under an unchanged URL. */
  reload: boolean;
  /** Delay before the next probe. */
  nextDelayMs: number;
}

export function stepWebFaceHealth(prev: WebFaceHealth, result: UrlLiveness): WebFaceHealthStep {
  if (result.alive) {
    return {
      state: { deadStreak: 0, lastAlive: true },
      deadReason: null,
      deadStatus: null,
      // Recovery, not first sight: only a transition earns a remount.
      reload: !prev.lastAlive,
      nextDelayMs: ALIVE_RECHECK_MS,
    };
  }
  const deadStreak = prev.deadStreak + 1;
  const show = deadStreak >= DEAD_STREAK_TO_SHOW;
  return {
    state: { deadStreak, lastAlive: false },
    deadReason: show ? result.reason : null,
    deadStatus: show ? result.status : null,
    reload: false,
    nextDelayMs: DEAD_RECHECK_MS,
  };
}

/**
 * What to tell the user. Named separately from the component so the wording
 * for each failure mode is reviewable in one place — and so "the proxy is up
 * but the app isn't" stops being reported as "nothing is responding", which
 * sent people looking for a server that was, in fact, listening.
 */
export function webDeadBadge(reason: LivenessReason): string {
  // The face menu has room for two words, so it gets the distinction that
  // matters most: a proxy with nothing behind it is a DIFFERENT problem from
  // nothing listening, and the fix is different too (restart the app, not the
  // tunnel). The full sentence is in the item's tooltip.
  if (reason === 'gateway') return 'no backend';
  if (reason === 'timeout') return 'not answering';
  return 'offline';
}

export function webDeadMessage(reason: LivenessReason, status: number | null, url: string): string {
  if (reason === 'gateway') {
    return `${url} is being proxied, but nothing is running behind it${
      status ? ` (${status})` : ''
    } — the app server may have stopped.`;
  }
  if (reason === 'timeout') {
    return `${url} accepted the connection but didn’t answer in time — the app server may be wedged.`;
  }
  return `Nothing is responding at ${url} — the server may have stopped.`;
}
