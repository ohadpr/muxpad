/**
 * ONE GESTURE, ONE MESSAGE.
 *
 * ── WHAT HAPPENED ────────────────────────────────────────────────────────
 * A message typed on the phone reached the agent TWICE: once as a live turn,
 * once from the server's queue the moment that turn ended. The agent answered
 * it, then answered it again — "That message came through a second time" — and
 * the composer showed one sent bubble and one pending one. Reported as "I sent
 * the message and it was sent, but it is also pending so it was like sent
 * twice".
 *
 * The server did nothing wrong: `submitSend` runs a message OR queues it,
 * never both, so two frames arrived. The client fires exactly one frame per
 * `sendMessage` call — so `sendMessage` ran twice.
 *
 * ── WHY IT CANNOT BE A SECOND TAP ────────────────────────────────────────
 * Sending clears the composer, and an empty composer disables the button. A
 * human cannot tap Send twice on the same text: after the first tap there is
 * nothing to send and nothing to tap. The only reachable double is a second
 * click arriving BEFORE React has re-rendered with the cleared draft — the
 * same gesture, counted twice. On iOS that is the ghost click: `touchend`
 * dismisses the keyboard, the viewport reflows, and the synthesized click
 * lands on whatever is now under the finger — which is the same 36px button,
 * because the composer is pinned to the keyboard's edge.
 *
 * ── WHY NOT A TIMEOUT ────────────────────────────────────────────────────
 * Because the window is not a duration, it is a DRAFT. A send consumes the
 * draft; until something is typed again there is nothing legitimate left to
 * send. So the guard remembers the text that just left and refuses an
 * identical one until the composer is edited — which is also what makes
 * sending "yes" twice on purpose still work: you had to type it again.
 *
 * The time cap is a backstop, not the mechanism. It exists so that a missed
 * `release` can never wedge the composer shut.
 */

export const ONE_SEND_CAP_MS = 60_000;

export interface SendGuard {
  /** The text that just left, or null when the composer is the user's own. */
  text: string | null;
  at: number;
}

export const freshGuard = (): SendGuard => ({ text: null, at: 0 });

/** True when `text` is the message the guard just let through — a repeat of
 *  one gesture, not a new message. */
export function isDoubleFire(guard: SendGuard, text: string, now: number): boolean {
  if (guard.text === null) return false;
  if (guard.text !== text) return false;
  return now - guard.at < ONE_SEND_CAP_MS;
}
