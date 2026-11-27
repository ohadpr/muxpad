import { type ReactNode, act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE RIBBON UNDER A CHAT — "maintain the bottom ribbon bar in chat windows
 * as well, not just in the chat list."
 *
 * Two defects an adversarial review reproduced, neither visible to the pure
 * helper and source-text tests that were all this had:
 *
 *   1. tapping a section from inside a chat landed on the section the kept
 *      list had been on BEFORE, because the list reads the stored section
 *      once at mount (it is a store now — lib/mobile-section.ts);
 *   2. it PUSHED /chats, making the stack list → chat → list, so the OS back
 *      gesture on the apparent root dived back into the chat you just left.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = '/w/a/t/b';
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname } }),
}));
vi.mock('../lib/use-unread', () => ({ useUnreadCorpus: () => [] }));
vi.mock('../lib/chat-sections', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  unreadChats: () => [],
}));

const { MobileChatSectionBar } = await import('./MobileNav');
const { readSection, writeSection } = await import('../lib/mobile-section');

describe('the chat view’s section ribbon', () => {
  let host: HTMLDivElement;
  let root: Root;

  const mount = (onLeave: () => void) => {
    act(() => {
      root.render(<MobileChatSectionBar onLeave={onLeave} />);
    });
    return host;
  };
  const tab = (label: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as
      | HTMLButtonElement
      | undefined;

  beforeEach(() => {
    pathname = '/w/a/t/b';
    sessionStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('records the section it was asked for, and leaves by the back-to-list walk', () => {
    const onLeave = vi.fn();
    writeSection('home');
    mount(onLeave);
    act(() => tab('Unread')?.click());
    expect(readSection()).toBe('unread');
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('marks the section you came from while you are in the chat', () => {
    writeSection('activity');
    mount(() => {});
    expect(tab('Activity')?.getAttribute('aria-current')).toBe('page');
    expect(tab('Home')?.getAttribute('aria-current')).toBeNull();
  });

  it('marks nothing while a destination PAGE owns the current mark', () => {
    pathname = '/cards';
    writeSection('home');
    mount(() => {});
    expect([...host.querySelectorAll('button[aria-current="page"]')]).toEqual([]);
  });
});

/**
 * THE SAME TAP-EATING FOCUS CHANGE, ON THE BAR.
 *
 * "Bottom bar doesn't always respond to taps" — and "always" is the tell. It
 * responds fine until the software keyboard is up, which on this surface
 * means you were in Search and reached for another tab. The tabs are real
 * buttons, so pressing one takes focus; on iOS that focus change is the
 * keyboard dismissing, and the tap is spent on it.
 *
 * Same answer as the results list: refuse the focus change, keep the click.
 */
describe('the bar when a keyboard is up', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    pathname = '/w/a/t/b';
    sessionStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<MobileChatSectionBar onLeave={() => {}} />);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('refuses the focus change a press would cause', () => {
    const tab = host.querySelector('.mcl-tab') as HTMLElement;
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    tab.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('still switches — refusing focus must not refuse the click', () => {
    const onLeave = vi.fn();
    act(() => {
      root.render(<MobileChatSectionBar onLeave={onLeave} />);
    });
    const unread = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Unread'),
    );
    act(() => unread?.click());
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
