// THE iOS REALITY. Designed to, not fought with.
//
// muxpad is used from a Home Screen PWA on a phone, and voice mode there has
// one structural, non-negotiable limitation:
//
//   CAPTURE DIES WHEN THE APP BACKGROUNDS OR THE SCREEN LOCKS.
//
// Not a bug, not a permission we forgot to ask for, not something a service
// worker fixes: a Home Screen web app cannot declare `UIBackgroundModes:
// audio`, so the moment it leaves the foreground iOS takes the microphone
// away. PLAYBACK survives — which is the trap, because the session looks alive
// from the outside while the user is talking into a dead microphone and being
// billed for the privilege.
//
// So the policy here is to END THE SESSION, LOUDLY, rather than leave a zombie.
// A session the user must restart is a small annoyance. A session that silently
// stopped hearing them, kept the meter running, and then answered a question
// they asked ninety seconds ago is the kind of thing that makes someone turn
// the feature off forever.
//
// THE OTHER THREE, all smaller, all real:
//
//   PERMISSION DOESN'T PERSIST. In standalone mode the mic grant does not
//     reliably survive a relaunch. Expect a prompt every session, and treat
//     denial as an ordinary outcome with an ordinary message — not an error
//     state with a stack trace.
//   AUDIOCONTEXT DRIFTS. One gesture unlocks playback for the page's lifetime,
//     but a context can still land `suspended` or (iOS-only) `interrupted`
//     after a phone call or a Siri invocation. Every gesture re-checks and
//     resumes; it is two lines and it removes an entire class of "no sound"
//     report.
//   THE SCREEN LOCKS MID-SENTENCE. A Wake Lock is held for the life of the
//     session — and re-acquired on return to visible, because the lock is
//     released by the system when you background and does NOT come back on its
//     own.

/** Why a session ended, for the message the user reads. */
export type EndReason =
  | 'user'
  | 'backgrounded'
  | 'mic-denied'
  | 'transport-failed'
  | 'expired'
  | 'unmounted';

export function endReasonMessage(r: EndReason): string {
  switch (r) {
    case 'backgrounded':
      // Say WHY. "Voice ended" alone reads as a crash; this reads as a rule.
      return 'Voice ended — iOS stops the microphone when the app isn’t in front. Tap to start again.';
    case 'mic-denied':
      return 'Voice needs the microphone. Allow it in Settings → Safari, then tap again.';
    case 'transport-failed':
      return 'The voice connection dropped.';
    case 'expired':
      return 'The voice session expired.';
    default:
      return 'Voice ended.';
  }
}

/**
 * Ask for the microphone.
 *
 * MUST be called synchronously from a user gesture — a click handler, not a
 * promise chain that started in one. Constraints are deliberately minimal:
 * WebRTC negotiates the format in SDP, so there is no sample rate to pick, no
 * channel count to force and no `audio.format` to set. Echo cancellation and
 * noise suppression are requested because Safari honours them and they are the
 * first line against the phantom barge-ins mic-gate.ts cleans up after.
 */
export async function requestMic(): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) throw new Error('This browser can’t capture audio.');
  return md.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

export function isMicDenial(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
}

/**
 * A `<audio>` element that survives the whole page, unlocked once by a gesture.
 *
 * iOS ties "may this element play" to an element that has been played inside a
 * gesture at least once — not to the page. Creating a fresh element per session
 * means the second session is silent, which is an infuriating bug to chase.
 */
let sharedAudio: HTMLAudioElement | null = null;

export function voiceAudioElement(): HTMLAudioElement {
  if (sharedAudio) return sharedAudio;
  const el = document.createElement('audio');
  el.autoplay = true;
  // Never show controls, never go picture-in-picture, never get grabbed by the
  // lock screen's media controls (which would make Pause mean something
  // confusing for a live conversation).
  el.setAttribute('playsinline', '');
  el.style.display = 'none';
  document.body.appendChild(el);
  sharedAudio = el;
  return el;
}

/**
 * Unlock playback inside a gesture, and resume any AudioContext that has
 * drifted. Safe to call on every gesture; cheap and idempotent.
 *
 * The muted-play trick is what actually flips Safari's per-element permission
 * bit: play a silent element inside the gesture, immediately pause it, and the
 * element is blessed for the rest of the page's life.
 */
export async function unlockPlayback(el: HTMLAudioElement, ctx?: AudioContext | null) {
  try {
    if (!el.srcObject) {
      el.muted = true;
      await el.play();
      el.pause();
      el.muted = false;
    } else {
      await el.play();
    }
  } catch {
    // Denied autoplay is survivable — the ontrack handler retries.
  }
  // 'interrupted' is iOS-only and absent from the TS union, hence the cast.
  const state = ctx?.state as string | undefined;
  if (ctx && (state === 'suspended' || state === 'interrupted')) {
    await ctx.resume().catch(() => {});
  }
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(t: 'release', cb: () => void): void;
}

/**
 * Hold the screen awake for the life of a session, and TAKE IT BACK on return
 * to visible — the system drops the lock when the page hides and never
 * reinstates it, so a one-shot request silently stops working the first time
 * the user glances at a notification.
 *
 * Entirely optional: no Wake Lock API (every iOS before 16.4, and Firefox) just
 * means the screen may dim. Never a reason to refuse a session.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private want = false;
  private readonly onVisible = () => {
    if (this.want && document.visibilityState === 'visible') void this.acquire();
  };

  async acquire(): Promise<void> {
    this.want = true;
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } })
      .wakeLock;
    if (!wl) return;
    if (this.sentinel) return;
    try {
      const s = (await wl.request('screen')) as WakeLockSentinelLike;
      this.sentinel = s;
      s.addEventListener('release', () => {
        this.sentinel = null;
      });
      document.addEventListener('visibilitychange', this.onVisible);
    } catch {
      // Denied (low battery, unsupported) — the session is still fine.
    }
  }

  release(): void {
    this.want = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    const s = this.sentinel;
    this.sentinel = null;
    void s?.release().catch(() => {});
  }
}

/**
 * Fire once when the page stops being in front.
 *
 * `visibilitychange` is the reliable signal; `pagehide` is the belt-and-braces
 * one for a swipe-away, where iOS may freeze the page without a visibility
 * event first. Both funnel to a single call so the caller never has to make its
 * teardown idempotent for this reason alone.
 */
export function onBackgrounded(cb: () => void): () => void {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    cb();
  };
  const onVis = () => {
    if (document.visibilityState === 'hidden') fire();
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', fire);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', fire);
  };
}
