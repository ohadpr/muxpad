import { useEffect, useState } from 'react';
import {
  applyUpdate,
  dismissUpdate,
  pendingUpdate,
  startUpdateCheck,
  subscribeUpdate,
} from '../lib/update-check';
import './UpdateBanner.css';

/**
 * "New version — reload": the whole user-facing half of the update check.
 *
 * Mounted once in AppLayout, like MoveUndoToast, so it is route-independent and
 * survives navigation. Popout routes (a pane popout, the doc surface) mount
 * outside AppLayout and deliberately do not get it — they are single-purpose
 * windows, and the app window is where a decision about the whole app belongs.
 *
 * Which is also why the CHECK is started from here rather than from main.tsx's
 * boot wiring: the window that can show the answer is the one that asks, so a
 * popout never spends a request per foreground on a prompt it cannot render.
 *
 * It only ever offers. `lib/update-check.ts` explains why nothing here reloads
 * on its own: agents are running, and the user may be mid-message.
 *
 * Why a floating pill rather than a slot in the chrome, where the build number
 * already lives: the chrome's build label (`.brand-text-side`) is
 * `display: none` under 720px, and the installed iOS PWA this exists for is
 * exactly the case that would then see nothing.
 */
export function UpdateBanner() {
  const [build, setBuild] = useState<string | null>(() => pendingUpdate());
  useEffect(() => {
    // Subscribe BEFORE starting: the check is idempotent and async, but the
    // ordering is free and removes the question entirely.
    const unsubscribe = subscribeUpdate(setBuild);
    startUpdateCheck();
    return unsubscribe;
  }, []);
  if (!build) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> is a form's computed result, labelled by `for`; this is a live region announcing app state, which is exactly role="status". Same call as VoiceControl's notice bar.
    <div className="update-banner" role="status" aria-live="polite">
      <button
        type="button"
        className="update-banner-action"
        onClick={() => applyUpdate()}
        title={`Reload to pick up ${build}`}
      >
        New version — reload
      </button>
      <button
        type="button"
        className="update-banner-dismiss"
        aria-label="Dismiss"
        title="Dismiss until the next build"
        onClick={() => dismissUpdate()}
      >
        ×
      </button>
    </div>
  );
}
