// Active-device heartbeat. Tells the server "I'm at a device right now" so it
// HOLDS push notifications — the in-app UI already shows the update, so a buzz
// would be noise. Driven by real user activity (interaction + foreground), not
// mere tab visibility: a tab left open while you walked away stops pinging, so
// after the server's window lapses, pushes resume. Goes quiet immediately when
// the tab is hidden or the device sleeps.

let lastSent = 0;
// Throttle: at most one ping this often while active. Comfortably under the
// server's active-window so a steadily-used device always reads active.
const THROTTLE_MS = 15_000;

function ping(): void {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - lastSent < THROTTLE_MS) return;
  lastSent = now;
  // keepalive so a ping mid-navigation still lands; failures are ignorable.
  void fetch('/api/presence', { method: 'POST', keepalive: true }).catch(() => {});
}

/** Begin reporting active-device presence. Returns a teardown (rarely needed —
 *  it runs for the app's lifetime). */
export function startPresence(): () => void {
  const activity = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
  const onActivity = () => ping();
  for (const e of activity) window.addEventListener(e, onActivity, { passive: true });
  // scroll doesn't bubble — capture catches inner scroll containers (the chat,
  // the terminal) too.
  window.addEventListener('scroll', onActivity, { passive: true, capture: true });
  // Foregrounding / refocus: reset the throttle so the first ping lands now.
  const onForeground = () => {
    if (document.visibilityState === 'visible') {
      lastSent = 0;
      ping();
    }
  };
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('focus', onForeground);
  onForeground(); // ping now if we start foregrounded
  return () => {
    for (const e of activity) window.removeEventListener(e, onActivity);
    window.removeEventListener('scroll', onActivity, { capture: true } as EventListenerOptions);
    document.removeEventListener('visibilitychange', onForeground);
    window.removeEventListener('focus', onForeground);
  };
}
