import { useEffect, useState } from 'react';

/**
 * "Click again" — the app's one confirmation mechanism, replacing
 * `window.confirm`.
 *
 * FIVE destructive controls used a native dialog: delete chat, close workspace
 * (×2), close tab, unregister app, unpublish artifact. It was the wrong shape
 * for every one of them. It takes the whole window for a decision about a
 * 20px row; it cannot be styled, so it arrives as system chrome reading
 * "127.0.0.1:7777 says"; it blocks the page, including the thing you wanted to
 * look at before answering; and — the part that actually broke behaviour — it
 * is a SILENT NO-OP in an installed iOS PWA. The surfaces driven by a thumb
 * had either no guard or a dead one, so the codebase had grown comments
 * explaining which rows could not be confirmed.
 *
 * Arming the control instead puts the question on the control: one press arms
 * (red, and the label says what the next press does), the next press acts. It
 * is the pattern the sheet's swipe tray already used, so this is also one
 * mechanism replacing two.
 *
 * DISARMING MATTERS AS MUCH AS ARMING. A control left armed behind you is the
 * accident the confirmation exists to prevent, so every caller disarms on
 * pointer-leave and blur, and this disarms on a timer regardless.
 */
export function useArmed(ms = 4000): {
  armed: boolean;
  /** Returns true if the press should ACT (it was already armed). */
  press: () => boolean;
  disarm: () => void;
} {
  const [armed, setArmed] = useState(false);
  // Long enough to read the armed label and move a pointer onto it; short
  // enough that a row you walked away from is safe when you come back.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ms);
    return () => clearTimeout(t);
  }, [armed, ms]);
  return {
    armed,
    press: () => {
      if (armed) {
        setArmed(false);
        return true;
      }
      setArmed(true);
      return false;
    },
    disarm: () => setArmed(false),
  };
}
