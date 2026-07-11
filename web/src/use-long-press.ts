import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, SyntheticEvent } from 'react';

interface UseLongPressOpts {
  onLongPress: () => void;
  ms?: number;
  moveThreshold?: number;
  /**
   * Fire `onLongPress` directly when the hold timer elapses, instead of
   * arming the SUBSEQUENT click. The click-deferral exists only for
   * consumers that window.open (iOS blocks popups outside an active user
   * gesture) — but iOS frequently never DELIVERS a click after a long
   * hold, so click-armed long-presses silently no-op. In-page consumers
   * (menus, rename) must set this or the gesture is unreliable on iOS.
   */
  fireOnTimer?: boolean;
}

interface UseLongPressResult {
  pressing: boolean;
  handlers: {
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: (e: PointerEvent) => void;
    onPointerCancel: (e: PointerEvent) => void;
    onPointerLeave: (e: PointerEvent) => void;
    onContextMenu: (e: SyntheticEvent) => void;
    onClick: (e: MouseEvent) => void;
  };
}

/**
 * Touch long-press gesture. Mobile analogue of desktop cmd-click. Arms a
 * timer on touch pointerdown; after `ms` (cancelled if the pointer moves
 * past `moveThreshold` or lifts first) sets an "armed" flag. The actual
 * `onLongPress` callback fires from the subsequent click handler — that
 * keeps it inside the active user gesture, which iOS Safari requires for
 * window.open / popups to not be blocked. Also suppresses the iOS/Android
 * context menu. Mouse and pen pointers are ignored so this never trips
 * on desktop.
 */
export function useLongPress({
  onLongPress,
  ms = 500,
  moveThreshold = 8,
  fireOnTimer = false,
}: UseLongPressOpts): UseLongPressResult {
  const [pressing, setPressing] = useState(false);
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const armed = useRef(false);
  // fireOnTimer mode: the hold already acted; the trailing click (if iOS
  // sends one at all) must be swallowed, not re-fired.
  const suppressClick = useRef(false);
  // Tracks whether the most recent pointer interaction was touch, so the
  // contextmenu handler only suppresses the platform menu for touch
  // long-press (Android) and lets desktop right-click open the NATIVE menu.
  const lastWasTouch = useRef(false);
  const cb = useRef(onLongPress);
  cb.current = onLongPress;

  const cancel = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
    setPressing(false);
  }, []);

  useEffect(() => cancel, [cancel]);

  return {
    pressing,
    handlers: {
      onPointerDown: (e) => {
        lastWasTouch.current = e.pointerType === 'touch';
        if (e.pointerType !== 'touch') return;
        // A fresh gesture never inherits a stale suppress: in fireOnTimer
        // mode iOS often drops the trailing click that would have cleared
        // this, so without resetting here the NEXT genuine tap gets eaten.
        suppressClick.current = false;
        armed.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        setPressing(true);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          setPressing(false);
          navigator.vibrate?.(10);
          if (fireOnTimer) {
            suppressClick.current = true;
            cb.current();
          } else {
            armed.current = true;
          }
        }, ms);
      },
      onPointerMove: (e) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        const dy = e.clientY - start.current.y;
        if (dx * dx + dy * dy > moveThreshold * moveThreshold) {
          armed.current = false;
          cancel();
        }
      },
      onPointerUp: () => cancel(),
      onPointerCancel: () => {
        armed.current = false;
        cancel();
      },
      onPointerLeave: () => {
        armed.current = false;
        cancel();
      },
      onContextMenu: (e) => {
        // Suppress the platform menu ONLY for touch long-press (Android's
        // selection menu would race ours; iOS's callout is killed via CSS).
        // On desktop, let the native right-click menu through so links keep
        // their "Open in New Tab" / "Copy Link" affordances.
        if (lastWasTouch.current) e.preventDefault();
      },
      onClick: (e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Fire the callback inside the click handler so window.open runs
        // within the active user gesture — iOS Safari blocks popups from
        // delayed (setTimeout) contexts.
        if (armed.current) {
          armed.current = false;
          e.preventDefault();
          e.stopPropagation();
          cb.current();
        }
      },
    },
  };
}

export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener');
}
