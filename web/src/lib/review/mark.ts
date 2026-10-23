// DRAWING THE THING YOU WERE POINTING AT.
//
// A screenshot of a 1440p window, scaled to 1280px and JPEG'd at q0.7, is a
// picture in which the mouse pointer is about eleven pixels tall. It IS there —
// `cursor: 'always'` was the first thing the spike proved — but "this one" is
// carried by a detail the reader has to hunt for, in an image a model reads at
// whatever resolution it feels like.
//
// So the frame gets two marks:
//
//   · A RING around the pointer. Says "here", at a size that survives any
//     downscale a reader applies.
//   · A ZOOM INSET of the ~300px around it, in the corner furthest from the
//     pointer. This is the part that does the real work: it is a legible
//     close-up of the button/label/row being discussed, so the reader does not
//     need the full-resolution frame to tell WHICH button.
//
// This is also the honest answer to "can you give me markup tools?" — no, not
// once you have switched to another application (§8 of the plan). The OS
// cursor, hover and text selection are the vocabulary; this is how we amplify
// it.
//
// Placement is pure and tested; the drawing is a dozen canvas calls.

export interface Point {
  x: number;
  y: number;
}

/** Radius of the ring, as a fraction of the frame's smaller side. */
export const RING_FRACTION = 0.028;

/** The inset's side, as a fraction of the frame's width. */
export const INSET_FRACTION = 0.26;

/** How much of the original the inset shows, as a fraction of frame width.
 *  0.17 of a 1280px frame is ~220px — a button and its neighbours. */
export const ZOOM_SOURCE_FRACTION = 0.17;

export interface InsetPlacement {
  /** Where to draw the inset, in frame pixels. */
  dest: { x: number; y: number; w: number; h: number };
  /** What to copy out of the frame, in frame pixels. Clamped to the frame, so
   *  a cursor in a corner still produces a full box rather than a stretched
   *  sliver. */
  src: { x: number; y: number; w: number; h: number };
}

/**
 * Where the close-up goes, and what it shows.
 *
 * THE INSET MUST NOT COVER THE SUBJECT, which is the only hard rule here: an
 * annotation that hides the thing it annotates is worse than no annotation. So
 * the destination is the corner diagonally opposite the pointer, chosen per
 * frame — bottom-right for a cursor in the top-left, and so on.
 */
export function placeInset(
  w: number,
  h: number,
  cursor: Point,
  opts: { insetFraction?: number; zoomFraction?: number; margin?: number } = {},
): InsetPlacement {
  const side = Math.round(w * (opts.insetFraction ?? INSET_FRACTION));
  const margin = opts.margin ?? Math.round(w * 0.015);
  const left = cursor.x > 0.5;
  const top = cursor.y > 0.5;
  const dest = {
    x: left ? margin : w - side - margin,
    y: top ? margin : h - side - margin,
    w: side,
    h: side,
  };

  const srcSide = Math.round(w * (opts.zoomFraction ?? ZOOM_SOURCE_FRACTION));
  const cx = cursor.x * w;
  const cy = cursor.y * h;
  const src = {
    x: Math.max(0, Math.min(w - srcSide, Math.round(cx - srcSide / 2))),
    y: Math.max(0, Math.min(h - srcSide, Math.round(cy - srcSide / 2))),
    w: Math.min(srcSide, w),
    h: Math.min(srcSide, h),
  };
  return { dest, src };
}

/** Where the ring goes, in frame pixels. */
export function placeRing(
  w: number,
  h: number,
  cursor: Point,
): { x: number; y: number; r: number } {
  return {
    x: Math.round(cursor.x * w),
    y: Math.round(cursor.y * h),
    r: Math.round(Math.min(w, h) * RING_FRACTION),
  };
}

type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'arc'
  | 'stroke'
  | 'strokeRect'
  | 'fillRect'
  | 'drawImage'
  | 'setLineDash'
> & {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  imageSmoothingEnabled: boolean;
};

/** The mark colour. Chosen to be absent from almost every UI — a review of a
 *  mostly-blue app must not have its ring read as part of the app. */
export const MARK_COLOR = '#ff3b8d';

/**
 * Ring the pointer and draw the close-up. The frame itself must already be on
 * the context — this only adds marks.
 */
export function drawMark(
  ctx: Ctx,
  image: CanvasImageSource,
  w: number,
  h: number,
  cursor: Point | null,
) {
  if (!cursor) return;
  const ring = placeRing(w, h, cursor);
  const { dest, src } = placeInset(w, h, cursor);

  ctx.save();
  // A double ring — dark under, colour over — so it reads on a light UI and on
  // a dark one without knowing which this is.
  ctx.lineWidth = Math.max(5, Math.round(ring.r * 0.4));
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = Math.max(3, Math.round(ring.r * 0.22));
  ctx.strokeStyle = MARK_COLOR;
  ctx.beginPath();
  ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
  ctx.stroke();

  // The inset, on its own plate so it cannot be mistaken for the app.
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(dest.x - 4, dest.y - 4, dest.w + 8, dest.h + 8);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, src.x, src.y, src.w, src.h, dest.x, dest.y, dest.w, dest.h);
  ctx.lineWidth = 3;
  ctx.strokeStyle = MARK_COLOR;
  ctx.strokeRect(dest.x, dest.y, dest.w, dest.h);
  // And a small ring inside the close-up, at the same relative spot, so the
  // reader can tell what in the close-up was being pointed at.
  const ix = dest.x + ((cursor.x * w - src.x) / src.w) * dest.w;
  const iy = dest.y + ((cursor.y * h - src.y) / src.h) * dest.h;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(ix, iy, Math.max(6, dest.w * 0.05), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
