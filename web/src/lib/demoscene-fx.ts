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

/** How long the interference lingers after the pointer stops, in ms. */
export const FX_DECAY_MS = 620;

/** Below this, a move is the hand resting — not worth a frame. */
export const MOVE_EPSILON_PX = 2;

/** Radius of the disturbed region, in px. */
export const FX_RADIUS = 190;

/** The cell the glyph grid snaps to. Close to a monospace cell at 13–14px. */
export const CELL_W = 9;
export const CELL_H = 15;

/**
 * The glyph set. Deliberately the characters a text-mode screen could draw —
 * box drawing, blocks, shading, and the punctuation that reads as noise. A
 * random unicode soup would look like mojibake; this looks like a machine.
 */
export const GLYPHS = '░▒▓█▄▀▌▐│─┼╬╔╗╚╝═║01<>/\\|*+.:;=#$%&@';

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
 * and arithmetic is the only part that can be checked without a browser. The
 * effect being QUIET when it should be is the property that matters; it sits
 * over text somebody is trying to read.
 */
export function nextFx(
  prev: FxState,
  input: { x: number; y: number; dtMs: number; moved: number },
): FxState {
  const decay = Math.exp(-input.dtMs / FX_DECAY_MS);
  const faded = prev.intensity * decay;
  const fed = input.moved < MOVE_EPSILON_PX ? faded : Math.min(1, faded + input.moved / 220);
  return { x: input.x, y: input.y, intensity: fed };
}

/** Is the effect wanted at all? Theme AND the reader's motion preference. */
export function fxWanted(theme: string | null | undefined, reducedMotion: boolean): boolean {
  return theme === 'demoscene' && !reducedMotion;
}

/**
 * How strongly a cell at `dist` from the pointer is disturbed, 0–1.
 *
 * Falls to nothing at the radius rather than stopping at an edge: a hard
 * boundary reads as a circle drawn on the screen, which is a cursor gimmick,
 * and the thing being imitated has no edge.
 */
export function cellFalloff(dist: number, intensity: number): number {
  if (dist >= FX_RADIUS) return 0;
  const t = 1 - dist / FX_RADIUS;
  return t * t * intensity;
}

export function installDemosceneFx(doc: Document = document): () => void {
  const win = doc.defaultView;
  const reduced = win?.matchMedia('(prefers-reduced-motion: reduce)');
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let raf = 0;
  let last = 0;
  let state: FxState = { x: -9999, y: -9999, intensity: 0 };
  let pending: { x: number; y: number } | null = null;
  let detachPointer: (() => void) | null = null;

  const ensure = (): CanvasRenderingContext2D | null => {
    if (ctx && canvas) return ctx;
    const c = doc.createElement('canvas');
    c.className = 'demoscene-fx';
    c.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(c);
    canvas = c;
    ctx = c.getContext('2d');
    size();
    return ctx;
  };

  const size = () => {
    if (!canvas || !win) return;
    const dpr = Math.min(win.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(win.innerWidth * dpr);
    canvas.height = Math.floor(win.innerHeight * dpr);
    canvas.style.width = `${win.innerWidth}px`;
    canvas.style.height = `${win.innerHeight}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const accent = () =>
    getComputedStyle(doc.documentElement).getPropertyValue('--accent').trim() || '#19ffd0';

  const draw = () => {
    const c = ensure();
    if (!c || !win) return;
    c.clearRect(0, 0, win.innerWidth, win.innerHeight);
    const { x, y, intensity } = state;
    if (intensity <= 0.01) return;

    // ── THE GLYPH FIELD ────────────────────────────────────────────────────
    c.save();
    c.font = `${CELL_H - 3}px ui-monospace, Menlo, monospace`;
    c.textBaseline = 'top';
    const ink = accent();
    const cols = Math.ceil(FX_RADIUS / CELL_W);
    const rows = Math.ceil(FX_RADIUS / CELL_H);
    const ox = Math.round(x / CELL_W) * CELL_W;
    const oy = Math.round(y / CELL_H) * CELL_H;
    for (let i = -cols; i <= cols; i++) {
      for (let j = -rows; j <= rows; j++) {
        const cx = ox + i * CELL_W;
        const cy = oy + j * CELL_H;
        const d = Math.hypot(cx - x, cy - y);
        const a = cellFalloff(d, intensity);
        // Sparse on purpose: every cell filled is a block of noise, a few
        // cells filled is interference.
        // Density, tuned by looking: at 0.55 the field was so sparse it read
        // as a few stray characters rather than as interference, which is the
        // same failure the bloom had — too timid to be the thing asked for.
        if (a < 0.05 || Math.random() > a * 0.9) continue;
        c.globalAlpha = Math.min(0.72, a * 1.05);
        c.fillStyle = ink;
        c.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0] as string, cx, cy);
      }
    }
    c.restore();

    // ── THE TEAR ───────────────────────────────────────────────────────────
    // `difference` inverts what is already on the screen, so these bands
    // distort the PAGE's own text rather than covering it. One or two, thin,
    // and only while the effect is strong.
    if (intensity > 0.18) {
      c.save();
      c.globalCompositeOperation = 'difference';
      const bands = intensity > 0.6 ? 3 : 2;
      for (let b = 0; b < bands; b++) {
        const by = y + (Math.random() * 2 - 1) * FX_RADIUS * 0.6;
        const h = 2 + Math.random() * 3;
        c.globalAlpha = 0.72 * intensity;
        c.fillStyle = '#ffffff';
        c.fillRect(x - FX_RADIUS, by, FX_RADIUS * 2, h);
      }
      c.restore();
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
    draw();
    if (state.intensity > 0.01) raf = requestAnimationFrame(frame);
    else last = 0;
  };

  const onMove = (e: PointerEvent) => {
    pending = { x: e.clientX, y: e.clientY };
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const attach = () => {
    if (detachPointer) return;
    doc.addEventListener('pointermove', onMove, { passive: true });
    win?.addEventListener('resize', size);
    detachPointer = () => {
      doc.removeEventListener('pointermove', onMove);
      win?.removeEventListener('resize', size);
    };
  };

  const detach = () => {
    detachPointer?.();
    detachPointer = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    state = { ...state, intensity: 0 };
    canvas?.remove();
    canvas = null;
    ctx = null;
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
