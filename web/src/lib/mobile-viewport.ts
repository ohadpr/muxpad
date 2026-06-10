import { isMobileLayout } from './mobile-layout';

/** Terminal area height from container top to visual viewport bottom minus composer. */
export function mobileTerminalHeightPx(containerTop: number): number | null {
  if (!isMobileLayout()) return null;
  const vv = window.visualViewport;
  const vh = vv?.height ?? window.innerHeight;
  const vTop = vv?.offsetTop ?? 0;
  const barH = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--mobile-input-bar-height') || '0',
  );
  const avail = vh + vTop - containerTop - barH - 8;
  return avail >= 80 ? Math.floor(avail) : null;
}
