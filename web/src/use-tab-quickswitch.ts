import { useEffect, useRef, useState } from 'react';

/**
 * Map a pressed digit (1–9) to a tab index, or null if there's no such tab.
 * Pure — unit-tested. Badges/shortcuts only cover the first 9 tabs; beyond
 * that, use the tab bar / dropdown.
 */
export function quickSwitchIndex(digit: number, tabCount: number): number | null {
  const idx = digit - 1;
  return idx >= 0 && idx < tabCount && idx < 9 ? idx : null;
}

/**
 * Tab quick-switch: hold Option/Alt to reveal "1…9" badges on the tabs, then
 * Alt+<n> to jump to that tab. Returns whether the badges should be shown.
 * Badges appear the instant Alt goes down and stay up — through repeated
 * Alt+<n> switches — until Alt is released (or the window blurs).
 *
 * Why Alt (not Cmd or Ctrl): in a browser tab Cmd+number is owned by the
 * browser (switches browser tabs), and Ctrl+number has real terminal meaning
 * (Ctrl+3 = ESC, …). Alt/Meta+digit is free in the browser and effectively
 * unused by TUIs. The handler runs in the **capture phase** so Alt+digit is
 * intercepted before the focused xterm forwards it to the PTY.
 */
export function useTabQuickSwitch(opts: {
  tabCount: number;
  onSwitch: (index: number) => void;
}): boolean {
  const [showNumbers, setShowNumbers] = useState(false);
  const tabCountRef = useRef(opts.tabCount);
  tabCountRef.current = opts.tabCount;
  const onSwitchRef = useRef(opts.onSwitch);
  onSwitchRef.current = opts.onSwitch;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        // Show instantly on Alt-down (Alt is free of browser/terminal meaning
        // here, so no hold delay). Ignore when chorded with Cmd/Ctrl.
        if (!e.repeat && !e.metaKey && !e.ctrlKey) setShowNumbers(true);
        return;
      }
      // Not our chord unless Alt is currently held.
      if (!e.altKey) return;
      // Alt + digit: swallow before the focused terminal sees it, then switch.
      // Keep the badges up — the user may fire several Alt+<n> in a row while
      // Alt stays held; they only disappear on Alt-up. Require the BARE chord
      // (no Shift) so Alt+Shift+<n> stays available to a TUI's Meta bindings.
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        const idx = quickSwitchIndex(Number(e.code.slice(5)), tabCountRef.current);
        if (idx !== null) onSwitchRef.current(idx);
        return;
      }
      // Alt + some other key (e.g. a TUI Meta binding) — not a quick-switch;
      // drop the overlay and let the key through untouched.
      setShowNumbers(false);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setShowNumbers(false);
    };
    // Hide on anything that can swallow the Alt keyup (window blur, app/tab
    // switch via Cmd-Tab / Mission Control) so the badges can't get stuck on.
    const hide = () => setShowNumbers(false);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setShowNumbers(false);
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return showNumbers;
}
