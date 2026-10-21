import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCardData, BrowserMoment } from '../lib/browser-card';
import { BrowserCard } from './BrowserCard';
import { BrowserModal } from './BrowserModal';

/**
 * A browser moment in a conversation, and the modal it opens.
 *
 * The claims worth holding, in the order they matter:
 *
 *   1. a LIVE summons is loud, and an ANSWERED one is not — the moment stays in
 *      the log forever, but a card still demanding attention for something
 *      dealt with an hour ago trains you to ignore the one that counts;
 *   2. a phone gets a tab, not a modal, because a modal on a phone is the one
 *      shape guaranteed not to work for the thing you opened it to do;
 *   3. a moment whose browser is gone offers no action — opening a viewer that
 *      is not running is a connection error inside an iframe, which reads as
 *      "muxpad is broken";
 *   4. the lease is renewed from the modal, halfway through, because a person
 *      with the modal open is the only evidence a person is still there.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hosts: HTMLElement[] = [];
/** UNMOUNTED, not just detached. A card's preview now opens itself, so every
 *  mount starts a capture loop; removing the host node left those effects
 *  running and their fetches landing after the test had finished, which React
 *  reports as a state update outside act(). Unmounting runs the cleanup. */
const roots: Array<{ unmount: () => void }> = [];

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return { host, rerender: (next: React.ReactNode) => act(() => root.render(next)) };
}

/**
 * THE LIVE FRAME ARRIVES AS BYTES, so the test has to supply bytes.
 *
 * The peek fetches each frame as a blob and points the element at an object
 * URL — see `useLiveShot` for why: an <img> whose `src` changes blanks until
 * the next response lands, which is the flash. jsdom has neither
 * `createObjectURL` nor a network, so both are stood up here. `shotFetches`
 * keeps what was asked for, which is the part worth asserting: the ROUTE is
 * still the live one, whatever the element ends up holding.
 */
let shotFetches: string[] = [];
let objectUrls = 0;
beforeEach(() => {
  shotFetches = [];
  objectUrls = 0;
  URL.createObjectURL = () => `blob:mock/${++objectUrls}`;
  URL.revokeObjectURL = () => {};
  // DECODE IS STUBBED, BECAUSE INHERITING IT MADE THE SUITE ENVIRONMENT-
  // DEPENDENT. The card decodes each frame off-screen before swapping it in,
  // to avoid the blank between `src` and the bytes being ready. The jsdom
  // installed here has NO decode(), so that step vanished and every test
  // passed; CI's jsdom has one that never settles for a URL it cannot load, so
  // the frame was withheld for the full decode budget and seven tests failed
  // there — twice, because the first fix corrected the CODE and left the
  // suite still inheriting whatever the environment happened to provide.
  // A test that only passes on one machine's jsdom is not a test.
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decode() {
        return Promise.resolve();
      }
    },
  );
  // AND THE OBSERVER, WHICH IS WHAT ACTUALLY MADE CI RED.
  //
  // The card suppresses captures while it is off screen, decided by an
  // IntersectionObserver — and falls back to "always visible" where there is
  // none. The jsdom installed here HAS none, so the gate never engaged and
  // every test passed. CI's does, and in a DOM with no layout nothing is ever
  // intersecting, so it reported off-screen, every capture was skipped, and
  // ten tests failed on a card that was working exactly as designed.
  //
  // A stub that says "on screen" is the honest environment for these tests:
  // they are about what the card does when somebody is looking at it. The
  // off-screen case has its own test, which installs its own observer.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {
        queueMicrotask(() => cb([{ isIntersecting: true }]));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // NO `Response` ROUND TRIP. This wrapped the blob in a real Response and
  // read it back with `.blob()` — which works here and came back EMPTY on CI,
  // so every capture fetched, found a zero-size body, and returned before
  // creating an object URL. The card then had nothing to show and ten tests
  // failed on a component that was behaving correctly.
  //
  // Diagnosed by printing the environment from inside the run rather than
  // guessing a sixth time: `fetches: 1, urls: 0, src: null` says the fetch
  // happened and `createObjectURL` was never reached, which leaves exactly
  // one step in between. The stub hands the blob straight back now, so there
  // is no serialisation for a platform to disagree about.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    shotFetches.push(String(input));
    return {
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    };
  });
});

afterEach(async () => {
  // DRAIN, THEN UNMOUNT. A card's preview opens itself, so every mount has a
  // capture in flight: fetch → blob → decode → setShown. A test that asserts
  // something synchronous ends with that chain part-way through, and whichever
  // half lands outside act() is reported as a state update outside act().
  // Letting it finish first, inside act, is the whole fix — unmounting alone
  // still raced the continuation that was already past its `alive` check.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.unstubAllGlobals();
  for (const host of hosts.splice(0)) host.remove();
});

/**
 * Let the queued capture settle, the way a real frame would.
 *
 * COUNTING MICROTASKS IS GUESSING, and this guessed three. The chain is fetch
 * → blob → object URL → decode → setState, and every link is a promise whose
 * hop count is an implementation detail of whatever `fetch`, `Response` and
 * `Image` happen to be. Adding the decode step pushed it past three, which
 * showed up as ten failures on CI and none here — the same machine-dependence
 * that has now bitten this file twice.
 *
 * Draining generously is the fix: forty ticks cost microseconds and do not
 * care how many hops the chain actually takes. If a future change needs more
 * than forty, something is looping, not settling.
 */
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
};

const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')];
/** The primary action, by name — a card now carries a peek control too. */
const action = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('.browser-card__action') ?? undefined;
const peek = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('.browser-card__peek') ?? undefined;
/** Widen — the step between the thumbnail and the viewer. */
const widen = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('.browser-card__wide') ?? undefined;
const card = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[data-testid="browser-card"]') as HTMLElement;
const shot = (host: HTMLElement) => host.querySelector<HTMLImageElement>('.browser-card__shot');
const click = (el: Element | undefined) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

const base: BrowserCardData = {
  profile: 'shopping',
  viewerUrl: 'https://host.ts.net/browser/shopping/',
  state: 'running',
  wheel: null,
};

const lease = (over: Partial<NonNullable<BrowserCardData['wheel']>> = {}) => ({
  holder: 'human' as const,
  by: 'pane-7',
  takenAt: 1_000_000,
  expiresAt: 1_600_000,
  ...over,
});

const moment = (browser: BrowserCardData, over: Partial<BrowserMoment> = {}): BrowserMoment => ({
  kind: 'opened',
  at: 100,
  shotUrl: null,
  answered: false,
  profile: browser.profile,
  browser,
  ...over,
});

describe('the card', () => {
  it('reads as something that happened, not a status light', async () => {
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    expect(host.textContent).toMatch(/opened|browser/i);
    expect(host.textContent).toContain('shopping');
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('shouts while the summons is still live', async () => {
    const browser = { ...base, needsYou: { reason: 'log in to Amazon', at: 1 } };
    const { host } = mount(
      <BrowserCard
        moment={moment(browser, { kind: 'needs-you', reason: 'log in to Amazon' })}
        onOpen={() => {}}
        now={1}
      />,
    );
    expect(host.querySelector('[data-testid="browser-card"]')?.getAttribute('data-tone')).toBe(
      'waiting',
    );
    expect(host.textContent).toContain('log in to Amazon');
    expect(action(host)?.dataset.urgent).toBe('true');
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('opens a MODAL on a wide viewport and a TAB on a phone', async () => {
    // Clicking the CARD, because a passive one carries no button.
    const onOpen = vi.fn();
    const wide = mount(
      <BrowserCard moment={moment(base)} onOpen={onOpen} viewportWidth={1440} now={1} />,
    );
    click(wide.host.querySelector('[data-testid="browser-card"]') ?? undefined);
    expect(onOpen).toHaveBeenCalledWith('modal');

    const phone = mount(
      <BrowserCard moment={moment(base)} onOpen={onOpen} viewportWidth={390} now={1} />,
    );
    click(phone.host.querySelector('[data-testid="browser-card"]') ?? undefined);
    expect(onOpen).toHaveBeenLastCalledWith('tab');
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('opens from ANYWHERE on it, even when it carries an Open button', async () => {
    // The button is a 60px target inside a 400px card that plainly is one
    // thing you can open. "Make it so clicking anywhere in this card opens it."
    const onOpen = vi.fn();
    const browser = { ...base, needsYou: { reason: 'log in to HubSpot', at: 1 } };
    const { host } = mount(
      <BrowserCard
        moment={moment(browser, { kind: 'needs-you', reason: 'log in to HubSpot' })}
        onOpen={onOpen}
        viewportWidth={1440}
        now={1}
      />,
    );
    const card = host.querySelector('[data-testid="browser-card"]');
    expect(action(host)?.dataset.urgent).toBe('true');
    click(card ?? undefined);
    expect(onOpen).toHaveBeenCalledTimes(1);
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('opens ONCE when the button itself is clicked, not twice', async () => {
    // The click bubbles to the card, which now opens too.
    const onOpen = vi.fn();
    const browser = { ...base, needsYou: { reason: 'log in to HubSpot', at: 1 } };
    const { host } = mount(
      <BrowserCard
        moment={moment(browser, { kind: 'needs-you', reason: 'log in to HubSpot' })}
        onOpen={onOpen}
        viewportWidth={1440}
        now={1}
      />,
    );
    click(action(host));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('does not announce a control inside a control', async () => {
    // A role="button" wrapping a real button is one control containing
    // another, and gives the same action two tab stops. The button IS the
    // keyboard control when there is one; the card click is for pointers.
    const browser = { ...base, needsYou: { reason: 'log in', at: 1 } };
    const withButton = mount(
      <BrowserCard
        moment={moment(browser, { kind: 'needs-you', reason: 'log in' })}
        onOpen={() => {}}
        now={1}
      />,
    );
    const card = withButton.host.querySelector('[data-testid="browser-card"]');
    expect(card?.getAttribute('role')).toBeNull();
    expect(card?.getAttribute('tabindex')).toBeNull();

    // A passive card has no button, so it keeps the role and the tab stop.
    const passive = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    expect(passive.host.querySelector('[data-testid="browser-card"]')?.getAttribute('role')).toBe(
      'button',
    );
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('a card with nothing to show is not clickable at all', () => {
    const onOpen = vi.fn();
    const { host } = mount(
      <BrowserCard moment={moment({ ...base, state: 'registered' })} onOpen={onOpen} now={1} />,
    );
    click(host.querySelector('[data-testid="browser-card"]') ?? undefined);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('offers nothing once the browser is gone', () => {
    const { host } = mount(
      <BrowserCard moment={moment({ ...base, state: 'registered' })} onOpen={() => {}} now={1} />,
    );
    expect(buttons(host)).toHaveLength(0);
    expect(host.textContent).toMatch(/closed/i);
  });

  it('shows how long the wheel is held for, and nothing when it is free', async () => {
    const held = mount(
      <BrowserCard
        moment={moment({ ...base, wheel: lease() })}
        onOpen={() => {}}
        now={1_000_000}
      />,
    );
    expect(held.host.textContent).toContain('10m left');

    const free = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1_000_000} />);
    expect(free.host.textContent).not.toContain('left');
    await settle(); // the preview opens itself; let its frame land inside act
  });
});

describe('the modal', () => {
  const props = {
    data: { ...base, wheel: lease() },
    by: 'pane-7',
    onClose: () => {},
    onRenew: () => {},
    now: () => 1_000_000,
  };

  it('frames the viewer RELATIVELY, so it is same-origin either way', () => {
    const { host } = mount(<BrowserModal {...props} />);
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('/browser/shopping/?by=pane-7');
  });

  it('says plainly that watching does not stop the agent', () => {
    // The whole reason watch mode exists: opening the session card must not
    // read as "I have now taken this over".
    const watching = mount(<BrowserModal {...props} intent="watch" />);
    expect(watching.host.textContent).toContain('watching');
    expect(watching.host.textContent).toMatch(/agent keeps working/i);

    const driving = mount(<BrowserModal {...props} intent="drive" />);
    expect(driving.host.textContent).toContain('you have the wheel');
  });

  it('frames the viewer read-only when watching', () => {
    const { host } = mount(<BrowserModal {...props} intent="watch" />);
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe(
      '/browser/shopping/?mode=watch&by=pane-7',
    );
  });

  it('closes on Escape, which is how the wheel gets handed back', () => {
    // Bound on the DOCUMENT: focus lives inside a cross-origin iframe for most
    // of this component's life, and a keydown there reaches no React handler.
    const onClose = vi.fn();
    mount(<BrowserModal {...props} onClose={onClose} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when the scrim is clicked', () => {
    const onClose = vi.fn();
    const { host } = mount(<BrowserModal {...props} onClose={onClose} />);
    click(host.querySelector('.browser-modal__scrim') ?? undefined);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renews once the lease is half gone, not at the last moment', () => {
    vi.useFakeTimers();
    const onRenew = vi.fn();
    const { rerender } = mount(
      <BrowserModal {...props} onRenew={onRenew} now={() => 1_100_000} intervalMs={1000} />,
    );
    act(() => vi.advanceTimersByTime(1100));
    expect(onRenew).not.toHaveBeenCalled();

    rerender(<BrowserModal {...props} onRenew={onRenew} now={() => 1_400_000} intervalMs={1000} />);
    act(() => vi.advanceTimersByTime(1100));
    expect(onRenew).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('the picture on the card', () => {
  const shot = (shotUrl: string | null) =>
    mount(
      <BrowserCard
        moment={moment(
          { ...base, needsYou: { reason: 'Amazon needs a login', at: 2 } },
          { kind: 'needs-you', reason: 'Amazon needs a login', shotUrl },
        )}
        onOpen={() => {}}
        now={1}
      />,
    ).host;

  it('shows the page when a still was captured', async () => {
    // The difference between a card that CLAIMS the agent is stuck at a sign-in
    // and one that shows you the sign-in page.
    const img = shot('/api/browsers/s-abc/shot/2').querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/browsers/s-abc/shot/2');
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('draws no image element at all when there is none', async () => {
    // Not an empty src — that is a request for the CURRENT page, which is how a
    // card ends up illustrating itself with the wrong thing.
    expect(shot(null).querySelector('img')).toBeNull();
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('carries an empty alt, because the words above already say it', async () => {
    // The reason is right there on the card. A screen reader announcing a
    // filename on top of it is noise, not access.
    expect(shot('/api/browsers/s-abc/shot/2').querySelector('img')?.getAttribute('alt')).toBe('');
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('loads lazily, because a long chat can hold several', async () => {
    expect(shot('/api/browsers/s-abc/shot/2').querySelector('img')?.getAttribute('loading')).toBe(
      'lazy',
    );
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('still shows the reason, so the picture illustrates rather than replaces', async () => {
    expect(shot('/api/browsers/s-abc/shot/2').textContent).toContain('Amazon needs a login');
    await settle(); // the preview opens itself; let its frame land inside act
  });
});

describe('Done pressed inside the viewer closes the modal around it', () => {
  /**
   * The viewer has its own Done — it is the only one a phone gets, since there is
   * no dialog around it there. On a desktop it released the wheel and could do
   * nothing else, because it is in a frame: "I clicked done then had to close."
   * Two close buttons, one of which only half worked.
   */
  const lease = () => ({ holder: 'human' as const, by: 'pane-7', takenAt: 0, expiresAt: 9e12 });
  const open = (onClose: () => void) =>
    mount(
      <BrowserModal
        data={{ ...base, wheel: lease() }}
        by="pane-7"
        onClose={onClose}
        onRenew={() => {}}
        now={() => 1_000_000}
      />,
    );
  const say = (data: unknown, origin = window.location.origin) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin }));
    });

  it('closes when the viewer asks', () => {
    const onClose = vi.fn();
    open(onClose);
    say({ muxpad: 'handback' });
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores a message from anywhere else', () => {
    // A listener on the window accepts messages from any frame on the page by
    // default, and this one closes things.
    const onClose = vi.fn();
    open(onClose);
    say({ muxpad: 'handback' }, 'https://evil.example');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores messages that are not about handing back', () => {
    const onClose = vi.fn();
    open(onClose);
    say({ other: 'thing' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * PEEKING — "what is it doing right now?", answered in the chat.
 *
 * A still rather than a stream: a live screencast per card is a socket and a
 * frame rate per card, and the question is answered by a picture every couple
 * of seconds. It never takes the wheel, so the agent carries on working while
 * somebody looks over its shoulder.
 */
describe('peeking at a live browser', () => {
  it('offers the control on any card whose browser is still alive', async () => {
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    expect(peek(host)).toBeDefined();
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('offers it on a card that is asking for a login too', async () => {
    // Those carry an Open button as well: looking first is allowed.
    const browser = { ...base, needsYou: { reason: 'log in', at: 1 } };
    const { host } = mount(
      <BrowserCard
        moment={moment(browser, { kind: 'needs-you', reason: 'log in' })}
        onOpen={() => {}}
        now={1}
      />,
    );
    expect(peek(host)).toBeDefined();
    expect(action(host)).toBeDefined();
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('shows the page without being asked', async () => {
    // THE DEFAULT. A card used to be a line of text with a chevron, and the
    // picture — the part that answers "what is it doing" — was one tap away on
    // every single card. Asked for directly: browser cards should always show
    // their small preview rather than being fully collapsed.
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    expect(peek(host)?.getAttribute('aria-expanded')).toBe('true');
    await settle();
    expect(shot(host)?.getAttribute('src')).toMatch(/^blob:/);
  });

  it('offers no WIDEN until there is a picture to widen', async () => {
    // There is nothing to make wider before the first frame lands, and a
    // control that does nothing is worse than one that is not there.
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    expect(widen(host)).toBeUndefined();
    await settle();
    expect(widen(host)).toBeDefined();
  });

  it('closes, and stays closed, when the chevron says so', async () => {
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    await settle();
    click(peek(host));
    expect(peek(host)?.getAttribute('aria-expanded')).toBe('false');
    expect(shot(host)).toBeNull();
  });

  it('WIDENS the card, and the same control shrinks it back', async () => {
    // "An expanded button that makes the card full width so I can see more of
    // the browser, and then the button turns into shrink back to regular size."
    // One control going both ways: a button that only ever grew, with
    // shrinking hidden somewhere else, is a state you cannot leave.
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    await settle();
    expect(card(host).dataset.wide).toBeUndefined();
    click(widen(host));
    expect(card(host).dataset.wide).toBe('true');
    expect(widen(host)?.getAttribute('aria-pressed')).toBe('true');
    expect(widen(host)?.getAttribute('aria-label')).toMatch(/shrink/i);
    click(widen(host));
    expect(card(host).dataset.wide).toBeUndefined();
    expect(widen(host)?.getAttribute('aria-label')).toMatch(/widen/i);
  });

  it('forgets the width when the peek closes', async () => {
    // A card that reopened at full width later, with no picture in it yet,
    // would be a banner across the conversation with one line of text in it.
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    await settle();
    click(widen(host));
    expect(card(host).dataset.wide).toBe('true');
    click(peek(host)); // closed
    click(peek(host)); // and open again
    await settle();
    expect(card(host).dataset.wide).toBeUndefined();
  });

  it('widening does not open the viewer', async () => {
    // Everything on this card falls through to the card's own click, which
    // opens a window. Looking harder must stay looking.
    let opened = 0;
    const { host } = mount(
      <BrowserCard
        moment={moment(base)}
        onOpen={() => {
          opened += 1;
        }}
        now={1}
      />,
    );
    await settle();
    click(widen(host));
    expect(opened).toBe(0);
  });

  it('offers nothing to peek at once the browser is gone', () => {
    const { host } = mount(
      <BrowserCard moment={moment({ ...base, state: 'registered' })} onOpen={() => {}} now={1} />,
    );
    expect(peek(host)).toBeUndefined();
  });

  it('shows the CURRENT page, not the frozen still of the moment', async () => {
    // Two pictures of one browser, one of them minutes old, is a card asking
    // you to work out which is which. A summons card is the one that carries a
    // frozen still while its browser is still alive.
    const browser = { ...base, needsYou: { reason: 'log in', at: 1 } };
    const { host } = mount(
      <BrowserCard
        moment={moment(browser, {
          kind: 'needs-you',
          reason: 'log in',
          shotUrl: '/api/browsers/shopping/shot/100',
        })}
        onOpen={() => {}}
        now={1}
      />,
    );
    // The frozen still is what the card has until the first live frame lands.
    expect(shot(host)?.getAttribute('src')).toBe('/api/browsers/shopping/shot/100');
    await settle();
    // THE ROUTE is the live one — the element holds the bytes it answered with.
    expect(shotFetches.some((u) => /\/api\/browsers\/shopping\/shot\?t=\d+/.test(u))).toBe(true);
    expect(shot(host)?.getAttribute('src')).toMatch(/^blob:/);
  });

  it('collapses back to the frozen still', () => {
    const browser = { ...base, needsYou: { reason: 'log in', at: 1 } };
    const { host } = mount(
      <BrowserCard
        moment={moment(browser, {
          kind: 'needs-you',
          reason: 'log in',
          shotUrl: '/api/browsers/shopping/shot/100',
        })}
        onOpen={() => {}}
        now={1}
      />,
    );
    click(peek(host));
    expect(shot(host)?.getAttribute('src')).toBe('/api/browsers/shopping/shot/100');
  });

  it('does NOT open the viewer — looking is not the same as taking over', async () => {
    const onOpen = vi.fn();
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={onOpen} now={1} />);
    click(peek(host)); // closed
    click(peek(host)); // open again
    expect(onOpen).not.toHaveBeenCalled();
    expect(peek(host)?.getAttribute('aria-expanded')).toBe('true');
    await settle(); // the preview opens itself; let its frame land inside act
  });

  it('opens the viewer when the PICTURE is clicked', async () => {
    // The picture is what you were looking at when looking stopped being
    // enough, so it is the thing you reach for.
    const onOpen = vi.fn();
    const { host } = mount(
      <BrowserCard moment={moment(base)} onOpen={onOpen} viewportWidth={1440} now={1} />,
    );
    await settle();
    click(shot(host) ?? undefined);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('modal');
  });

  it('is per card, so two browsers can be watched side by side', async () => {
    const a = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    const b = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    click(peek(a.host));
    expect(peek(a.host)?.getAttribute('aria-expanded')).toBe('false');
    expect(peek(b.host)?.getAttribute('aria-expanded')).toBe('true');
    await settle();
  });

  it('decodes the next frame BEFORE putting it on the card', async () => {
    // THE FLICKER, stated as a property. Fetching the frame as a blob was only
    // half the job: pointing an <img> at any new src — a blob URL included —
    // puts the element back into "no image available" until the bytes are
    // decoded, and it paints nothing until then. Measured in Chrome over 20
    // swaps: blank on 20 of 20 without this, 0 of 20 with it. Reported as
    // "flickers every 2.5s".
    let release: (() => void) | null = null;
    const decoding = new Promise<void>((done) => {
      release = done;
    });
    const original = globalThis.Image;
    (globalThis as unknown as { Image: unknown }).Image = class {
      src = '';
      decode() {
        return decoding;
      }
    };
    try {
      const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
      await settle();
      // The frame has been fetched and is decoding — and the card is still
      // showing nothing rather than a half-swapped element.
      expect(shotFetches.length).toBeGreaterThan(0);
      expect(shot(host)).toBeNull();
      await act(async () => {
        release?.();
        await decoding;
      });
      await settle();
      expect(shot(host)?.getAttribute('src')).toMatch(/^blob:/);
    } finally {
      globalThis.Image = original;
    }
  });

  it('keeps one capture in flight across timer ticks and visibility wake-ups', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetchFrame = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchFrame);
    try {
      mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
      expect(fetchFrame).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(fetchFrame).toHaveBeenCalledTimes(1);
      // A failed capture must release the guard too.
      await act(async () => {
        finish(new Response(null, { status: 503 }));
      });
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      expect(fetchFrame).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a pending capture when the preview closes', async () => {
    const fetchFrame = vi.fn(
      (_url: unknown, _options?: RequestInit) => new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', fetchFrame);
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    const signal = fetchFrame.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    click(peek(host));
    expect(signal?.aborted).toBe(true);
  });

  it('keeps the capture busy until image decoding finishes', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        decode() {
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    );
    try {
      mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
      await settle();
      expect(shotFetches).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(shotFetches).toHaveLength(1);
      await act(async () => {
        release();
      });
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      expect(shotFetches).toHaveLength(2);
      await settle();
      await act(async () => {
        release();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the frame even when decode() never answers', async () => {
    /**
     * THE ENVIRONMENT DEPENDENCY THAT CI FOUND AND THIS SUITE DID NOT.
     *
     * `decode()` is an optimisation: it avoids the blank frame between
     * assigning `src` and the bytes being ready. Awaited bare it becomes a
     * REQUIREMENT, and an implementation that never settles hides the card
     * completely. These tests passed locally only because the installed jsdom
     * has no decode() at all, so the await was skipped — green for the wrong
     * reason, while CI's jsdom had one that never resolved and seven tests
     * failed there.
     *
     * So this stands one up that never answers, and asserts the picture
     * arrives anyway.
     */
    const original = globalThis.Image;
    (globalThis as unknown as { Image: unknown }).Image = class {
      src = '';
      decode() {
        return new Promise<void>(() => {}); // never settles, like CI's
      }
    };
    vi.useFakeTimers();
    try {
      const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
      await settle();
      // Still nothing: the budget has not elapsed and decode has not answered.
      expect(shot(host)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await settle();
      expect(shot(host)?.getAttribute('src')).toMatch(/^blob:/);
    } finally {
      vi.useRealTimers();
      globalThis.Image = original;
    }
  });

  it('captures nothing while the card is scrolled out of view', async () => {
    // THE COST CONTROL FOR THE DEFAULT ABOVE. Previews open themselves now, so
    // a long conversation can hold a dozen; each capture is a real CDP round
    // trip into a real page, and a card three screens up is a round trip for
    // nobody. jsdom has no IntersectionObserver, so the card falls back to
    // "always visible" — this stands one up and reports the card as off
    // screen.
    const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    const original = globalThis.IntersectionObserver;
    // A two-method stub, not the DOM type — the card only ever constructs it,
    // observes one element and disconnects.
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    };
    vi.useFakeTimers();
    try {
      const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
      await settle();
      const taken = shotFetches.length;
      expect(taken).toBeGreaterThan(0);
      act(() => {
        for (const cb of observers) cb([{ isIntersecting: false }]);
      });
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(shotFetches.length).toBe(taken);
      expect(shot(host)?.getAttribute('src')).toMatch(/^blob:/); // the last frame stays
    } finally {
      vi.useRealTimers();
      globalThis.IntersectionObserver = original;
    }
  });
});
