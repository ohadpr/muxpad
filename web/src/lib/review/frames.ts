// THE RING BUFFER, AND THE ONE RULE THE SPIKE BOUGHT WITH A BROKEN RUN.
//
// ─── Never dedupe a frame somebody is talking over ─────────────────────────
//
// The spike hashed every sample and dropped repeats. Then it produced a review
// where "make this button pink" and "put a monkey on this one" both pointed at
// the same picture — because between those two sentences the screen was
// BYTE-IDENTICAL and only the mouse had moved. A content hash cannot see a
// pointer. It never could, and no threshold fixes that: the cursor is ~0.02% of
// the pixels, which is indistinguishable from JPEG noise.
//
// So dedupe is strictly an IDLE optimisation — it exists to stop a review of a
// static page costing a frame every 300ms while nobody says anything. The
// moment speech starts, every sample is kept, because during speech the
// difference that matters is the one the hash is blind to.
//
// ─── Capture often, select late ────────────────────────────────────────────
//
// Sampling rate and attachment count are different numbers, and the spike
// conflated them (it uploaded what it sampled, so sampling more cost more). The
// buffer is cheap — a 1280px JPEG is ~70 KB and we hold a minute of them — and
// SELECTION is where the cost is. So sample at 3/s and let each note take the
// few frames inside its own span.
//
// Nothing in this file touches the DOM: a sample's pixels are an opaque
// `payload`, so the ring can be exercised with strings.

/** How much history to hold. A note cannot reach further back than this, and
 *  the pre-roll below is the only thing that ever wants to. */
export const RING_MS = 60_000;

/** Frames per note, at most. Four was the measured answer for a twelve-second
 *  utterance with four asks; five leaves one spare. */
export const MAX_FRAMES_PER_NOTE = 5;

/**
 * How far BEFORE an utterance a frame may be taken from.
 *
 * People point, then talk. Measured on the spike's successful run: the cursor
 * was already on the thing roughly half a second before the sentence about it
 * began. Without this the anchor frame shows the previous subject.
 */
export const PRE_ROLL_MS = 700;

/** Hamming distance, over the 256-bit hash below, under which two frames are
 *  "the same screen". Four bits absorbs JPEG noise and a blinking caret; it
 *  does not absorb a scroll, a hover state, or a repaint. */
export const SAME_FRAME_BITS = 4;

export interface FrameSample<P = unknown> {
  /** Session-clock ms — the same clock the segmenter stamps utterances with. */
  atMs: number;
  /** 256-bit average hash, hex. See `aHash`. */
  hash: string;
  /** Normalised cursor position, when the diff found one. */
  cursor: { x: number; y: number } | null;
  /** Whatever the caller needs to export the frame later (a canvas, a bitmap,
   *  a blob). The ring neither reads nor releases it. */
  payload: P;
}

/**
 * 256-bit average hash of a small greyscale map: one bit per cell, set when the
 * cell is brighter than the mean.
 *
 * Average-hash, not a perceptual DCT hash, deliberately: we are not looking for
 * similar-looking images, we are looking for the SAME screen, and aHash's
 * weakness (it calls two different photos of a beach equal) never comes up on a
 * screenshot of an app.
 */
export function aHash(gray: Uint8Array | readonly number[]): string {
  const n = gray.length;
  if (n === 0) return '';
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i] as number;
  const mean = sum / n;
  let hex = '';
  for (let i = 0; i < n; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) {
      if (((gray[i + b] as number) ?? 0) > mean) nibble |= 1 << (3 - b);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

const BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Differing bits between two hex hashes. Different lengths are "not the
 *  same", which is the honest answer when the maps were different sizes. */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number.parseInt(a[i] as string, 16) ^ Number.parseInt(b[i] as string, 16);
    d += BITS[x] ?? 0;
  }
  return d;
}

export function sameFrame(a: string, b: string, tolerance = SAME_FRAME_BITS): boolean {
  return hamming(a, b) <= tolerance;
}

export class FrameRing<P = unknown> {
  private samples: FrameSample<P>[] = [];
  private readonly windowMs: number;

  constructor(windowMs = RING_MS) {
    this.windowMs = windowMs;
  }

  get size(): number {
    return this.samples.length;
  }

  all(): readonly FrameSample<P>[] {
    return this.samples;
  }

  /**
   * Offer a sample. Returns false when it was dropped as an idle repeat —
   * which is the ONLY reason anything is ever dropped.
   *
   * `speaking` is not advice. While it is true the sample is kept whatever the
   * hash says, because the pixels the hash cannot see are the pixels the note
   * is about.
   */
  push(sample: FrameSample<P>, opts: { speaking: boolean }): boolean {
    const last = this.samples[this.samples.length - 1];
    if (!opts.speaking && last && sample.hash && sameFrame(last.hash, sample.hash)) {
      // Keep the clock moving on the frame we already hold: an idle screen
      // should look RECENT, not like it stopped being captured.
      last.atMs = sample.atMs;
      return false;
    }
    this.samples.push(sample);
    this.prune(sample.atMs);
    return true;
  }

  prune(nowMs: number) {
    const cutoff = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && (this.samples[drop] as FrameSample<P>).atMs < cutoff)
      drop++;
    if (drop > 0) this.samples = this.samples.slice(drop);
  }

  /** The sample nearest a moment, looking back `PRE_ROLL_MS` before it. */
  nearest(atMs: number): FrameSample<P> | undefined {
    let best: FrameSample<P> | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const s of this.samples) {
      const gap = Math.abs(s.atMs - atMs);
      if (gap < bestGap) {
        bestGap = gap;
        best = s;
      }
    }
    return best;
  }

  /**
   * The frames for one note, in time order.
   *
   * 1. The ANCHOR: the sample nearest the start of the utterance, taken from a
   *    window that reaches back PRE_ROLL_MS — people point, then talk.
   * 2. Up to MAX-1 more, spread across the span, skipping any that is the same
   *    screen as one already chosen. Spread rather than consecutive, because a
   *    sentence that wandered wandered across the whole span.
   *
   * Dedupe HERE is safe where dedupe at capture time was not: these frames all
   * sit inside one utterance, so two identical hashes differ only in cursor
   * position, and the anchor is already chosen — a second copy of the same
   * screen adds bytes, not information. Frames carrying a DIFFERENT cursor
   * position are kept even when the hash matches, which is the case that broke
   * the spike.
   */
  pick(startMs: number, endMs: number, max = MAX_FRAMES_PER_NOTE): FrameSample<P>[] {
    if (max <= 0 || this.samples.length === 0) return [];
    const from = startMs - PRE_ROLL_MS;
    const inSpan = this.samples.filter((s) => s.atMs >= from && s.atMs <= endMs);
    const near = this.nearest(startMs);
    const pool: FrameSample<P>[] = inSpan.length > 0 ? inSpan : near ? [near] : [];
    const first = pool[0];
    if (!first) return [];

    const chosen: FrameSample<P>[] = [];
    const take = (s: FrameSample<P> | undefined) => {
      if (!s || chosen.includes(s)) return;
      const dup = chosen.some(
        (c) =>
          sameFrame(c.hash, s.hash) &&
          // A moved cursor is a different frame even on an identical screen.
          movedBy(c.cursor, s.cursor) < 0.02,
      );
      if (!dup) chosen.push(s);
    };

    // The anchor, by distance from the utterance start.
    let anchor = first;
    for (const s of pool) {
      if (Math.abs(s.atMs - startMs) < Math.abs(anchor.atMs - startMs)) anchor = s;
    }
    take(anchor);

    // Then spread: evenly spaced targets across the span, nearest sample each.
    const spanStart = Math.max(from, first.atMs);
    const spanEnd = Math.max(spanStart, endMs);
    for (let i = 1; i < max && chosen.length < max; i++) {
      const at = spanStart + ((spanEnd - spanStart) * i) / max;
      let best: FrameSample<P> | undefined;
      let gap = Number.POSITIVE_INFINITY;
      for (const s of pool) {
        if (chosen.includes(s)) continue;
        const g = Math.abs(s.atMs - at);
        if (g < gap) {
          gap = g;
          best = s;
        }
      }
      take(best);
    }
    return chosen.sort((a, b) => a.atMs - b.atMs);
  }

  clear() {
    this.samples = [];
  }
}

/** Normalised distance between two cursor positions. An unknown position is
 *  treated as "somewhere else" — never as a match, which would let the dedupe
 *  swallow exactly the frames whose cursor we failed to find. */
export function movedBy(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y);
}
