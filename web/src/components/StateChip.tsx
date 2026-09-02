import type { PaneStatus } from '@muxpad/shared';
import './StateChip.css';

/**
 * The navigator row's state encoding — the RIGHT-HAND half of it.
 *
 * State is told three times over, and each telling has a different job:
 *
 *   1. a 3px BAR on the row's left edge      — the vertical scan line
 *   2. a very faint TINT across the row      — the peripheral signal
 *   3. this CHIP on the right                — the word, read on demand
 *
 * (1) and (2) are pure CSS, keyed off `data-state` on the row itself — see
 * NavTree.css. They are the channel you read without looking: the bar gives
 * every row's state one fixed x to scan, and the wash is what catches the eye
 * from the far side of a monitor. This component is the third telling, and the
 * only one that says which state in words.
 *
 * It replaced a drawn 18px mark in a fixed 22px column. That mark put colour,
 * shape and motion at the row's RIGHT edge — the end of a scan, not its start —
 * and charged every idle row 30px of width for a column that drew nothing.
 * Moving the always-on channel to the left edge put the scan line where a scan
 * begins; the width is a trade rather than a saving (see StateChip.css for the
 * per-state numbers — idle rows gain 30px, worded ones spend more than the
 * column ever cost).
 *
 *   working  a turning ring, NO word — a spinner needs no label, and this is
 *            the one state that is transient by definition
 *   blocked  the word YOU — "blocked" describes the agent; YOU is the thing
 *            it is blocked ON, which is what you actually need to know
 *   ready    the word READY
 *   dead     the word FAILED, in grey and deliberately NOT red: red in this
 *            rail means "you are needed", and a dead runner needs nothing
 *            until you decide it does
 *   idle     nothing at all — a genuinely childless span, so the cell is
 *            `:empty`, has no width, declines its gutter (`:not(:empty)` in
 *            the CSS), and hands the room to the name
 *
 * ─── The one moving thing ────────────────────────────────────────────────
 * ONLY `working` animates. Not ready, not blocked, not the selected row,
 * nothing else in the rail. That is a load-bearing invariant, not a
 * preference: it means anything moving always means the same thing, and — the
 * half that actually gets used — a STILL rail means nothing is running. A
 * second animation anywhere in this tree destroys both halves at once.
 *
 * ─── Reduced motion ──────────────────────────────────────────────────────
 * The spinner degrades into the LABELLED variant: the word WORKING in the same
 * chip as the other three. Both are always in the DOM and the media query in
 * StateChip.css picks one, so there is no second source of truth and no
 * matchMedia to keep in sync. Never a static ring or a fainter mark — a
 * motionless spinner is indistinguishable from a decoration, and dimming the
 * one indicator a user has makes the row they most need the quietest thing on
 * screen.
 *
 * ─── Accessibility ───────────────────────────────────────────────────────
 * Colour is never the only channel: three states carry a word, and `working`
 * carries a shape and motion (and a word under reduced motion). For a screen
 * reader every non-idle row also gets visually-hidden text, `working`
 * included.
 *
 * That text is why every render site puts this component OUTSIDE the row's
 * link or button, never inside it: hidden text inside a control joins the
 * control's ACCESSIBLE NAME, so the name would change under the user every
 * time an agent started or stopped ("Main" → "Main, Working" → "Main"). As a
 * sibling it is still read when the row is read, and the control keeps one
 * stable name. The pane rows got this wrong once — see NavTree.tsx.
 */
export function StateChip({
  status,
  className,
}: {
  status: PaneStatus | undefined;
  className?: string | undefined;
}) {
  const s = status ?? 'idle';
  if (s === 'idle' || !(s in WORDS)) {
    // Empty, not absent: the cell stays in the grid (so nothing re-flows into
    // its track) but measures zero and declines its gutter.
    return <span className={cls(className)} data-state="idle" />;
  }
  return (
    <span className={cls(className)} data-state={s}>
      {s === 'working' ? (
        <>
          <span className="navtree-state-spin" aria-hidden="true" />
          {/* The reduced-motion substitute. Present always; the media query
              decides which of the two is displayed. */}
          <span className="navtree-state-word -motion-sub" aria-hidden="true">
            {WORDS.working}
          </span>
        </>
      ) : (
        <span className="navtree-state-word" aria-hidden="true">
          {WORDS[s]}
        </span>
      )}
      <span className="navtree-state-sr">{ANNOUNCED[s]}</span>
    </span>
  );
}

function cls(extra: string | undefined): string {
  return `navtree-state${extra ? ` ${extra}` : ''}`;
}

/** The visible word. `working`'s is shown only under prefers-reduced-motion. */
const WORDS: Record<Exclude<PaneStatus, 'idle'>, string> = {
  blocked: 'YOU',
  working: 'WORKING',
  ready: 'READY',
  dead: 'FAILED',
};

/** What a screen reader hears — the full phrase, not the chip's shorthand. */
const ANNOUNCED: Record<Exclude<PaneStatus, 'idle'>, string> = {
  blocked: 'Waiting on you',
  working: 'Working',
  ready: 'Ready for you',
  dead: 'Agent exited',
};
