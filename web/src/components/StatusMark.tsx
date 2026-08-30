import type { PaneStatus } from '@muxpad/shared';
import './StatusMark.css';

/**
 * The status rail's one mark.
 *
 * ONE FAMILY, four drawn marks. Every one is an 18px box on a 2.2px stroke,
 * optically centred inside a FIXED 22px column that sits at the same x on
 * every row — workspace, tab and pane alike — so a vertical scan down the
 * navigator answers "what's running?" without reading a single word.
 *
 * The primary distinction is FILLED vs RING, not colour: red `blocked` and
 * green `ready` are the classic colour-blindness pair, so they are separated
 * by MOTION instead — blocked breathes slowly, ready is perfectly still.
 * Blocked is the only mark in the whole rail that moves while at rest, which
 * is defensible precisely because it is the only state that means "act now".
 * Colour then reinforces what shape and motion already said.
 *
 *   blocked  filled circle, r=5.5, red   — breathing (2s)
 *   working  ring r=6.5 + a 90° arc      — rotating (0.85s)
 *   ready    filled circle, r=5.5, green — still
 *   dead     ✕, round caps, grey         — still, and the only mark that
 *                                          breaks the circle, because it is
 *                                          the only terminal state
 *   idle     nothing drawn; the column stays RESERVED so no row ever shifts
 *
 * One mark per row, never two — the five states are mutually exclusive by
 * construction (see PaneStatus), so precedence is resolved on the server and
 * this component simply draws what it is told.
 *
 * Colour rule, stated once and enforced in StatusMark.css against the
 * `--status-*` tokens (which are re-stepped for light surfaces, not reused
 * from dark):
 *   --status-blocked   it WANTS YOU
 *   --status-working   the MACHINE is working
 *   --status-ready     finished, waiting for you
 *   --status-quiet     over, or the ring's track
 *
 * NOTE there is deliberately no subagent count here any more. It rode to the
 * left of the ring as an absolutely-positioned chip, which is exactly the kind
 * of out-of-grid element that made the rail unscannable; the count lives on
 * the pane/chat surface, where there is room to say what those agents ARE.
 */
export function StatusMark({
  status,
  className,
}: {
  status: PaneStatus | undefined;
  className?: string | undefined;
}) {
  const s = status ?? 'idle';
  // `working` is aria-hidden: it toggles fast, and announcing it would churn
  // the enclosing link's accessible name ("Home working" → "Home" → …) at
  // whatever rate the agent starts and stops. The STABLE, consequential states
  // get a real label — `blocked` above all, since "this one wants you now" is
  // precisely the thing a screen-reader user must not have to hunt for.
  const announced = s === 'blocked' || s === 'dead' || s === 'ready';
  return (
    <span
      className={`navtree-status${className ? ` ${className}` : ''}`}
      data-status={s}
      {...(announced
        ? { role: 'img' as const, 'aria-label': TITLES[s] }
        : { 'aria-hidden': 'true' as const })}
      title={TITLES[s]}
    >
      {s === 'blocked' ? (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="navtree-status-breath" cx="9" cy="9" r="5.5" fill="currentColor" />
        </svg>
      ) : null}
      {s === 'working' ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          strokeWidth="2.2"
          aria-hidden="true"
        >
          {/* Faint track so the arc reads as ROTATION rather than a tick
              floating in space. Same r as the arc, by construction. */}
          <circle className="navtree-status-track" cx="9" cy="9" r="6.5" />
          <path
            className="navtree-status-arc"
            d="M9 2.5 a6.5 6.5 0 0 1 6.5 6.5"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
      {s === 'ready' ? (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="5.5" fill="currentColor" />
        </svg>
      ) : null}
      {s === 'dead' ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4.5 4.5 L13.5 13.5 M13.5 4.5 L4.5 13.5" stroke="currentColor" />
        </svg>
      ) : null}
      {/* idle renders nothing — the column stays reserved. */}
    </span>
  );
}

const TITLES: Record<PaneStatus, string | undefined> = {
  blocked: 'Waiting on you',
  working: 'Working…',
  ready: 'Ready for you',
  dead: 'Agent exited',
  idle: undefined,
};
