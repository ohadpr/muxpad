import { isMobileLayout } from './mobile-layout';

/** CSS vars consumed by mobile workspace / terminal sizing. */
export function syncMobileViewportCss(): void {
  const vv = window.visualViewport;
  const h = vv?.height ?? window.innerHeight;
  const top = vv?.offsetTop ?? 0;
  document.documentElement.style.setProperty('--mobile-vv-height', `${Math.round(h)}px`);
  document.documentElement.style.setProperty('--mobile-vv-offset-top', `${Math.round(top)}px`);
}

/**
 * Keep `--mobile-vv-height` in sync and notify when the visual viewport
 * changes by keyboard-scale amount (not address-bar jitter).
 */
export function installMobileViewportSync(onSignificantResize?: () => void): () => void {
  if (!isMobileLayout()) return () => {};

  let lastH = window.visualViewport?.height ?? window.innerHeight;
  const THRESH = 72;

  const bump = () => {
    syncMobileViewportCss();
    const h = window.visualViewport?.height ?? window.innerHeight;
    if (Math.abs(h - lastH) >= THRESH) {
      lastH = h;
      onSignificantResize?.();
    }
  };

  syncMobileViewportCss();
  const vv = window.visualViewport;
  vv?.addEventListener('resize', bump);
  vv?.addEventListener('scroll', bump);
  window.addEventListener('resize', bump);

  return () => {
    vv?.removeEventListener('resize', bump);
    vv?.removeEventListener('scroll', bump);
    window.removeEventListener('resize', bump);
  };
}

/** Terminal area height from container top to visual viewport bottom minus composer. */
export function mobileTerminalHeightPx(containerTop: number): number | null {
  if (!isMobileLayout()) return null;
  const vv = window.visualViewport;
  const vh = vv?.height ?? window.innerHeight;
  const vTop = vv?.offsetTop ?? 0;
  const barH = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--mobile-input-bar-height') || '0',
  );
  const avail = vh + vTop - containerTop - barH - 8;
  return avail >= 80 ? Math.floor(avail) : null;
}
