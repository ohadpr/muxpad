import type { WorkingVariant } from '../lib/working-variant';
import './ChatWorking.css';

/**
 * THE WORKING INDICATOR — ten of them, one per turn.
 *
 * Shown before the first token arrives. See `working-variant.ts` for why it
 * rotates rather than being one fixed thing.
 *
 * ── WHAT EVERY ONE OF THESE HAS TO BE ───────────────────────────────────────
 * Small (≤46px, so it does not own a line), legible AT 1× IN A LIGHT THEME —
 * the previous indicator was a 120px moiré field picked after judging it at 3×
 * zoom on dark, where it is lovely, and which aliases into grey hatching at the
 * size and theme it actually ships in — and animated with `transform` and
 * `opacity` only, because several panes can be working at once.
 *
 * ── THE SPRITE-STRIP TRICK ──────────────────────────────────────────────────
 * Most of these are discrete frames rather than continuous motion, which is
 * what makes them read as computery. A strip of N frames laid side by side in a
 * monospace line, windowed to one frame and translated with
 * `animation-timing-function: steps(N)`, gives exact frame-by-frame playback
 * with one element and no JavaScript. `ch` units make the window exact: in a
 * monospace face 1ch IS one glyph, so the window never drifts out of phase with
 * the strip however the font renders.
 */
export function ChatWorking({ variant }: { variant: WorkingVariant }) {
  return (
    <span className={`chat-typing -${variant}`} aria-hidden="true">
      {body(variant)}
    </span>
  );
}

function body(v: WorkingVariant) {
  switch (v) {
    // The canonical CLI spinner, and the densest 8 frames Unicode has: braille
    // is a 2×4 dot matrix per glyph, so this is a tiny bitmap animation made of
    // text that inherits the chat font.
    case 'braille':
      return <s>⣾⣽⣻⢿⡿⣟⣯⣷</s>;
    // The original, from before Unicode.
    case 'ascii':
      return <s>|/-\</s>;
    // Two frames, arms up and arms down — the 1978 sprite, 11×8.
    case 'invader':
      return (
        <svg viewBox="0 0 11 8" width="22" height="16">
          <title>invader</title>
          <g className="f1">{px(INVADER_A)}</g>
          <g className="f2">{px(INVADER_B)}</g>
        </svg>
      );
    // The paddles track the ball because their keyframes are the ball's Y with
    // a lag — there is no logic, just two animations that agree.
    case 'pong':
      return (
        <>
          <u className="p l" />
          <u className="p r" />
          <i className="ball" />
        </>
      );
    // Conway's glider: four generations, after which the pattern is identical
    // but translated one cell diagonally. The CSS does exactly that — steps(4)
    // through the frames, and a slower translate that moves it one cell per
    // cycle, which is the glider's actual period.
    case 'glider':
      return (
        <span className="gwrap">
          <s>▘▗▚▞</s>
        </span>
      );
    // Four segments chasing a pellet round a rounded rectangle, via
    // `offset-path` — the body follows because each segment is the same
    // animation a little behind.
    case 'snake':
      return (
        <>
          <i style={{ animationDelay: '-0.00s' }} />
          <i style={{ animationDelay: '-0.09s' }} />
          <i style={{ animationDelay: '-0.18s' }} />
          <i style={{ animationDelay: '-0.27s' }} />
          <u className="pellet" />
        </>
      );
    // An S-piece falling, locking, and the stack clearing — four frames.
    case 'tetris':
      return <s>▖▞▟█</s>;
    // Three columns at different speeds with a bright leading glyph, masked to
    // fade at the bottom.
    case 'matrix':
      return (
        <>
          <s className="c1">01アイ10ウエ01</s>
          <s className="c2">10オカ01キク10</s>
          <s className="c3">01ケコ10サシ01</s>
        </>
      );
    // EIGHT BITS, COUNTING. Bit n toggles at half the rate of bit n−1, which is
    // what a binary counter IS — so eight `steps(2)` animations with doubling
    // durations produce a real count with no logic at all.
    case 'binary':
      return (
        <>
          {[7, 6, 5, 4, 3, 2, 1, 0].map((b) => (
            <i key={b} className={`b${b}`} />
          ))}
        </>
      );
    // `$ ` and a block cursor, blinking on the hard 1Hz square wave a terminal
    // uses — steps(1), never a fade.
    default:
      return (
        <>
          <s className="ps1">$</s>
          <u className="cur" />
        </>
      );
  }
}

/** A pixel-art sprite as unit rects. */
function px(rows: readonly string[]) {
  const out: React.ReactElement[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      // biome-ignore lint/suspicious/noArrayIndexKey: x and y are the rect's COORDINATES in a fixed sprite grid, not its position in a list that can reorder — the key is the thing itself.
      if (c !== ' ') out.push(<rect key={`${x}:${y}`} x={x} y={y} width="1" height="1" />);
    });
  });
  return out;
}

const INVADER_A = [
  '  X     X  ',
  '   X   X   ',
  '  XXXXXXX  ',
  ' XX XXX XX ',
  'XXXXXXXXXXX',
  'X XXXXXXX X',
  'X X     X X',
  '   XX XX   ',
] as const;

const INVADER_B = [
  '  X     X  ',
  'X  X   X  X',
  'X XXXXXXX X',
  'XXX XXX XXX',
  'XXXXXXXXXXX',
  ' XXXXXXXXX ',
  '  X     X  ',
  ' X       X ',
] as const;
