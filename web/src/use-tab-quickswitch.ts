import { useEffect, useRef, useState } from 'react';

/** Badges/shortcuts cover only the first N tabs (Ctrl+1…9); beyond that, use
 *  the tab bar / dropdown. Single source of truth shared with TabBar. */
export const MAX_QUICK_SWITCH_TABS = 9;

/**
 * Map a pressed digit (1–9) to a tab index, or null if there's no such tab.
 * Pure — unit-tested.
 */
export function quickSwitchIndex(digit: number, tabCount: number): number | null {
  const idx = digit - 1;
  return idx >= 0 && idx < tabCount && idx < MAX_QUICK_SWITCH_TABS ? idx : null;
}

/** True when the event target is a text field, so Ctrl+digit should pass
 *  through to it rather than triggering quick-switch. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

/**
 * Tab quick-switch: hold Ctrl to reveal "1…9" badges on the tabs, then
 * Ctrl+<n> to jump to that tab. Returns whether the badges should be shown.
 * Badges appear the instant Ctrl goes down and stay up — through repeated
 * Ctrl+<n> switches — until Ctrl is released (or the window blurs).
 *
 * The handler runs in the **capture phase** so Ctrl+digit is intercepted
 * before the focused xterm forwards it to the PTY. Note: this claims Ctrl+1…9
 * from terminal apps (Ctrl+digit has C0 meaning in a TTY); that's the
 * deliberate trade for putting quick-switch on Ctrl. Cmd+number stays with the
 * browser (switches browser tabs), so it's left alone.
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
      if (e.key === 'Control') {
        // Show instantly on Ctrl-down. Ignore when chorded with Cmd/Alt.
        if (!e.repeat && !e.metaKey && !e.altKey) setShowNumbers(true);
        return;
      }
      // Not our chord unless Ctrl is currently held.
      if (!e.ctrlKey) return;
      // Ctrl + digit: swallow before the focused terminal sees it, then switch.
      // Keep the badges up — the user may fire several Ctrl+<n> in a row while
      // Ctrl stays held; they only disappear on Ctrl-up. Require the BARE chord
      // (no Shift/Cmd/Alt) so other chorded bindings stay available.
      if (!e.metaKey && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        // Don't hijack Ctrl+<n> while the user is typing in a field (rename
        // input, mobile composer) — let it reach the focused control.
        if (isEditableTarget(e.target)) return;
        const idx = quickSwitchIndex(Number(e.code.slice(5)), tabCountRef.current);
        // No matching tab → don't swallow it. Ctrl+digit has TTY meaning, so we
        // only intercept when we actually switch (a no-op swallow would eat,
        // e.g., Ctrl+5 from the terminal for nothing).
        if (idx === null) return;
        e.preventDefault();
        e.stopPropagation();
        onSwitchRef.current(idx);
        return;
      }
      // Ctrl + some other key — not a quick-switch; drop the overlay and let
      // the key through untouched.
      setShowNumbers(false);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') setShowNumbers(false);
    };
    // Hide on anything that can swallow the Ctrl keyup (window blur, app/tab
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
