import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCardData } from '../lib/browser-card';
import { BrowserCard } from './BrowserCard';
import { BrowserModal } from './BrowserModal';

/**
 * The card and the modal.
 *
 * The claims worth holding, in the order they matter:
 *
 *   1. the BLOCKED state is loud, and it is the only loud one — a card that
 *      always shouts is a card nobody reads;
 *   2. a phone gets a tab, not a modal, because a modal on a phone is the one
 *      shape guaranteed not to work for the thing you opened it to do;
 *   3. a browser that is not running gets STARTED, not opened — opening the
 *      viewer of a dead host is a connection-refused inside an iframe, which
 *      reads as "muxpad is broken";
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
  return {
    host,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
  };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')];
const buttonNamed = (host: HTMLElement, label: string) =>
  buttons(host).find((b) => b.textContent === label);
const click = (el: Element | undefined) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

const base: BrowserCardData = {
  profile: 'shopping',
  viewerUrl: 'http://127.0.0.1:9510',
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

describe('the card', () => {
  it('renders the blocked state loudly and offers the wheel', () => {
    const { host } = mount(
      <BrowserCard
        data={{ ...base, needsYou: { reason: 'log in to Amazon', at: 1 } }}
        onOpen={() => {}}
        now={1_000_000}
      />,
    );
    expect(host.querySelector('[data-testid="browser-card"]')?.getAttribute('data-tone')).toBe(
      'blocked',
    );
    expect(host.textContent).toContain('log in to Amazon');
    expect(buttonNamed(host, 'Take the wheel')?.dataset.urgent).toBe('true');
  });

  it('is the ONLY state with an urgent button', () => {
    for (const data of [
      base,
      { ...base, wheel: lease() },
      { ...base, wheel: lease({ holder: 'agent' as const }) },
      { ...base, state: 'registered' as const },
    ]) {
      const { host } = mount(<BrowserCard data={data} onOpen={() => {}} now={1_000_000} />);
      expect(buttons(host)[0]?.dataset.urgent, JSON.stringify(data.wheel ?? data.state)).toBe(
        'false',
      );
    }
  });

  it('opens a MODAL on a wide viewport and a TAB on a phone', () => {
    const onOpen = vi.fn();
    const wide = mount(<BrowserCard data={base} onOpen={onOpen} viewportWidth={1440} now={1} />);
    click(buttons(wide.host)[0]);
    expect(onOpen).toHaveBeenCalledWith('modal');

    const phone = mount(<BrowserCard data={base} onOpen={onOpen} viewportWidth={390} now={1} />);
    click(buttons(phone.host)[0]);
    expect(onOpen).toHaveBeenLastCalledWith('tab');
  });

  it('shows how long the wheel is held for, and nothing when it is free', () => {
    const held = mount(
      <BrowserCard data={{ ...base, wheel: lease() }} onOpen={() => {}} now={1_000_000} />,
    );
    expect(held.host.textContent).toContain('10m left');

    const free = mount(<BrowserCard data={base} onOpen={() => {}} now={1_000_000} />);
    expect(free.host.textContent).not.toContain('left');
  });

  it('names the profile, so two cards are tellable apart', () => {
    const { host } = mount(
      <BrowserCard data={{ ...base, profile: 'research' }} onOpen={() => {}} now={1} />,
    );
    expect(host.textContent).toContain('research');
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

  it('frames the viewer url rather than re-rendering the page itself', () => {
    const { host } = mount(<BrowserModal {...props} />);
    const frame = host.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('http://127.0.0.1:9510');
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
