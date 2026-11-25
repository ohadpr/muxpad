import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSection, subscribeSection, writeSection } from './mobile-section';

/**
 * The bug this file exists for: the phone's chat LIST is kept mounted while
 * you are in a chat, and the chat's ribbon is a second, separately mounted
 * copy of the same switcher. Tapping Unread on the ribbon wrote the key and
 * navigated — and the kept list, which had read the key once at mount,
 * opened on Home.
 */
describe('the phone list’s section', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('starts at Home and survives being read again (a reload of the PWA)', () => {
    expect(readSection()).toBe('home');
    writeSection('activity');
    expect(readSection()).toBe('activity');
  });

  it('tells an ALREADY MOUNTED reader — the whole point', () => {
    const seen: string[] = [];
    const off = subscribeSection((s) => seen.push(s));
    writeSection('unread');
    writeSection('search');
    expect(seen).toEqual(['unread', 'search']);
    off();
    writeSection('home');
    expect(seen).toEqual(['unread', 'search']);
  });

  it('refuses a value that is not a section, so a stale key cannot blank the list', () => {
    sessionStorage.setItem('muxpad.mobileSection.v1', 'cards');
    expect(readSection()).toBe('home');
  });

  it('still notifies when storage throws — private mode keeps the session usable', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const seen: string[] = [];
    const off = subscribeSection((s) => seen.push(s));
    expect(() => writeSection('unread')).not.toThrow();
    expect(seen).toEqual(['unread']);
    off();
    spy.mockRestore();
  });
});
