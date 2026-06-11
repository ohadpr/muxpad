import { useEffect, useRef, useState } from 'react';

// How long Option/Alt must be held *alone* (no other key) before the tab
// number badges appear. Short enough to feel responsive, long enough that an
// incidental Alt chord (Alt+letter for a TUI Meta binding, etc.) doesn't flash
// the overlay.
const HOLD_MS = 300;

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
    let holdTimer: number | null = null;
    let armed = false; // Alt is down and nothing else has been pressed yet

    const clearHold = () => {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    const hide = () => {
      clearHold();
      armed = false;
      setShowNumbers(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        // Arm only on a fresh Alt press with no other modifier held.
        if (e.repeat || e.metaKey || e.ctrlKey) return;
        armed = true;
        clearHold();
        holdTimer = window.setTimeout(() => {
          holdTimer = null;
          if (armed) setShowNumbers(true);
        }, HOLD_MS);
        return;
      }
      // Not our chord unless Alt is currently held.
      if (!e.altKey) return;
      // Alt + digit → switch. Capture-phase preventDefault keeps it out of the
      // focused terminal.
      if (!e.metaKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
        const idx = quickSwitchIndex(Number(e.code.slice(5)), tabCountRef.current);
        if (idx !== null) {
          e.preventDefault();
          e.stopPropagation();
          onSwitchRef.current(idx);
        }
        hide();
        return;
      }
      // Alt + some other key (e.g. a TUI Meta binding) — the user isn't
      // quick-switching; drop the overlay and let the key through untouched.
      armed = false;
      clearHold();
      setShowNumbers(false);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') hide();
    };
    const onBlur = () => hide();

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onBlur);
    return () => {
      clearHold();
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return showNumbers;
}
