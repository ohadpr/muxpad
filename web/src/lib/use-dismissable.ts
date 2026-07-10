import { type RefObject, useEffect } from 'react';

/**
 * THE outside-click + Escape dismissal for menus and popovers. Six
 * components each hand-rolled this effect with three different event/phase
 * choices (pointerdown vs mousedown, capture vs bubble), so dismissal
 * timing quietly varied menu to menu and fixes never propagated.
 *
 * Capture-phase pointerdown: covers mouse AND touch, and fires before any
 * stopPropagation inside page content can eat the event. Clicks INSIDE the
 * container are the menu's own business.
 */
export function useDismissable(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, containerRef, onDismiss]);
}
