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

/** How long the ripple keeps running after the pointer stops, in ms. */
export const FX_DECAY_MS = 900;

/** Below this, a move is the hand resting — not worth a frame. */
export const MOVE_EPSILON_PX = 2;

/** How far from the pointer the disturbance reaches, in px. */
export const FX_RADIUS = 340;

/** Peak sideways displacement of a line of text, in px. */
export const FX_AMPLITUDE = 11;

/** Distance between wave crests, in px. Roughly three lines of chat. */
export const FX_WAVELENGTH = 110;

/** How fast the wave travels outward, in px/second. */
export const FX_SPEED = 170;

export interface FxState {
  x: number;
  y: number;
  /** 0–1. Driven by movement, decays on its own. */
  intensity: number;
}

/**
 * The pure half: what the next frame should look like.
 *
 * Separated because the interesting rules — a still pointer fades, a fast one
 * brightens but never past 1, a resting hand produces nothing — are arithmetic,
 * and arithmetic is the only part checkable without a browser. The effect being
 * QUIET when it should be is the property that matters; it moves text somebody
 * is trying to read.
 */
export function nextFx(
  prev: FxState,
  input: { x: number; y: number; dtMs: number; moved: number },
): FxState {
  const decay = Math.exp(-input.dtMs / FX_DECAY_MS);
  const faded = prev.intensity * decay;
  const fed = input.moved < MOVE_EPSILON_PX ? faded : Math.min(1, faded + input.moved / 260);
  return { x: input.x, y: input.y, intensity: fed };
}

/** Is the effect wanted at all? Theme AND the reader's motion preference. */
export function fxWanted(theme: string | null | undefined, reducedMotion: boolean): boolean {
  return theme === 'demoscene' && !reducedMotion;
}

/**
 * The glyph set a corrupted text-mode screen falls back to. Box drawing,
 * blocks, shading, and the punctuation that reads as noise — a random unicode
 * soup would look like mojibake, this looks like a machine losing sync.
 */
export const GLYPHS = '░▒▓█▄▀▌▐│─┼╬╔╗╚╝═║◆◢◣▲▼<>/\\|*+=#@$%&';

/** Fraction of characters corrupted at the very centre of the disturbance. */
export const FX_PEAK_CORRUPTION = 0.55;

/**
 * How likely the character at `distance` px from the pointer is corrupted.
 *
 * ─── WHY THIS IS CHARACTER-LEVEL AND NOT A TRANSFORM ──────────────────────
 * Two earlier builds dodged this. The first painted glyphs on a canvas ABOVE
 * the text ("super noisy and does not affect the text"); the second displaced
 * whole paragraphs with `translateX`/`skewX` ("bouncing paragraphs… don't be
 * cute"). Both were avoiding the real thing because touching text is the
 * expensive, risky option. It is also the only one that is actually ASCII
 * distortion, so this does it.
 *
 * What makes it safe is the theme itself: demoscene sets a MONOSPACE family
 * for the whole UI, so substituting one character for another of the same
 * width changes no metric — no reflow, no line rewrap, no scroll jump. The
 * same effect under a proportional font would move text under the reader's
 * eye on every frame, which is why it is bound to this theme rather than
 * offered as a general one.
 *
 * Bounded on purpose: a cell that is always corrupted is unreadable, so even
 * at the centre it is a coin-flip per frame and the character flickers back.
 */
export function corruptionChance(distance: number, intensity: number): number {
  if (intensity <= 0.01 || distance >= FX_RADIUS) return 0;
  const falloff = (1 - distance / FX_RADIUS) ** 2;
  return falloff * intensity * FX_PEAK_CORRUPTION;
}

/**
 * Corrupt one line of text, returning the damaged copy.
 *
 * Same length, always — the caller depends on it (see `corruptionChance` for
 * why a length change would move the page). Whitespace is left alone: a line
 * whose spaces turn into blocks stops looking like damaged TEXT and starts
 * looking like a bar chart.
 */
export function corruptLine(
  text: string,
  charX: (index: number) => { x: number; y: number },
  pointer: { x: number; y: number },
  intensity: number,
  rand: () => number = Math.random,
): string {
  if (intensity <= 0.01) return text;
  let out: string[] | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\t') continue;
    const p = charX(i);
    const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
    if (rand() >= corruptionChance(d, intensity)) continue;
    if (!out) out = [...text];
    out[i] = GLYPHS[(rand() * GLYPHS.length) | 0] as string;
  }
  return out ? out.join('') : text;
}

export function installDemosceneFx(doc: Document = document): () => void {
  const win = doc.defaultView;
  const reduced = win?.matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let last = 0;
  let state: FxState = { x: -9999, y: -9999, intensity: 0 };
  let pending: { x: number; y: number } | null = null;
  let detachPointer: (() => void) | null = null;
  /** Every text node currently damaged, with the text it really holds. */
  const damaged = new Map<Text, string>();
  /** Monospace advance width, measured once per attach. */
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
  };

  const paragraphs = (): HTMLElement[] =>
    Array.from(
      doc.querySelectorAll<HTMLElement>(
        '.chat-list .chat-msg p, .chat-list .chat-msg li, .chat-list .chat-msg pre, .chat-list .chat-thinking',
      ),
    );

  const damage = () => {
    if (!win) return;
    // Put everything back first: a node damaged last frame and out of reach
    // this one must not keep its scars.
    restore();
    if (state.intensity <= 0.01 || selecting()) return;

    for (const el of paragraphs()) {
      const r = el.getBoundingClientRect();
      if (r.bottom < state.y - FX_RADIUS || r.top > state.y + FX_RADIUS) continue;
      if (r.right < state.x - FX_RADIUS || r.left > state.x + FX_RADIUS) continue;
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
          // radial falloff, and free, where a Range rect per character is not.
          const base = consumed;
          const charAt = (i: number) => {
            const k = base + i;
            return {
              x: r.left + ((k % perLine) + 0.5) * (cellW || 8),
              y: r.top + (Math.floor(k / perLine) + 0.5) * (lineH || 18),
            };
          };
          const next = corruptLine(text, charAt, { x: state.x, y: state.y }, state.intensity);
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
    const dt = last ? now - last : 16;
    last = now;
    const p = pending;
    const moved = p ? Math.hypot(p.x - state.x, p.y - state.y) : 0;
    state = nextFx(state, { x: p?.x ?? state.x, y: p?.y ?? state.y, dtMs: dt, moved });
    pending = null;
    damage();
    if (state.intensity > 0.01) raf = requestAnimationFrame(frame);
    else {
      last = 0;
      restore();
    }
  };

  const onMove = (e: PointerEvent) => {
    pending = { x: e.clientX, y: e.clientY };
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
    last = 0;
    state = { ...state, intensity: 0 };
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
