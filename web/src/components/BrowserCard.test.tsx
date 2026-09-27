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
    expect(buttons(host)[0]?.dataset.urgent).toBe('true');
  });

  it('STOPS shouting once it has been answered', () => {
    const { host } = mount(
      <BrowserCard
        moment={moment({ ...base, needsYou: null }, { kind: 'needs-you', reason: 'captcha' })}
        onOpen={() => {}}
        now={1}
      />,
    );
    expect(host.querySelector('[data-testid="browser-card"]')?.getAttribute('data-tone')).not.toBe(
      'waiting',
    );
    expect(buttons(host)[0]?.dataset.urgent).toBe('false');
    expect(host.textContent).toMatch(/handled/i);
  });

  it('opens a MODAL on a wide viewport and a TAB on a phone', () => {
    const onOpen = vi.fn();
    const wide = mount(
      <BrowserCard moment={moment(base)} onOpen={onOpen} viewportWidth={1440} now={1} />,
    );
    click(buttons(wide.host)[0]);
    expect(onOpen).toHaveBeenCalledWith('modal');

    const phone = mount(
      <BrowserCard moment={moment(base)} onOpen={onOpen} viewportWidth={390} now={1} />,
    );
    click(buttons(phone.host)[0]);
    expect(onOpen).toHaveBeenLastCalledWith('tab');
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
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('/browser/shopping/');
  });

  it('says whether the wheel is YOURS or you are only watching', () => {
    const mine = mount(<BrowserModal {...props} />);
    expect(mine.host.textContent).toContain('you have the wheel');

    const theirs = mount(<BrowserModal {...props} by="someone-else" />);
    expect(theirs.host.textContent).toContain('watching');
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
