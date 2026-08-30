import type { PaneStatus } from '@muxpad/shared';
import './StatusMark.css';

/**
 * The status rail's one mark.
 *
 * Rendered in a FIXED 16px column that sits at the same x on every row —
 * workspace, tab and pane alike — so a vertical scan down the navigator
 * answers "what's running?" without reading a single word. That column is the
 * point: the old spinner sat immediately after an ellipsizable name
 * (`flex: 0 1 auto`), so its x differed on every row and there was no line to
 * scan.
 *
 * One mark per row, never two — the five states are mutually exclusive by
 * construction (see PaneStatus), so precedence is resolved on the server and
 * this component simply draws what it is told. The column stays RESERVED when a
 * row is idle so nothing shifts as state changes under the cursor.
 *
 * Colour rule, stated once and enforced here:
 *   --accent   the MACHINE is working
 *   --danger   it WANTS YOU
 *   --fg-dim   done / quiet
 * The three never share a hue, so "working" and "wants you" can't be confused
 * at a glance — which is exactly what happened when both were accent.
 */
export function StatusMark({
  status,
  agents = 0,
  className,
}: {
  status: PaneStatus | undefined;
  /** Live background subagents. A NUMBER, not a state — rendered as a badge. */
  agents?: number | undefined;
  className?: string | undefined;
}) {
  const s = status ?? 'idle';
  // `working` is aria-hidden: it toggles fast, and announcing it would churn
  // the enclosing link's accessible name ("Home working" → "Home" → …) at
  // whatever rate the agent starts and stops. The STABLE, consequential states
  // get a real label — `blocked` above all, since "this one wants you now" is
  // precisely the thing a screen-reader user must not have to hunt for. (The
  // .badge-dot this replaced carried aria-label at every site; dropping it
  // entirely would have made the whole rail silent.)
  const announced = s === 'blocked' || s === 'dead' || s === 'done';
  return (
    <span
      className={`navtree-status${className ? ` ${className}` : ''}`}
      data-status={s}
      {...(announced
        ? { role: 'img' as const, 'aria-label': TITLES[s] }
        : { 'aria-hidden': 'true' as const })}
      title={TITLES[s]}
    >
      {s === 'working' && agents > 0 ? (
        // The subagent count rides to the LEFT of the ring, outside the fixed
        // column, so the ring itself never leaves the scan line.
        <span className="navtree-status-agents">{agents > 9 ? '9+' : agents}</span>
      ) : null}
      {s === 'blocked' ? <span className="navtree-status-dot" /> : null}
      {s === 'working' ? (
        <>
          <svg
            className="navtree-status-ring"
            width="13"
            height="13"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="2.5"
              fill="none"
              opacity="0.15"
            />
            <path
              d="M8 2 a6 6 0 0 1 6 6"
              stroke="currentColor"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
          {/* Reduced-motion substitute: a 2px accent bar that SLIDES. Never an
              opacity fade — dimming the only indicator you have is the one
              thing a reduced-motion fallback must not do. */}
          <span className="navtree-status-bar" />
        </>
      ) : null}
      {s === 'done' ? (
        <svg
          className="navtree-status-done"
          width="6"
          height="6"
          viewBox="0 0 6 6"
          aria-hidden="true"
        >
          <circle cx="3" cy="3" r="2.1" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      ) : null}
      {s === 'dead' ? (
        <svg
          className="navtree-status-dead"
          width="9"
          height="9"
          viewBox="0 0 10 10"
          aria-hidden="true"
        >
          <path
            d="M2 2 L8 8 M8 2 L2 8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
      {/* idle renders nothing — the column stays reserved. */}
    </span>
  );
}

const TITLES: Record<PaneStatus, string | undefined> = {
  blocked: 'Waiting on you',
  working: 'Working…',
  done: 'Finished — unread',
  dead: 'Agent exited',
  idle: undefined,
};
