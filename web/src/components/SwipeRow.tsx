import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  SWIPE_ACTION_WIDTH,
  SWIPE_TRAY_WIDTH,
  type SwipeAxis,
  clampOffset,
  decideAxis,
  settleOpen,
} from '../lib/swipe-axis';
import './SwipeRow.css';

/**
 * A touch row whose actions live UNDER it, revealed by a left swipe.
 *
 * This exists because every permanent per-row control on the mobile sheet was
 * a liability. A × and a ⋯ sat at the row's right edge — the exact strip a
 * thumb crosses on its way down a scrolling list — so the two commonest
 * mis-taps in the whole app were "closed a chat I meant to open" and "opened a
 * menu I meant to scroll past". Making them fainter didn't help; it only made
 * them harder to hit ON PURPOSE while remaining just as easy to hit by
 * accident. A gesture is the fix: a left swipe is deliberate by construction
 * and cannot be produced by a scroll.
 *
 * The three things that make this work rather than merely exist:
 *
 *  1. `touch-action: pan-y` on the shell (CSS). The browser keeps vertical
 *     panning for the scroller and hands us horizontal movement. Without it we
 *     would be racing the scroll recognizer, and on iOS losing — it takes the
 *     touch and we get a `pointercancel`.
 *  2. The axis is decided ONCE, on the first movement past the slop, and then
 *     locked for the gesture (lib/swipe-axis). A per-frame "whichever delta is
 *     bigger" test thrashes on any diagonal drag.
 *  3. Exactly one row is open at a time, enforced by a module-level token
 *     rather than by each row watching the others. Scrolling the list, opening
 *     another row, or touching anything else closes it.
 *
 * Keyboard and pointer users are unaffected: this component is only mounted
 * for the sheet variant, and the desktop sidebar keeps its hover-revealed
 * controls — where pin, mark-unread and close all live in the context menu,
 * which IS the keyboard path.
 *
 * A closed tray is inert on purpose: `aria-hidden` on the tray plus
 * `tabIndex={-1}` on its buttons. Three actions × every row would otherwise be
 * three extra tab stops and three announced buttons per chat, on a surface a
 * keyboard user cannot open in the first place (opening it takes a touch
 * gesture). So the sheet has no AT path to these three, by construction, and
 * the desktop menu is the one that has to keep working.
 */

// ─── "only one open" ────────────────────────────────────────────────────────
// A single mutable token plus a subscriber set: opening a row publishes its
// id, and every other mounted row closes itself. Deliberately module-scope
// rather than context — the nav tree mounts twice (sidebar + sheet) in some
// layouts and "one open row" must hold across both.
let openRowId: string | null = null;
const listeners = new Set<() => void>();

/** How far the list must actually move before a scroll dismisses the tray.
 *  See the scroll effect below for why "any scroll event" is the wrong rule. */
const SCROLL_DISMISS_PX = 6;

function setOpenRow(id: string | null): void {
  if (openRowId === id) return;
  openRowId = id;
  for (const fn of listeners) fn();
}

export interface SwipeRowProps {
  /** Stable id — the "only one open" token. */
  id: string;
  children: ReactNode;
  onPin: () => void;
  /** Toggle the manual unread mark — the same action the desktop context menu
   *  offers, reaching the same route. `true` marks unread, `false` marks read. */
  onSetUnread: (want: boolean) => void;
  onClose: () => void;
  pinned: boolean;
  /** Whether the row currently carries the unread mark (the `ready` state's
   *  persisted flag) — decides which way the middle action toggles. */
  unread: boolean;
  /** For the actions' accessible names ("Close chat Investing"). */
  label: string;
}

export function SwipeRow({
  id,
  children,
  onPin,
  onSetUnread,
  onClose,
  pinned,
  unread,
  label,
}: SwipeRowProps) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Close is destructive and there is no undo, so it takes two taps: the first
  // arms the button ("Sure?"), the second destroys. Deliberately NOT
  // window.confirm — it is unreliable in an iOS PWA in standalone mode (the
  // dialog can be suppressed outright), which is exactly where this row lives.
  const [armed, setArmed] = useState(false);
  const gesture = useRef({ x: 0, y: 0, base: 0, axis: 'undecided' as SwipeAxis, dx: 0 });
  /** The row's outer element — used to find the scroller it actually lives in. */
  const shell = useRef<HTMLDivElement>(null);
  // Set while a horizontal drag is resolving, and read by the click handler to
  // swallow the click the browser fires at the end of a drag. Without it, a
  // swipe that started on the row's link also NAVIGATES on release.
  const swallowClick = useRef(false);

  const isOpen = offset !== 0;

  const close = useCallback(() => {
    setOffset(0);
    setArmed(false);
  }, []);

  // Someone else opened a row (or the list scrolled) — stand down.
  useEffect(() => {
    const onChange = () => {
      if (openRowId !== id) close();
    };
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
      // Unmounting the open row must clear the token, or the next row to open
      // finds a stale id and no one ever closes.
      if (openRowId === id) openRowId = null;
    };
  }, [id, close]);

  // A REAL scroll of the enclosing list closes the tray — but only a real one.
  //
  // The naive version (close on any scroll event) is worse than no rule at
  // all: browsers scroll for reasons the user didn't ask for — bringing a
  // focused element into view, settling momentum, adjusting for the keyboard —
  // and the commonest one is the scroll-into-view a browser performs when you
  // reach for a button. So tapping Close could dismiss the tray a frame before
  // the tap landed, and the tap would fall through to the row underneath and
  // OPEN the chat. That is precisely the mis-tap class this whole affordance
  // exists to remove, reintroduced by its own dismissal rule.
  //
  // So: remember where the scroller was when the tray opened, and close only
  // once it has actually moved. The threshold is a few pixels — under a
  // thumb's own wobble, over the sub-pixel adjustments the browser makes.
  useEffect(() => {
    if (!isOpen) return;
    // THIS row's scroller, resolved by walking up from the row — not the first
    // `.navtree-scroll` in the document. The tree mounts twice (sidebar and
    // sheet), so a document-wide query baselines a sheet row against the
    // sidebar's scrollTop, and then the first scroll event from anywhere
    // exceeds the threshold and closes the tray — reintroducing the bug the
    // threshold was added to fix, plus dismissal from unrelated scrollers
    // (the chat pane behind the sheet).
    const scroller = shell.current?.closest('.navtree-scroll') ?? null;
    const from = scroller?.scrollTop ?? 0;
    const onScroll = (e: Event) => {
      if (scroller && e.target !== scroller) return;
      const el = e.target as HTMLElement | null;
      const top = el && 'scrollTop' in el ? el.scrollTop : 0;
      if (Math.abs(top - from) < SCROLL_DISMISS_PX) return;
      setOpenRow(null);
    };
    // Capture phase, passive: this must never delay or cancel a scroll.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [isOpen]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Mouse and pen never swipe — they have hover, a scroll wheel and a
    // desktop sidebar. Claiming a mouse drag here would break text selection
    // and the row's own drag-to-reorder.
    if (e.pointerType !== 'touch') return;
    gesture.current = { x: e.clientX, y: e.clientY, base: offset, axis: 'undecided', dx: 0 };
    swallowClick.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const g = gesture.current;
    if (g.axis === 'vertical') return; // locked out for the rest of the gesture
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.dx = dx;
    g.axis = decideAxis(dx, dy, g.axis, g.base !== 0);
    if (g.axis !== 'horizontal') return;
    if (!dragging) {
      setDragging(true);
      // Follow the finger even if it leaves the row's box — a swipe that
      // drifts up into the row above should not simply stop tracking.
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Capture is best-effort; the gesture still works without it.
      }
    }
    swallowClick.current = true;
    setOffset(clampOffset(g.base, dx));
  };

  const endGesture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const g = gesture.current;
    setDragging(false);
    if (g.axis !== 'horizontal') return;
    const open = settleOpen(offset, g.dx);
    setOffset(open ? -SWIPE_TRAY_WIDTH : 0);
    if (!open) setArmed(false);
    setOpenRow(open ? id : null);
  };

  return (
    <div
      className="swiperow"
      ref={shell}
      data-open={isOpen ? 'true' : undefined}
      // The action width is arithmetic, not styling: SWIPE_TRAY_WIDTH (which
      // decides how far the row slides, where the latch is, and what the tap
      // targets measure) is derived from it. Publishing it as a custom
      // property is what keeps the CSS from drifting away from the maths —
      // the two used to be the literal 76 written down twice.
      style={{ '--swipe-action-width': `${SWIPE_ACTION_WIDTH}px` } as CSSProperties}
    >
      {/* The tray sits UNDER the row and never moves — the row slides off it.
          Sliding the actions in instead would make them arrive from off-screen
          at a different speed from the finger, which reads as lag. */}
      <div className="swiperow-tray" aria-hidden={isOpen ? undefined : 'true'}>
        <button
          type="button"
          className="swiperow-action -pin"
          tabIndex={isOpen ? 0 : -1}
          onClick={() => {
            onPin();
            setOpenRow(null);
          }}
          aria-label={pinned ? `Unpin ${label}` : `Pin ${label} to the top`}
        >
          <span className="swiperow-action-glyph" aria-hidden="true">
            {pinned ? '📌' : '📍'}
          </span>
          {pinned ? 'Unpin' : 'Pin'}
        </button>
        {/* MIDDLE, between the two that were already here.

            Only ONE of the two existing actions can keep its POSITION when a
            third arrives, because the tray is anchored to the row's right edge
            and everything to the left of the new button shifts. Close is the
            one worth keeping still: measured from that edge it stays the
            0–59 band it has always been, and it is the destructive one — the
            action whose accidental press costs something. Pin keeps only its
            ORDINAL slot (still leftmost); a thumb aimed at where Pin used to
            be now lands on this button. Accepted, because the miss is
            recoverable with one more tap and the swipe is visibly longer than
            it was, which is its own cue that the row has changed.

            It toggles rather than only marking, for the same reason Pin does:
            the tray is a thumb-sized target reached by a gesture, so the undo
            for a mis-tap has to be the button you just hit. Marking a chat
            unread with no way back would leave you hunting for the long-press
            menu to undo a one-tap mistake. */}
        <button
          type="button"
          className="swiperow-action -unread"
          tabIndex={isOpen ? 0 : -1}
          onClick={() => {
            onSetUnread(!unread);
            setOpenRow(null);
          }}
          aria-label={unread ? `Mark ${label} read` : `Mark ${label} unread`}
        >
          {/* The status rail's own vocabulary: a FILLED disc is `ready`
              ("finished, waiting for you"), which is exactly the state this
              button produces, and a hollow one is its absence. Reusing the
              shape means the button names its outcome instead of inventing a
              second glyph for the same idea. */}
          <span className="swiperow-action-glyph" aria-hidden="true">
            {unread ? '○' : '●'}
          </span>
          {unread ? 'Read' : 'Unread'}
        </button>
        <button
          type="button"
          className="swiperow-action -close"
          data-armed={armed ? 'true' : undefined}
          tabIndex={isOpen ? 0 : -1}
          onClick={() => {
            if (!armed) {
              setArmed(true);
              return;
            }
            setOpenRow(null);
            onClose();
          }}
          aria-label={armed ? `Confirm close ${label}` : `Close ${label}`}
        >
          <span className="swiperow-action-glyph" aria-hidden="true">
            {armed ? '⚠' : '✕'}
          </span>
          {armed ? 'Sure?' : 'Close'}
        </button>
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the row's own link owns the keyboard path; this handler only swallows a post-swipe click */}
      <div
        className="swiperow-face"
        data-dragging={dragging ? 'true' : undefined}
        style={{ transform: `translate3d(${offset}px,0,0)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onClickCapture={(e) => {
          // Two cases, both of which must not reach the row's link: the click
          // the browser synthesises at the end of a drag, and a tap on an
          // already-open row (which should just put it away — the standard
          // list idiom, and the escape hatch if you opened one by accident).
          if (swallowClick.current) {
            // The click the browser synthesises at the end of a drag. Swallow
            // it and nothing more — treating it as a tap would slam the tray
            // shut the same frame the swipe opened it.
            e.preventDefault();
            e.stopPropagation();
            swallowClick.current = false;
            return;
          }
          if (isOpen) {
            // A real tap on an already-open row: put it away. The standard
            // list idiom, and the escape hatch if you opened one by accident.
            e.preventDefault();
            e.stopPropagation();
            setOpenRow(null);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
