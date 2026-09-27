import { describe, expect, it } from 'vitest';
import {
  type BrowserCardData,
  type BrowserEvent,
  type BrowserMoment,
  type BrowserWheelLease,
  browserMomentView,
  browserMoments,
  browserOpenMode,
  browserOpenIntent,
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
      [
        {
          ...base,
          events: [
            ev('opened', 100, { tabId: 'tab-1' }),
            ev('needs-you', 500, { reason: 'captcha', tabId: 'tab-1' }),
          ],
        },
      ],
      'tab-1',
    );
    expect(moments.map((m) => [m.kind, m.at])).toEqual([
      ['opened', 100],
      ['needs-you', 500],
    ]);
  });

  it('keeps the reason on the summons, because that IS the card', () => {
    const [m] = browserMoments(
      [{ ...base, events: [ev('needs-you', 1, { reason: 'log in to Amazon', tabId: 'tab-1' })] }],
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

  it('hides one that belongs to NO chat', () => {
    // This was the other way round, and it was wrong. A moment with no chat —
    // a browser started from the CLI — showed in EVERY conversation, so opening
    // a brand-new chat greeted you with two cards about things that happened
    // somewhere else before it existed. A card has to be about THIS chat.
    expect(browserMoments([{ ...base, events: [ev('opened', 1)] }], 'tab-1')).toHaveLength(0);
  });

  it('shows nothing at all in a chat where nothing happened', () => {
    // The shape a new conversation must have: empty.
    const busy = {
      ...base,
      events: [ev('opened', 1, { tabId: 'old' }), ev('needs-you', 2, { tabId: 'old' })],
    };
    expect(browserMoments([busy], 'brand-new-tab')).toEqual([]);
  });

  it('drops "resolved" — it is bookkeeping, not something to read', () => {
    expect(
      browserMoments(
        [
          {
            ...base,
            events: [ev('opened', 1, { tabId: 'tab-1' }), ev('resolved', 2, { tabId: 'tab-1' })],
          },
        ],
        'tab-1',
      ),
    ).toHaveLength(1);
  });

  it('sorts across profiles by when they happened', () => {
    const a = { ...base, profile: 'a', events: [ev('opened', 300, { tabId: 'tab-1' })] };
    const b = { ...base, profile: 'b', events: [ev('opened', 100, { tabId: 'tab-1' })] };
    expect(browserMoments([a, b], 'tab-1').map((m) => m.profile)).toEqual(['b', 'a']);
  });

  it('carries the live browser with each moment, so the card can act', () => {
    // A card drawn from a moment still needs to open the CURRENT browser and
    // know who holds the wheel right now.
    const [m] = browserMoments(
      [{ ...base, events: [ev('opened', 1, { tabId: 'tab-1' })] }],
      'tab-1',
    );
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
    expect(browserMomentView(moment()).title).toMatch(/opened|browser/i);
  });

  it('shouts while the summons is STILL live', () => {
    const view = browserMomentView(
      moment({
        kind: 'needs-you',
        reason: 'captcha',
        browser: { ...base, needsYou: { reason: 'captcha', at: 1 } },
      }),
    );
    expect(view.tone).toBe('waiting');
    expect(view.urgent).toBe(true);
    expect(view.action).toBe('Open');
  });

  it('says you are driving when you are', () => {
    const view = browserMomentView(moment({ browser: { ...base, wheel: lease() } }));
    expect(view.tone).toBe('yours');
  });

  it('offers no button at all when it is only reporting, however the browser is used', () => {
    // These are notes: the browser opened, and somebody may or may not be
    // driving it. None of that is a request, so none of it gets a button — the
    // card takes the click itself for anyone who wants to look.
    for (const wheel of [null, lease(), lease({ holder: 'agent' as const })]) {
      const view = browserMomentView(moment({ browser: { ...base, wheel } }));
      expect(view.action).toBeNull();
      expect(view.openable).toBe(true);
    }
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

describe('what the card says, in as few words as possible', () => {
  const m = (over: Record<string, unknown> = {}): BrowserMoment => ({
    kind: 'opened',
    at: 1,
    profile: 's-01m3hwabcdef',
    browser: base,
    ...over,
  });

  it('does not put a session slug in front of a person', () => {
    // `Browser opened · s-01m3hw…` is a database key wearing a label. It says
    // nothing, and on a phone it ate the whole line.
    const view = browserMomentView(m());
    expect(view.title).toBe('Browser opened');
    expect(view.title).not.toContain('s-');
  });

  it('DOES name a profile a person chose', () => {
    expect(browserMomentView(m({ profile: 'shopping' })).title).toContain('shopping');
  });

  it('gives the summons NO title — the reason is the whole card', () => {
    const view = browserMomentView(
      m({
        kind: 'needs-you',
        reason: 'Amazon is signed out',
        browser: { ...base, needsYou: { reason: 'Amazon is signed out', at: 1 } },
      }),
    );
    // The colour, the mark and the button already say "your turn". A label
    // repeating it cost a line and, on a phone, pushed the reason onto a
    // second row.
    expect(view.title).toBe('');
    expect(view.detail).toBe('Amazon is signed out');
  });

  it('is NOT an error — that tone is reserved for things that broke', () => {
    // Red says "something went wrong". Nothing has: the agent reached a step
    // only a person can take, which is the system working.
    const view = browserMomentView(
      m({ kind: 'needs-you', browser: { ...base, needsYou: { reason: 'x', at: 1 } } }),
    );
    expect(view.tone).toBe('waiting');
    expect(view.urgent).toBe(true);
  });
});

describe('what the card shows, and what it leaves out', () => {
  const m = (over: Record<string, unknown> = {}): BrowserMoment => ({
    kind: 'opened',
    at: 1,
    profile: 's-abc',
    browser: base,
    ...over,
  });

  it('shows the countdown ONLY while you hold the wheel', () => {
    // It is your lease running out. On a card about something the agent did, or
    // about a browser nobody is driving, it is a number with no referent.
    expect(browserMomentView(m({ browser: { ...base, wheel: lease() } })).countdown).toBe(true);
    expect(browserMomentView(m()).countdown).toBe(false);
    expect(
      browserMomentView(m({ browser: { ...base, wheel: lease({ holder: 'agent' }) } })).countdown,
    ).toBe(false);
  });

  it('still shouts when the agent holds the wheel and is stuck', () => {
    const view = browserMomentView(
      m({
        kind: 'needs-you',
        reason: 'captcha',
        browser: { ...base, needsYou: { reason: 'x', at: 1 }, wheel: lease({ holder: 'agent' }) },
      }),
    );
    expect(view.urgent).toBe(true);
  });
});

describe('a card that is only telling you something', () => {
  const m = (over: Record<string, unknown> = {}): BrowserMoment => ({
    kind: 'opened',
    at: 1,
    profile: 's-abc',
    browser: base,
    ...over,
  });

  it('offers NO button when nothing needs you', () => {
    // "a browser opened" is a note. A button — even a quiet one — reads as a
    // thing to deal with, and 99% of the time there is nothing to deal with.
    const view = browserMomentView(m());
    expect(view.action).toBeNull();
    expect(view.passive).toBe(true);
  });

  it('is still openable, just not advertised', () => {
    // The card itself takes the click. Looking is always allowed; being asked
    // to look is what was wrong.
    expect(browserMomentView(m()).openable).toBe(true);
  });

  it('keeps the button when it is actually asking', () => {
    const view = browserMomentView(
      m({
        kind: 'needs-you',
        reason: 'Amazon needs a login',
        browser: { ...base, needsYou: { reason: 'x', at: 1 } },
      }),
    );
    expect(view.action).toBe('Open');
    expect(view.passive).toBe(false);
  });

  it('is neither openable nor actionable once the browser has gone', () => {
    const view = browserMomentView(m({ browser: { ...base, state: 'registered' } }));
    expect(view.action).toBeNull();
    expect(view.openable).toBe(false);
  });
});

describe('there are exactly two kinds of browser card', () => {
  const ev = (kind: BrowserEvent['kind'], at: number, over: Record<string, unknown> = {}) =>
    ({ kind, at, tabId: 'tab-1', ...over }) as BrowserEvent;

  it('shows the session starting, and a summons that is still live', () => {
    // One card when the browser session begins — context, and a way in. One
    // card when it needs you. Nothing else earns a line in a conversation.
    const moments = browserMoments(
      [
        {
          ...base,
          needsYou: { reason: 'Amazon needs a login', at: 500 },
          events: [ev('opened', 100), ev('needs-you', 500, { reason: 'Amazon needs a login' })],
        },
      ],
      'tab-1',
    );
    expect(moments.map((m) => m.kind)).toEqual(['opened', 'needs-you']);
  });

  it('DROPS a summons once it has been answered', () => {
    // "Handled" was a third kind of card explaining a state nobody asked about.
    // The asking is over; the record of it is the agent's reply, not a row.
    const moments = browserMoments(
      [
        {
          ...base,
          needsYou: null,
          events: [ev('opened', 100), ev('needs-you', 500), ev('resolved', 900)],
        },
      ],
      'tab-1',
    );
    expect(moments.map((m) => m.kind)).toEqual(['opened']);
  });

  it('keeps a LATER summons when an earlier one was answered', () => {
    // Resolution is per-moment, not per-browser: answering the first must not
    // silence the second.
    const moments = browserMoments(
      [
        {
          ...base,
          needsYou: { reason: 'and again', at: 1200 },
          events: [ev('needs-you', 500), ev('resolved', 900), ev('needs-you', 1200)],
        },
      ],
      'tab-1',
    );
    expect(moments).toHaveLength(1);
    expect(moments[0]?.at).toBe(1200);
  });
});


describe('what opening a card is meant to do', () => {
  const m = (over: Record<string, unknown> = {}): BrowserMoment => ({
    kind: 'opened', at: 1, profile: 's-abc', browser: base, ...over,
  });

  it('WATCHES when you open the session card', () => {
    // Looking over the agent's shoulder must not stop it working. Taking the
    // wheel to satisfy curiosity is a stall the agent cannot see the reason for.
    expect(browserOpenIntent(m())).toBe('watch');
  });

  it('DRIVES when you answer a summons', () => {
    // The agent asked for a person; arriving without the wheel would put you in
    // front of a page you cannot type into.
    expect(
      browserOpenIntent(
        m({ kind: 'needs-you', browser: { ...base, needsYou: { reason: 'x', at: 1 } } }),
      ),
    ).toBe('drive');
  });

  it('watches even while the agent is driving', () => {
    expect(browserOpenIntent(m({ browser: { ...base, wheel: lease({ holder: 'agent' }) } }))).toBe(
      'watch',
    );
  });

  it('puts the intent in the url, so a tab on a phone gets it too', () => {
    expect(browserViewerPath('default', 'watch')).toBe('/browser/default/?mode=watch');
    expect(browserViewerPath('default', 'drive')).toBe('/browser/default/');
  });
});

describe('finding the way back to a browser you are driving', () => {
  // A phone has a back button, and the viewer is a page. Tapping back lands you
  // in the conversation — and if answering the summons deleted the card, there
  // is no longer anything to tap, mid-login, with the agent still waiting.
  const held = (reason: string): BrowserCardData => ({
    profile: 's-abc',
    viewerUrl: 'https://host/browser/s-abc/',
    state: 'running',
    // Cleared: you arrived. The summons is no longer SHOUTING.
    needsYou: null,
    wheel: { holder: 'human', by: 'pane-1', takenAt: 0, expiresAt: 600_000 },
    events: [
      { kind: 'opened', at: 1, tabId: 'tab-1' },
      { kind: 'needs-you', at: 2, tabId: 'tab-1', reason },
    ],
  });

  it('keeps a card in the conversation while you hold the wheel', () => {
    const moments = browserMoments([held('log in')], 'tab-1');
    expect(moments.map((m) => m.kind)).toEqual(['opened', 'needs-you']);
  });

  it('still says what you came for, so the card is not a mystery', () => {
    const moments = browserMoments([held('log in to Amazon')], 'tab-1');
    const view = browserMomentView(moments[1] as BrowserMoment);
    expect(view.detail).toBe('log in to Amazon');
    expect(view.urgent).toBe(false);
    expect(view.openable).toBe(true);
  });

  it('reopens it in DRIVE mode — you are mid-task, not spectating', () => {
    // The bug this pins: needsYou is cleared the moment you arrive, so intent
    // read from it alone sends you back into a viewer that refuses your typing.
    const moments = browserMoments([held('log in')], 'tab-1');
    expect(browserOpenIntent(moments[1] as BrowserMoment)).toBe('drive');
  });

  it('and it goes once you hand the browser back', () => {
    const b = held('log in');
    const done: BrowserCardData = {
      ...b,
      wheel: null,
      events: [...(b.events ?? []), { kind: 'resolved', at: 3, tabId: 'tab-1' }],
    };
    expect(browserMoments([done], 'tab-1').map((m) => m.kind)).toEqual(['opened']);
  });
});
