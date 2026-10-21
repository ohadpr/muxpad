import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissNotice, getNotices, noticeFromError, pushNotice } from '../lib/notice-store';
import { NoticeToast } from './NoticeToast';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What five `window.alert` calls became. The behaviour that matters is the
 * behaviour the dialog did NOT have: it does not block, it goes away on its
 * own, and several failures do not queue up one modal behind another.
 */
describe('failure notices', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const toasts = () => [...host.querySelectorAll('.notice-toast')];

  beforeEach(() => {
    // The store is a module singleton (one stack for the whole app), so a
    // notice from the previous test is still in it.
    for (const n of getNotices()) dismissNotice(n.id);
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<NoticeToast />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('renders nothing at all until something fails', () => {
    expect(host.innerHTML).toBe('');
  });

  it('says it in a sentence and keeps the exception underneath', () => {
    act(() => noticeFromError('Couldn’t close "Acme".', new Error('tab 7 is busy')));
    expect(toasts()).toHaveLength(1);
    expect(host.querySelector('.notice-toast-msg')?.textContent).toBe('Couldn’t close "Acme".');
    expect(host.querySelector('.notice-toast-detail')?.textContent).toBe('tab 7 is busy');
  });

  it('omits the detail line when there is no cause to show', () => {
    act(() => pushNotice({ message: 'Nothing happened.' }));
    expect(host.querySelector('.notice-toast-detail')).toBeNull();
  });

  it('expires on its own — the thing a modal never did', () => {
    act(() => pushNotice({ message: 'one' }));
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(toasts()).toHaveLength(0);
  });

  it('stacks rather than queueing modals, and is dismissable', () => {
    act(() => {
      pushNotice({ message: 'one' });
      pushNotice({ message: 'two' });
    });
    expect(toasts()).toHaveLength(2);
    act(() => {
      host
        .querySelector('.notice-toast-dismiss')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toasts()).toHaveLength(1);
  });

  it('is announced — the news still matters, the modal was just the wrong box', () => {
    act(() => pushNotice({ message: 'one' }));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
});
