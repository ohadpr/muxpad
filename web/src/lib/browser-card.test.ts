import { describe, expect, it } from 'vitest';
import {
  type BrowserCardData,
  type BrowserWheelLease,
  browserCardView,
  browserOpenMode,
  browserViewerPath,
  shouldRenewWheel,
  visibleBrowsers,
  wheelCountdown,
} from './browser-card.js';

const base: BrowserCardData = {
  profile: 'shopping',
  viewerUrl: 'http://127.0.0.1:9510',
  state: 'running',
  wheel: null,
};

const lease = (over: Partial<BrowserWheelLease> = {}): BrowserWheelLease => ({
  holder: 'human',
  by: 'pane-7',
  takenAt: 1_000_000,
  expiresAt: 1_600_000,
  ...over,
});

describe('what the card says', () => {
  it('shouts when the agent is waiting for you', () => {
    const view = browserCardView({ ...base, needsYou: { reason: 'log in to Amazon', at: 1 } });
    expect(view.tone).toBe('blocked');
    expect(view.urgent).toBe(true);
    expect(view.action).toBe('Take the wheel');
    expect(view.detail).toBe('log in to Amazon');
  });

  it('puts "needs you" ABOVE the agent holding the wheel', () => {
    // An agent that has asked for help is still nominally driving. If the
    // holder check came first, the card would say "browsing" at the exact
    // moment it is stuck waiting for you — the failure this feature ends.
    const view = browserCardView({
      ...base,
      wheel: lease({ holder: 'agent', by: 'chat-1' }),
      needsYou: { reason: 'captcha', at: 1 },
    });
    expect(view.tone).toBe('blocked');
  });

  it('says so plainly when you have the wheel', () => {
    const view = browserCardView({ ...base, wheel: lease() });
    expect(view.tone).toBe('yours');
    expect(view.title).toMatch(/you have the wheel/i);
    expect(view.urgent).toBe(false);
  });

  it('is calm while the agent is browsing', () => {
    const view = browserCardView({ ...base, wheel: lease({ holder: 'agent', by: 'chat-1' }) });
    expect(view.tone).toBe('working');
    expect(view.action).toBe('Watch');
    expect(view.urgent).toBe(false);
  });

  it('always names the profile, so two cards are tellable apart', () => {
    expect(browserCardView({ ...base, profile: 'research' }).title).toContain('research');
  });
});

describe('where it opens', () => {
  it('uses a tab on a phone, not a modal', () => {
    // A modal on a phone is a 1280px page inside a 390px viewport with the
    // keyboard over half of it — unusable for the one thing you opened it to
    // do, which is type.
    expect(browserOpenMode(390)).toBe('tab');
    expect(browserOpenMode(699)).toBe('tab');
  });

  it('uses a modal with room for it', () => {
    expect(browserOpenMode(700)).toBe('modal');
    expect(browserOpenMode(1440)).toBe('modal');
  });
});

describe('the countdown', () => {
  it('is empty when nobody holds it', () => {
    expect(wheelCountdown(null, 0)).toBe('');
  });

  it('counts minutes, then seconds', () => {
    expect(wheelCountdown(lease(), 1_000_000)).toBe('10m left');
    expect(wheelCountdown(lease(), 1_570_000)).toBe('30s left');
  });

  it('says expired rather than showing a negative', () => {
    expect(wheelCountdown(lease(), 1_700_000)).toBe('expired');
  });
});

describe('renewing', () => {
  it('renews at the HALFWAY point, not near expiry', () => {
    // A renew at 90% of a ten-minute lease is one dropped request away from
    // the browser being taken back mid-sentence, and the request is free.
    expect(shouldRenewWheel(lease(), 1_200_000)).toBe(false);
    expect(shouldRenewWheel(lease(), 1_300_000)).toBe(true);
  });

  it('does not renew somebody else’s lease', () => {
    expect(shouldRenewWheel(lease({ holder: 'agent' }), 1_400_000)).toBe(false);
  });

  it('does not renew one that already lapsed', () => {
    expect(shouldRenewWheel(lease(), 1_700_000)).toBe(false);
  });

  it('does not divide by zero on a zero-length lease', () => {
    expect(shouldRenewWheel(lease({ expiresAt: 1_000_000 }), 1_000_000)).toBe(false);
  });
});

describe('which browsers are worth a card', () => {
  // A card in every conversation for a browser that is not running is pure
  // noise: it says nothing, it cannot be looked at, and it is there forever.
  // The card exists to tell you something is HAPPENING.
  const running = { ...base, state: 'running' as const };
  const stopped = { ...base, state: 'registered' as const };

  it('shows a running browser', () => {
    expect(visibleBrowsers([running])).toHaveLength(1);
  });

  it('hides one that is merely registered', () => {
    expect(visibleBrowsers([stopped])).toHaveLength(0);
  });

  it('shows one that is asking for you, whatever the state says', () => {
    // If these ever disagree, "an agent is waiting for you" wins. A missed
    // summons is far worse than a card that lingers a poll too long.
    expect(visibleBrowsers([{ ...stopped, needsYou: { reason: 'captcha', at: 1 } }])).toHaveLength(
      1,
    );
  });

  it('shows one somebody is driving, whatever the state says', () => {
    expect(visibleBrowsers([{ ...stopped, wheel: lease() }])).toHaveLength(1);
  });

  it('keeps the order it was given, so cards do not jump around', () => {
    const a = { ...running, profile: 'a' };
    const b = { ...running, profile: 'b' };
    expect(visibleBrowsers([a, b]).map((x) => x.profile)).toEqual(['a', 'b']);
  });

  it('is empty when nothing is running — the common case', () => {
    expect(visibleBrowsers([stopped, stopped])).toEqual([]);
  });
});

describe('where the iframe points', () => {
  it('is relative, so it is same-origin however you reached the cockpit', () => {
    // Absolute would make one of "at my desk on loopback" and "on the sofa over
    // the tailnet" a cross-origin frame for no reason.
    expect(browserViewerPath('default')).toBe('/browser/default/');
    expect(browserViewerPath('default').startsWith('/')).toBe(true);
    expect(browserViewerPath('default')).not.toContain('://');
  });
});
