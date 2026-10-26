/**
 * PHOSPHOR UNDER THE POINTER — the demoscene theme's one interactive effect.
 *
 * Asked for as "mouse movements cause matrix style or demoscene effects to
 * ripple through text". The literal reading — per-character spans, a canvas
 * rain over the log — is the version that must not be built: the chat is a
 * READING SURFACE and text you are trying to read is the worst place in the
 * app to put motion. It would also wrap every glyph in an element, which costs
 * the DOM, the scroll mechanism and (worst) text selection, which was broken
 * and repaired two commits ago.
 *
 * So the effect is light, not letters. A CRT's phosphor glowed where the beam
 * had just been and decayed behind it; this is that, following the pointer —
 * a soft bloom over the surface the text sits on, never over the text itself.
 * At rest it is invisible, so nothing moves while you read.
 *
 * ─── WHY IT COSTS ALMOST NOTHING ──────────────────────────────────────────
 * One element, outside React, moved with `transform: translate3d` and faded
 * with `opacity` — the two properties a compositor animates without touching
 * layout or paint. Pointer samples are coalesced into one rAF, so a 1000 Hz
 * mouse writes the same number of frames as a 60 Hz one. It is `position:
 * fixed` with `pointer-events: none`, so it can never intercept a click, a
 * drag-select or a scroll.
 *
 * It exists ONLY while the demoscene theme is applied, and not at all for a
 * reader who asked the OS for less motion.
 */

/** How long the bloom lingers after the pointer stops, in ms. */
export const GLOW_DECAY_MS = 900;

/** Below this, a move is the hand resting — not worth a frame. */
export const MOVE_EPSILON_PX = 2;

export interface GlowState {
  x: number;
  y: number;
  /** 0–1. Driven by movement, decays on its own. */
  intensity: number;
}

/**
 * The pure half: what the next frame should look like.
 *
 * Separated because the interesting rules — a still pointer fades, a fast one
 * brightens but never past 1, a hand resting produces nothing — are arithmetic
 * and can be tested without a browser, which is the only way to know the
 * effect is quiet when it should be.
 */
export function nextGlow(
  prev: GlowState,
  input: { x: number; y: number; dtMs: number; moved: number },
): GlowState {
  const decay = Math.exp(-input.dtMs / GLOW_DECAY_MS);
  const faded = prev.intensity * decay;
  // Movement feeds the bloom, with a ceiling: a long fast sweep should not
  // light the screen up, it should look the same as an ordinary one.
  const fed = input.moved < MOVE_EPSILON_PX ? faded : Math.min(1, faded + input.moved / 260);
  return { x: input.x, y: input.y, intensity: fed };
}

/** Is the effect wanted at all? Theme AND the reader's motion preference. */
export function glowWanted(theme: string | null | undefined, reducedMotion: boolean): boolean {
  return theme === 'demoscene' && !reducedMotion;
}

/**
 * Attach to the document. Returns a teardown.
 *
 * Idempotent by construction: the caller holds the teardown, and the theme
 * watcher below calls it before re-attaching.
 */
export function installDemosceneGlow(doc: Document = document): () => void {
  const reduced = doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)');
  let el: HTMLElement | null = null;
  let raf = 0;
  let last = 0;
  let state: GlowState = { x: -9999, y: -9999, intensity: 0 };
  let pending: { x: number; y: number } | null = null;
  let detachPointer: (() => void) | null = null;

  const ensureEl = (): HTMLElement => {
    if (el) return el;
    const node = doc.createElement('div');
    node.className = 'demoscene-glow';
    node.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(node);
    el = node;
    return node;
  };

  const frame = (now: number) => {
    raf = 0;
    const node = ensureEl();
    const dt = last ? now - last : 16;
    last = now;
    const p = pending;
    const moved = p ? Math.hypot(p.x - state.x, p.y - state.y) : 0;
    state = nextGlow(state, { x: p?.x ?? state.x, y: p?.y ?? state.y, dtMs: dt, moved });
    pending = null;
    node.style.transform = `translate3d(${state.x}px, ${state.y}px, 0)`;
    node.style.opacity = String(state.intensity);
    // Keep stepping only while there is something to see — a still pointer
    // stops costing frames as soon as the bloom has faded out.
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
    detachPointer = () => doc.removeEventListener('pointermove', onMove);
  };

  const detach = () => {
    detachPointer?.();
    detachPointer = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    state = { ...state, intensity: 0 };
    el?.remove();
    el = null;
  };

  const sync = () => {
    if (glowWanted(doc.documentElement.dataset.theme, !!reduced?.matches)) attach();
    else detach();
  };

  // The theme is a `data-theme` attribute on <html>, set by settings.ts. Watch
  // it rather than subscribing to the settings module: this needs to be true
  // of the DOCUMENT, including the OS-flip path that never goes through a
  // React render.
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
