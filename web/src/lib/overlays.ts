// Coordinates the top-bar dropdowns (mobile nav sheet, pane face menu, …) so
// only one is open at a time — opening one closes any other. Without this the
// pane face menu opened UNDER the nav sheet (they're independent components
// with no shared state, and the sheet sits at a higher z-index). A single
// window event keeps them mutually exclusive without wiring them together.

const EVT = 'muxpad:overlay-open';

/** Announce that overlay `id` just opened — every other overlay closes. */
export function announceOverlayOpen(id: string): void {
  window.dispatchEvent(new CustomEvent(EVT, { detail: { id } }));
}

/**
 * While mounted/open, close this overlay when a DIFFERENT overlay opens.
 * Returns an unsubscribe fn (use in a useEffect cleanup).
 */
export function onOtherOverlayOpen(id: string, close: () => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ id: string }>).detail;
    if (detail && detail.id !== id) close();
  };
  window.addEventListener(EVT, handler);
  return () => window.removeEventListener(EVT, handler);
}
