import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, rerender: (next: React.ReactNode) => act(() => root.render(next)) };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

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
  it('reads as something that happened, not a status light', () => {
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    expect(host.textContent).toMatch(/opened|browser/i);
    expect(host.textContent).toContain('shopping');
  });

  it('shouts while the summons is still live', () => {
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
  });

  it('opens a MODAL on a wide viewport and a TAB on a phone', () => {
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
  });

  it('opens from ANYWHERE on it, even when it carries an Open button', () => {
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
  });

  it('opens ONCE when the button itself is clicked, not twice', () => {
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
  });

  it('does not announce a control inside a control', () => {
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

  it('shows how long the wheel is held for, and nothing when it is free', () => {
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

  it('shows the page when a still was captured', () => {
    // The difference between a card that CLAIMS the agent is stuck at a sign-in
    // and one that shows you the sign-in page.
    const img = shot('/api/browsers/s-abc/shot/2').querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/browsers/s-abc/shot/2');
  });

  it('draws no image element at all when there is none', () => {
    // Not an empty src — that is a request for the CURRENT page, which is how a
    // card ends up illustrating itself with the wrong thing.
    expect(shot(null).querySelector('img')).toBeNull();
  });

  it('carries an empty alt, because the words above already say it', () => {
    // The reason is right there on the card. A screen reader announcing a
    // filename on top of it is noise, not access.
    expect(shot('/api/browsers/s-abc/shot/2').querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('loads lazily, because a long chat can hold several', () => {
    expect(shot('/api/browsers/s-abc/shot/2').querySelector('img')?.getAttribute('loading')).toBe(
      'lazy',
    );
  });

  it('still shows the reason, so the picture illustrates rather than replaces', () => {
    expect(shot('/api/browsers/s-abc/shot/2').textContent).toContain('Amazon needs a login');
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
  it('offers the control on any card whose browser is still alive', () => {
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    expect(peek(host)).toBeDefined();
  });

  it('offers it on a card that is asking for a login too', () => {
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
  });

  it('offers no WIDEN until there is a picture to widen', () => {
    // There is nothing to make wider while the card is a line of text, and a
    // control that does nothing is worse than one that is not there.
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    expect(widen(host)).toBeUndefined();
    click(peek(host));
    expect(widen(host)).toBeDefined();
  });

  it('WIDENS the card, and the same control shrinks it back', () => {
    // "An expanded button that makes the card full width so I can see more of
    // the browser, and then the button turns into shrink back to regular size."
    // One control going both ways: a button that only ever grew, with
    // shrinking hidden somewhere else, is a state you cannot leave.
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    click(peek(host));
    expect(card(host).dataset.wide).toBeUndefined();
    click(widen(host));
    expect(card(host).dataset.wide).toBe('true');
    expect(widen(host)?.getAttribute('aria-pressed')).toBe('true');
    expect(widen(host)?.getAttribute('aria-label')).toMatch(/shrink/i);
    click(widen(host));
    expect(card(host).dataset.wide).toBeUndefined();
    expect(widen(host)?.getAttribute('aria-label')).toMatch(/widen/i);
  });

  it('forgets the width when the peek closes', () => {
    // A card that reopened at full width later, with no picture in it yet,
    // would be a banner across the conversation with one line of text in it.
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    click(peek(host));
    click(widen(host));
    expect(card(host).dataset.wide).toBe('true');
    click(peek(host));
    click(peek(host));
    expect(card(host).dataset.wide).toBeUndefined();
  });

  it('widening does not open the viewer', () => {
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
    click(peek(host));
    click(widen(host));
    expect(opened).toBe(0);
  });

  it('offers nothing to peek at once the browser is gone', () => {
    const { host } = mount(
      <BrowserCard moment={moment({ ...base, state: 'registered' })} onOpen={() => {}} now={1} />,
    );
    expect(peek(host)).toBeUndefined();
  });

  it('shows the CURRENT page, not the frozen still of the moment', () => {
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
    expect(shot(host)?.getAttribute('src')).toBe('/api/browsers/shopping/shot/100');
    click(peek(host));
    expect(shot(host)?.getAttribute('src')).toMatch(/\/api\/browsers\/shopping\/shot\?t=\d+/);
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
    click(peek(host));
    expect(shot(host)?.getAttribute('src')).toBe('/api/browsers/shopping/shot/100');
  });

  it('does NOT open the viewer — looking is not the same as taking over', () => {
    const onOpen = vi.fn();
    const { host } = mount(<BrowserCard moment={moment(base)} onOpen={onOpen} now={1} />);
    click(peek(host));
    expect(onOpen).not.toHaveBeenCalled();
    expect(peek(host)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the viewer when the PICTURE is clicked', () => {
    // The picture is what you were looking at when looking stopped being
    // enough, so it is the thing you reach for.
    const onOpen = vi.fn();
    const { host } = mount(
      <BrowserCard moment={moment(base)} onOpen={onOpen} viewportWidth={1440} now={1} />,
    );
    click(peek(host));
    click(shot(host) ?? undefined);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('modal');
  });

  it('is per card, so two browsers can be watched side by side', () => {
    const a = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    const b = mount(<BrowserCard moment={moment(base)} onOpen={() => {}} now={1} />);
    click(peek(a.host));
    expect(peek(a.host)?.getAttribute('aria-expanded')).toBe('true');
    expect(peek(b.host)?.getAttribute('aria-expanded')).toBe('false');
  });
});
