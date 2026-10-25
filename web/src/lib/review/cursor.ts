// FINDING THE POINTER IN A SCREENSHOT, WITHOUT LOOKING FOR A POINTER.
//
// The cursor is the whole vocabulary of this feature — you say "this one" and
// the pointer is what "this" means. It is IN the pixels (`cursor: 'always'`,
// measured in the spike), which is why no extension is needed. But a frame is
// just a picture: nothing says which 20×20 patch of it is the arrow, and
// template-matching a cursor shape means knowing every shape a platform draws
// (arrow, I-beam, hand, resize, text-select, and the app's own custom ones).
//
// So we don't look for a cursor. We look for the only thing on an otherwise
// still screen that MOVES.
//
// ─── Why three frames and not two ──────────────────────────────────────────
//
// A diff of two consecutive samples lights up TWO places: where the pointer
// was, and where it now is. Nothing in the pixels says which is which, and
// picking the wrong one puts the ring on the thing you just stopped pointing
// at — worse than no ring at all, because it is confidently wrong.
//
// The fix is cheap: the cursor's position in frame N is the one region that is
// in BOTH diffs — changed between N-1 and N (it arrived), and changed between N
// and N+1 (it left). The departure point only lights up in the first diff and
// the arrival point only in the second, so the intersection is exactly N.
//
// ─── When to give up ───────────────────────────────────────────────────────
//
// A scroll, a page navigation, a video playing: most of the screen changes, the
// intersection is enormous, and there is no pointer to be found. That case
// returns null and the frame ships unmarked — correct, and much better than a
// ring drawn around a quarter of the window. `MAX_CHANGED` is where that line
// sits.
//
// All of this runs on the small greyscale maps the hash already computes, so it
// costs one subtract per cell and no extra decode.

/** A cell differing by more than this (0–255) counts as changed. JPEG ringing
 *  on a sharp edge is ±6 at q0.7; text antialiasing is ±10. */
export const DIFF_THRESHOLD = 24;

/** Above this fraction of changed cells the screen itself moved and there is no
 *  pointer to find. A 48×36 map has 1728 cells; a cursor occupies one or two. */
export const MAX_CHANGED = 0.06;

/**
 * How far apart the lit cells may be and still be ONE pointer.
 *
 * At 48 cells across a 1280px frame, one cell is ~27px, so a pointer plus its
 * shadow and the text it uncovers spans two or three. Six is generous for one
 * pointer and far too small for two.
 */
export const MAX_BLOB_CELLS = 6;

export interface GrayMap {
  w: number;
  h: number;
  /** Row-major, one byte per cell. */
  data: Uint8Array | readonly number[];
}

/** Cells that differ between two maps of the same size, as a 0/1 mask. */
export function changedMask(a: GrayMap, b: GrayMap, threshold = DIFF_THRESHOLD): Uint8Array {
  if (a.w !== b.w || a.h !== b.h) return new Uint8Array(0);
  const n = a.w * a.h;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(((a.data[i] as number) ?? 0) - ((b.data[i] as number) ?? 0));
    if (d > threshold) mask[i] = 1;
  }
  return mask;
}

/** The centroid of a mask, normalised to 0..1, or null when the mask is empty
 *  or so large that it is not a pointer. */
export function centroidOf(
  mask: Uint8Array,
  w: number,
  h: number,
  maxChanged = MAX_CHANGED,
): { x: number; y: number } | null {
  let count = 0;
  let sx = 0;
  let sy = 0;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    count++;
    const x = i % w;
    const y = Math.floor(i / w);
    sx += x;
    sy += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (count === 0) return null;
  if (count / (w * h) > maxChanged) return null;
  // ── A CENTROID OF TWO PLACES IS A THIRD PLACE, AND IT IS WRONG ──────────
  //
  // The intersection is "where the pointer was in BOTH diffs", which is one
  // spot — unless the pointer went A → B → A, in which case both diffs hold
  // both spots and their intersection does too. The mean of those two is a
  // point the cursor never occupied: measured in review at x=0.36 for a
  // pointer sitting at x=0.64.
  //
  // A pointer is a few cells across. If the lit cells span much more than
  // that, this is not one pointer and the honest answer is that we do not
  // know. An unmarked frame is always better than a ring on nothing.
  if (maxX - minX > MAX_BLOB_CELLS || maxY - minY > MAX_BLOB_CELLS) return null;
  // +0.5 puts the point at the cell's centre rather than its corner — at this
  // resolution one cell is ~27px of a 1280px frame, so the half-cell matters.
  return { x: (sx / count + 0.5) / w, y: (sy / count + 0.5) / h };
}

/**
 * Where the pointer is in `now`, given the frames either side of it.
 *
 * Both neighbours are required. With only one neighbour the answer would be
 * "one of these two places", and this function would have to guess — so it
 * declines instead, and the frame ships unmarked.
 */
export function findCursor(
  prev: GrayMap | null,
  now: GrayMap,
  next: GrayMap | null,
  opts: { threshold?: number; maxChanged?: number } = {},
): { x: number; y: number } | null {
  if (!prev || !next) return null;
  const arrived = changedMask(prev, now, opts.threshold);
  const left = changedMask(now, next, opts.threshold);
  if (arrived.length === 0 || left.length !== arrived.length) return null;
  const both = new Uint8Array(arrived.length);
  for (let i = 0; i < arrived.length; i++) both[i] = arrived[i] && left[i] ? 1 : 0;
  return centroidOf(both, now.w, now.h, opts.maxChanged);
}

/**
 * Walk a run of samples and fill in each one's cursor from its neighbours.
 *
 * Used by the capture loop, which holds the small maps for the last few samples
 * and therefore learns a frame's cursor one sample AFTER capturing it. That
 * lag is free: frames are selected at the end of an utterance, long after.
 */
export function cursorsFor(
  maps: readonly GrayMap[],
  opts: { threshold?: number; maxChanged?: number } = {},
): Array<{ x: number; y: number } | null> {
  return maps.map((m, i) => findCursor(maps[i - 1] ?? null, m, maps[i + 1] ?? null, opts));
}
