// The web face's health loop. Two behaviours the old inline `setWebDead(!ok)`
// didn't have, and both are user-visible bugs:
//   - a single failed probe replaced a working app with an error card;
//   - a recovered backend left the proxy's stale 502 page in the iframe
//     forever, because the iframe is keyed by a URL that never changed.
import { describe, expect, it } from 'vitest';
import type { UrlLiveness } from './face-switch';
import {
  ALIVE_RECHECK_MS,
  DEAD_RECHECK_MS,
  type WebFaceHealth,
  initialWebFaceHealth,
  stepWebFaceHealth,
  webDeadBadge,
  webDeadMessage,
} from './web-face-health';

const alive: UrlLiveness = { alive: true, reason: 'ok', status: 200 };
const gateway: UrlLiveness = { alive: false, reason: 'gateway', status: 502 };
const gone: UrlLiveness = { alive: false, reason: 'unreachable', status: null };

/** Feed a sequence of probe results, returning every step. */
function run(results: UrlLiveness[]) {
  let state: WebFaceHealth = initialWebFaceHealth;
  return results.map((r) => {
    const step = stepWebFaceHealth(state, r);
    state = step.state;
    return step;
  });
}

describe('web face health — the dead-notice debounce', () => {
  it('does not condemn an app on a single failed probe', () => {
    const [first] = run([gateway]);
    expect(first?.deadReason).toBeNull();
  });

  it('shows the notice on the second consecutive failure', () => {
    const steps = run([gateway, gateway]);
    expect(steps[0]?.deadReason).toBeNull();
    expect(steps[1]?.deadReason).toBe('gateway');
    expect(steps[1]?.deadStatus).toBe(502);
  });

  it('resets the streak on any alive result — a blip never accumulates', () => {
    // dead, alive, dead → still only one consecutive failure, so no notice.
    const steps = run([gateway, alive, gateway]);
    expect(steps[2]?.deadReason).toBeNull();
  });

  it('clears the notice as soon as the app answers again', () => {
    const steps = run([gone, gone, alive]);
    expect(steps[1]?.deadReason).toBe('unreachable');
    expect(steps[2]?.deadReason).toBeNull();
  });
});

describe('web face health — the recovery remount', () => {
  it('does NOT remount on the first alive probe', () => {
    // The iframe is already showing the live app; remounting would throw away
    // whatever the user was doing in it for no reason.
    expect(run([alive])[0]?.reload).toBe(false);
    expect(run([alive, alive, alive]).every((s) => !s.reload)).toBe(true);
  });

  it('remounts when the backend comes back', () => {
    const steps = run([gateway, gateway, alive]);
    expect(steps[2]?.reload).toBe(true);
  });

  it('remounts even when the notice was never shown — the stale-502 case', () => {
    // ONE dead probe: the user never saw a notice, but the iframe did load the
    // proxy's 502 error page, and the URL key can't clear it. This is the
    // exact silent failure the whole change exists to fix.
    const steps = run([gateway, alive]);
    expect(steps[0]?.deadReason).toBeNull();
    expect(steps[1]?.reload).toBe(true);
  });

  it('remounts once per recovery, not on every subsequent alive probe', () => {
    const steps = run([gone, alive, alive, alive]);
    expect(steps.map((s) => s.reload)).toEqual([false, true, false, false]);
  });
});

describe('web face health — cadence', () => {
  it('probes often while dead and rarely while alive', () => {
    expect(stepWebFaceHealth(initialWebFaceHealth, gone).nextDelayMs).toBe(DEAD_RECHECK_MS);
    expect(stepWebFaceHealth(initialWebFaceHealth, alive).nextDelayMs).toBe(ALIVE_RECHECK_MS);
  });
});

describe('webDeadBadge — the face menu’s two-word verdict', () => {
  it('distinguishes a proxy with nothing behind it from nothing listening', () => {
    // Different problem, different fix: restart the app vs. restart the tunnel.
    // The menu used to label both "offline".
    expect(webDeadBadge('gateway')).toBe('no backend');
    expect(webDeadBadge('unreachable')).toBe('offline');
    expect(webDeadBadge('opaque')).toBe('offline');
  });

  it('calls a wedged server out separately', () => {
    expect(webDeadBadge('timeout')).toBe('not answering');
  });
});

describe('webDeadMessage', () => {
  it('names the proxy-up/backend-down case instead of claiming nothing is listening', () => {
    const m = webDeadMessage('gateway', 502, 'https://host.ts.net/app');
    expect(m).toContain('proxied');
    expect(m).toContain('502');
    // The old copy sent people hunting for a server that WAS listening.
    expect(m).not.toContain('Nothing is responding');
  });

  it('distinguishes a wedged server from an absent one', () => {
    expect(webDeadMessage('timeout', null, 'http://127.0.0.1:4321/')).toContain('in time');
    expect(webDeadMessage('unreachable', null, 'http://127.0.0.1:4321/')).toContain(
      'Nothing is responding',
    );
    expect(webDeadMessage('opaque', null, 'http://127.0.0.1:4321/')).toContain(
      'Nothing is responding',
    );
  });
});
