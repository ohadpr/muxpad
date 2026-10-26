/**
 * ASCII INTERFERENCE UNDER THE POINTER — the demoscene theme's one effect.
 *
 * ─── WHAT THIS REPLACES, AND WHY ──────────────────────────────────────────
 * The first build of this was a soft bloom that followed the mouse. It was
 * safe, it was cheap, and it was nothing: "the hover effect sucks, it's just a
 * bloom. I want it to create ascii distortion to the display text."
 *
 * The bloom was the timid reading of the brief. This is the literal one, built
 * the only way that does not wreck the app: the distortion is PAINTED OVER the
 * text on a canvas, never applied to it. Mutating the text would mean wrapping
 * glyphs in elements — which costs the DOM, the scroll mechanism and text
 * selection (broken and repaired a few commits ago, and not worth breaking for
 * an ornament).
 *
 * Two things are drawn, both only near the pointer and both fading with it:
 *
 *   · A GLYPH FIELD on a monospace cell grid — characters from the set a
 *     text-mode machine actually had, re-rolled a few per frame so the field
 *     crawls rather than strobes. This is the "ascii" half.
 *   · TEAR BANDS — one or two scanline-height rectangles drawn in `difference`
 *     blend, which INVERTS the real pixels under them. That is the half that
 *     distorts the display text itself: the characters under a band are the
 *     page's own, momentarily inverted, exactly like a sync fault on a tube.
 *
 * ─── THE RULES IT STAYS INSIDE ────────────────────────────────────────────
 * `pointer-events: none`, so it can never take a click, a drag-select or a
 * scroll. One canvas, outside React. Pointer samples coalesce into one rAF, so
 * a 1000Hz mouse costs what a 60Hz one costs. The loop stops dead when the
 * effect has faded — a still pointer costs nothing at all. It exists only
 * while the demoscene theme is applied, and never for a reader who asked the
 * OS for less motion.
 */

/**
 * ─── DROPS, NOT A SPOTLIGHT ───────────────────────────────────────────────
 * The previous build corrupted a disc of characters that followed the cursor
 * around and faded slowly: "improving… I want it to dissipate much faster and
 * feel a bit subtler", pointed at ASCII rain-drop animations.
 *
 * That is a different shape, not a different intensity. A drop is an EVENT
 * with a place and a birth time: it leaves one ring that expands, thins and
 * dies. Moving the pointer sheds drops along the way, so what the reader sees
 * is disturbance travelling outward from where the cursor has BEEN — not a
 * blob parked under where it IS.
 *
 * Thin rings are also quieter than a filled disc for free: at any instant only
 * the characters inside a narrow band are touched, so the same peak rate reads
 * as a fraction of the damage.
 */

/** How long one drop's ring lives, in ms. Short — this has to dissipate. */
export const DROP_LIFE_MS = 620;

/** How fast the ring expands, px/sec. */
export const DROP_SPEED = 300;

/** Half-width of the ring band, in px. A couple of character cells. */
export const DROP_BAND = 13;

/** Peak corruption rate, on the band, at birth. */
export const DROP_PEAK = 0.3;

/** A drop is shed at most this often, and only after this much movement. */
export const DROP_MIN_INTERVAL_MS = 110;
export const DROP_MIN_DISTANCE_PX = 34;

/** The glyph set a corrupted text-mode screen falls back to. */
export const GLYPHS = '░▒▓█▄▀▌▐│─┼╬╔╗╚╝═║◆◢◣▲▼<>/\\|*+=#@$%&';

export interface Drop {
  x: number;
  y: number;
  /** performance.now() at impact. */
  born: number;
}

/** Is the effect wanted at all? Theme AND the reader's motion preference. */
export function fxWanted(theme: string | null | undefined, reducedMotion: boolean): boolean {
  return theme === 'demoscene' && !reducedMotion;
}

/** Drops that still have a ring to draw. */
export function liveDrops(drops: readonly Drop[], now: number): Drop[] {
  return drops.filter((d) => now - d.born < DROP_LIFE_MS);
}

/**
 * Should the pointer shed a new drop here?
 *
 * Rate AND distance, both: a fast sweep should leave a trail rather than a
 * smear, and a pointer jittering in place should not keep hammering the same
 * spot — which is what made the old effect feel like a spotlight.
 */
export function shouldDrop(
  last: Drop | undefined,
  at: { x: number; y: number },
  now: number,
): boolean {
  if (!last) return true;
  if (now - last.born < DROP_MIN_INTERVAL_MS) return false;
  return Math.hypot(at.x - last.x, at.y - last.y) >= DROP_MIN_DISTANCE_PX;
}

/**
 * How strongly one drop disturbs a character `distance` px away, right now.
 *
 * A gaussian band riding an expanding radius: nothing at the centre once the
 * ring has left, nothing outside it, and the whole thing fading as it ages so
 * a ring thins out rather than vanishing mid-screen.
 */
export function ringStrength(distance: number, ageMs: number): number {
  if (ageMs < 0 || ageMs >= DROP_LIFE_MS) return 0;
  const radius = (ageMs / 1000) * DROP_SPEED;
  const band = Math.exp(-((distance - radius) ** 2) / (2 * DROP_BAND ** 2));
  const fade = 1 - ageMs / DROP_LIFE_MS;
  return band * fade * fade;
}

/** The chance a character at this point is corrupted, over every live drop. */
export function corruptionAt(
  point: { x: number; y: number },
  drops: readonly Drop[],
  now: number,
): number {
  let strongest = 0;
  for (const d of drops) {
    const s = ringStrength(Math.hypot(point.x - d.x, point.y - d.y), now - d.born);
    if (s > strongest) strongest = s;
  }
  return strongest * DROP_PEAK;
}

/**
 * Corrupt one line of text, returning the damaged copy.
 *
 * Same length, always — the caller depends on it: the theme is monospace, so a
 * same-width substitution changes no metric and nothing reflows. Whitespace is
 * left alone, or a damaged line reads as a bar chart rather than as text.
 */
export function corruptLine(
  text: string,
  charAt: (index: number) => { x: number; y: number },
  drops: readonly Drop[],
  now: number,
  rand: () => number = Math.random,
): string {
  if (drops.length === 0) return text;
  let out: string[] | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\t') continue;
    if (rand() >= corruptionAt(charAt(i), drops, now)) continue;
    if (!out) out = [...text];
    out[i] = GLYPHS[(rand() * GLYPHS.length) | 0] as string;
  }
  return out ? out.join('') : text;
}

/** How far the ring dims the characters it passes over, 0–1. */
export const DROP_DIM = 0.15;

/**
 * A CSS mask that dims the characters a ring is currently crossing.
 *
 * ─── WHY A MASK, AND NOT SPANS ────────────────────────────────────────────
 * Corrupting a character is a text-node write, which is cheap. DIMMING one is
 * not: colour applies to elements, so per-character brightness means wrapping
 * every glyph in a span — the thing this whole effect has avoided from the
 * start, because it costs the DOM, the scroll mechanism and text selection.
 *
 * A mask reaches the same place from the other side. `mask-image` multiplies a
 * paragraph's alpha per PIXEL, so a radial gradient with a slightly
 * transparent band at the ring's radius dims exactly the characters the ring
 * is passing over, in their own shape, with no markup at all and no layout.
 *
 * One drop per element, the nearest: masks do not add without
 * `mask-composite`, and the gain from a second ring on the same paragraph is
 * not worth a second gradient in a string rebuilt every frame.
 *
 * Returns null when nothing is close enough, so the caller can clear the
 * property rather than writing an identity mask.
 */
export function ringMask(
  rect: { left: number; top: number; width: number; height: number },
  drops: readonly Drop[],
  now: number,
): string | null {
  let best: { d: Drop; radius: number; fade: number } | null = null;
  for (const d of drops) {
    const age = now - d.born;
    if (age < 0 || age >= DROP_LIFE_MS) continue;
    const radius = (age / 1000) * DROP_SPEED;
    const fade = (1 - age / DROP_LIFE_MS) ** 2;
    // Does this ring actually cross the box? Cheap rejection on the nearest
    // corner/edge distance, so an untouched paragraph costs one comparison.
    const cx = Math.max(rect.left, Math.min(d.x, rect.left + rect.width));
    const cy = Math.max(rect.top, Math.min(d.y, rect.top + rect.height));
    const near = Math.hypot(d.x - cx, d.y - cy);
    const far = Math.hypot(
      Math.max(Math.abs(d.x - rect.left), Math.abs(d.x - rect.left - rect.width)),
      Math.max(Math.abs(d.y - rect.top), Math.abs(d.y - rect.top - rect.height)),
    );
    if (radius + DROP_BAND * 2 < near || radius - DROP_BAND * 2 > far) continue;
    if (!best || fade > best.fade) best = { d, radius, fade };
  }
  if (!best) return null;
  const alpha = (1 - DROP_DIM * best.fade).toFixed(3);
  const x = (best.d.x - rect.left).toFixed(1);
  const y = (best.d.y - rect.top).toFixed(1);
  const inner = Math.max(0, best.radius - DROP_BAND).toFixed(1);
  const mid = best.radius.toFixed(1);
  const outer = (best.radius + DROP_BAND).toFixed(1);
  return (
    `radial-gradient(circle at ${x}px ${y}px, ` +
    `#000 ${inner}px, rgba(0,0,0,${alpha}) ${mid}px, #000 ${outer}px)`
  );
}

/** The furthest a live ring can have travelled — the cull radius for rows. */
export const DROP_MAX_RADIUS = (DROP_LIFE_MS / 1000) * DROP_SPEED + DROP_BAND * 3;

export function installDemosceneFx(doc: Document = document): () => void {
  const win = doc.defaultView;
  const reduced = win?.matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let drops: Drop[] = [];
  let detachPointer: (() => void) | null = null;
  /** Every text node currently damaged, with the text it really holds. */
  const damaged = new Map<Text, string>();
  /** Every element currently wearing a ring mask, so it can be cleared. */
  let masked: HTMLElement[] = [];
  let cellW = 0;
  let lineH = 0;

  const measureCell = (sample: HTMLElement) => {
    const cs = getComputedStyle(sample);
    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    cellW = ctx.measureText('M').width || 8;
    lineH = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.5;
  };

  /**
   * A live selection means the reader's hand is on this text. Rewriting it
   * would collapse the selection — the same rule the scroll mechanism follows
   * (chat-scroll-dom's `selecting`), for the same reason.
   */
  const selecting = (): boolean => {
    const sel = doc.getSelection();
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0;
  };

  const restore = () => {
    for (const [node, text] of damaged) node.nodeValue = text;
    damaged.clear();
    for (const el of masked) {
      el.style.maskImage = '';
      el.style.webkitMaskImage = '';
    }
    masked = [];
  };

  const paragraphs = (): HTMLElement[] =>
    Array.from(
      doc.querySelectorAll<HTMLElement>(
        '.chat-list .chat-msg p, .chat-list .chat-msg li, .chat-list .chat-msg pre, .chat-list .chat-thinking',
      ),
    );

  const damage = (now: number) => {
    if (!win) return;
    // Put everything back first: a node damaged last frame and out of reach
    // this one must not keep its scars.
    restore();
    if (drops.length === 0 || selecting()) return;

    // One bounding box for every live ring, so a paragraph nowhere near any of
    // them is skipped before a single character is considered.
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const d of drops) {
      minX = Math.min(minX, d.x - DROP_MAX_RADIUS);
      maxX = Math.max(maxX, d.x + DROP_MAX_RADIUS);
      minY = Math.min(minY, d.y - DROP_MAX_RADIUS);
      maxY = Math.max(maxY, d.y + DROP_MAX_RADIUS);
    }

    for (const el of paragraphs()) {
      const r = el.getBoundingClientRect();
      if (r.bottom < minY || r.top > maxY || r.right < minX || r.left > maxX) continue;
      // The ring DIMS what it crosses as well as corrupting it — the part that
      // makes it read as a wave rather than as scattered glyphs.
      const mask = ringMask(r, drops, now);
      if (mask) {
        el.style.maskImage = mask;
        el.style.webkitMaskImage = mask;
        masked.push(el);
      }
      if (!cellW) measureCell(el);
      const perLine = Math.max(1, Math.floor(r.width / (cellW || 8)));
      const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode() as Text | null;
      let consumed = 0;
      while (n) {
        const text = n.nodeValue ?? '';
        if (text.trim()) {
          // Where a character sits, assuming the monospace grid the theme
          // guarantees. Approximate across inline markup — exact enough for a
          // ring, and free, where a Range rect per character is not.
          const base = consumed;
          const charAt = (i: number) => {
            const k = base + i;
            return {
              x: r.left + ((k % perLine) + 0.5) * (cellW || 8),
              y: r.top + (Math.floor(k / perLine) + 0.5) * (lineH || 18),
            };
          };
          const next = corruptLine(text, charAt, drops, now);
          if (next !== text) {
            damaged.set(n, text);
            n.nodeValue = next;
          }
          consumed += text.length;
        }
        n = walker.nextNode() as Text | null;
      }
    }
  };

  const frame = (now: number) => {
    raf = 0;
    drops = liveDrops(drops, now);
    damage(now);
    // The rings expire on their own, so the loop ends when the last one does —
    // no decay to wait out and nothing running under a still pointer.
    if (drops.length) raf = requestAnimationFrame(frame);
    else restore();
  };

  const onMove = (e: PointerEvent) => {
    const now = performance.now();
    const at = { x: e.clientX, y: e.clientY };
    if (!shouldDrop(drops[drops.length - 1], at, now)) return;
    drops.push({ ...at, born: now });
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const attach = () => {
    if (detachPointer) return;
    doc.addEventListener('pointermove', onMove, { passive: true });
    detachPointer = () => doc.removeEventListener('pointermove', onMove);
  };

  const detach = () => {
    detachPointer?.();
    detachPointer = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    drops = [];
    cellW = 0;
    restore();
  };

  const sync = () => {
    if (fxWanted(doc.documentElement.dataset.theme, !!reduced?.matches)) attach();
    else detach();
  };

  const obs = new MutationObserver(sync);
  obs.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  reduced?.addEventListener?.('change', sync);
  sync();

  return () => {
    obs.disconnect();
    reduced?.removeEventListener?.('change', sync);
    detach();
  };
}
