import { describe, expect, it } from 'vitest';
import {
  type BrowserCardData,
  type BrowserEvent,
  type BrowserMoment,
  type BrowserWheelLease,
  browserCardView,
  browserMomentView,
  browserMoments,
  browserOpenMode,
  browserViewerPath,
  injectBrowserMoments,
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

describe('the moments a conversation draws', () => {
  const ev = (kind: BrowserEvent['kind'], at: number, over: Record<string, unknown> = {}) =>
    ({ kind, at, ...over }) as BrowserEvent;

  it('turns an opened and a summons into two separate cards', () => {
    // The whole point of the redesign: a browser opening and an agent getting
    // stuck are two things that happened, at two moments, not one status light.
    const moments = browserMoments(
      [{ ...base, events: [ev('opened', 100), ev('needs-you', 500, { reason: 'captcha' })] }],
      'tab-1',
    );
    expect(moments.map((m) => [m.kind, m.at])).toEqual([
      ['opened', 100],
      ['needs-you', 500],
    ]);
  });

  it('keeps the reason on the summons, because that IS the card', () => {
    const [m] = browserMoments(
      [{ ...base, events: [ev('needs-you', 1, { reason: 'log in to Amazon' })] }],
      'tab-1',
    );
    expect(m?.reason).toBe('log in to Amazon');
  });

  it('shows a moment that happened in THIS chat', () => {
    expect(
      browserMoments([{ ...base, events: [ev('opened', 1, { tabId: 'tab-1' })] }], 'tab-1'),
    ).toHaveLength(1);
  });

  it('hides one that happened in a DIFFERENT chat', () => {
    // Otherwise every browser event appears in every conversation, which is the
    // noise the pinned card had, moved somewhere worse.
    expect(
      browserMoments([{ ...base, events: [ev('opened', 1, { tabId: 'other' })] }], 'tab-1'),
    ).toHaveLength(0);
  });

  it('shows one that belongs to NO chat, so nothing is invisible', () => {
    // A browser started from the CLI has no conversation. Hiding it everywhere
    // would mean a summons nobody can see.
    expect(browserMoments([{ ...base, events: [ev('opened', 1)] }], 'tab-1')).toHaveLength(1);
  });

  it('drops "resolved" — it is bookkeeping, not something to read', () => {
    expect(
      browserMoments([{ ...base, events: [ev('opened', 1), ev('resolved', 2)] }], 'tab-1'),
    ).toHaveLength(1);
  });

  it('sorts across profiles by when they happened', () => {
    const a = { ...base, profile: 'a', events: [ev('opened', 300)] };
    const b = { ...base, profile: 'b', events: [ev('opened', 100)] };
    expect(browserMoments([a, b], 'tab-1').map((m) => m.profile)).toEqual(['b', 'a']);
  });

  it('carries the live browser with each moment, so the card can act', () => {
    // A card drawn from a moment still needs to open the CURRENT browser and
    // know who holds the wheel right now.
    const [m] = browserMoments([{ ...base, events: [ev('opened', 1)] }], 'tab-1');
    expect(m?.browser.viewerUrl).toBe(base.viewerUrl);
  });

  it('is empty when nothing has happened', () => {
    expect(browserMoments([{ ...base, events: [] }], 'tab-1')).toEqual([]);
  });
});

describe('a card drawn from a moment', () => {
  const moment = (over: Record<string, unknown> = {}) => ({
    kind: 'opened' as const,
    at: 100,
    profile: 'shopping',
    browser: base,
    ...over,
  });

  it('reads as an event, not a status light', () => {
    expect(browserMomentView(moment()).title).toMatch(/opened/i);
  });

  it('shouts while the summons is STILL live', () => {
    const view = browserMomentView(
      moment({
        kind: 'needs-you',
        reason: 'captcha',
        browser: { ...base, needsYou: { reason: 'captcha', at: 1 } },
      }),
    );
    expect(view.tone).toBe('blocked');
    expect(view.urgent).toBe(true);
    expect(view.action).toBe('Take the wheel');
  });

  it('STOPS shouting once you have answered it', () => {
    // The moment stays in the log forever — it happened. But a card that keeps
    // demanding attention for something dealt with an hour ago trains you to
    // ignore the one that matters.
    const view = browserMomentView(
      moment({ kind: 'needs-you', reason: 'captcha', browser: { ...base, needsYou: null } }),
    );
    expect(view.urgent).toBe(false);
    expect(view.tone).not.toBe('blocked');
    expect(view.title).toMatch(/needed you/i);
    expect(view.detail).toBe('captcha');
  });

  it('says you are driving when you are', () => {
    const view = browserMomentView(moment({ browser: { ...base, wheel: lease() } }));
    expect(view.tone).toBe('yours');
  });

  it('offers to watch while the agent drives', () => {
    const view = browserMomentView(
      moment({ browser: { ...base, wheel: lease({ holder: 'agent' as const }) } }),
    );
    expect(view.action).toBe('Watch');
  });

  it('cannot be opened once the browser is gone', () => {
    // The moment outlives the browser. Offering to open a viewer that is not
    // there is a connection error in an iframe, which reads as "muxpad broke".
    const view = browserMomentView(moment({ browser: { ...base, state: 'registered' as const } }));
    expect(view.action).toBeNull();
    expect(view.detail).toMatch(/closed|not running/i);
  });
});

describe('placing moments in a conversation', () => {
  const entry = (at: number | null, node: string) => ({ at, node });
  const m = (at: number): BrowserMoment => ({
    kind: 'opened',
    at,
    profile: 'shopping',
    browser: base,
  });
  const shape = (out: ReturnType<typeof injectBrowserMoments<string>>) => out.map((e) => e.node);

  it('lands a moment before the first entry that came after it', () => {
    const entries = [entry(100, 'a'), entry(300, 'b')];
    expect(shape(injectBrowserMoments(entries, [m(200)], () => '[card]'))).toEqual([
      'a',
      '[card]',
      'b',
    ]);
  });

  it('puts one that just happened at the BOTTOM, where it belongs', () => {
    const entries = [entry(100, 'a'), entry(200, 'b')];
    expect(shape(injectBrowserMoments(entries, [m(9_000)], () => '[card]'))).toEqual([
      'a',
      'b',
      '[card]',
    ]);
  });

  it('puts one older than the loaded history at the top', () => {
    const entries = [entry(500, 'a')];
    expect(shape(injectBrowserMoments(entries, [m(1)], () => '[card]'))).toEqual(['[card]', 'a']);
  });

  it('does not treat an untimed entry as a boundary', () => {
    // Guessing would move the card on the next reload.
    const entries = [entry(null, 'pending'), entry(300, 'b')];
    expect(shape(injectBrowserMoments(entries, [m(200)], () => '[card]'))).toEqual([
      'pending',
      '[card]',
      'b',
    ]);
  });

  it('keeps several moments in order', () => {
    const entries = [entry(100, 'a'), entry(400, 'b')];
    expect(shape(injectBrowserMoments(entries, [m(200), m(300)], (x) => `[${x.at}]`))).toEqual([
      'a',
      '[200]',
      '[300]',
      'b',
    ]);
  });

  it('changes nothing when there are no moments', () => {
    const entries = [entry(100, 'a'), entry(200, 'b')];
    expect(shape(injectBrowserMoments(entries, [], () => '[card]'))).toEqual(['a', 'b']);
  });
});
