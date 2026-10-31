import { beforeEach, describe, expect, it } from 'vitest';
import { getChatTheme, setChatTheme } from '../settings';
import { readChatTheme } from './chat-theme';

/**
 * A CHAT MAY CARRY ITS OWN THEME.
 *
 * The theme used to be one fact — what this browser looks like. It is two: the
 * device's default (localStorage) and the chat's own, which lives on the tab
 * row so it follows you to every device. The chat wins while you are in it.
 */
describe('reading a row’s theme', () => {
  it('takes a name this build actually has', () => {
    expect(readChatTheme('memphis')).toBe('memphis');
    expect(readChatTheme('system')).toBe('system');
  });

  it('treats an unknown name as no opinion, not as an error', () => {
    // The value is written by whichever client set it, which may be newer than
    // this one (a theme added since) or older (one since renamed). Neither is
    // worth a broken document.
    expect(readChatTheme('vaporwave')).toBeNull();
  });

  it('treats absent and empty as no opinion', () => {
    expect(readChatTheme(null)).toBeNull();
    expect(readChatTheme(undefined)).toBeNull();
    expect(readChatTheme('')).toBeNull();
  });
});

describe('the document follows the chat, then the device', () => {
  beforeEach(() => {
    setChatTheme(null);
  });

  it('wears the chat’s theme while it has one', () => {
    setChatTheme('memphis');
    expect(document.documentElement.dataset.theme).toBe('memphis');
    expect(getChatTheme()).toBe('memphis');
  });

  it('falls back to the device default when the chat has none', () => {
    setChatTheme('memphis');
    setChatTheme(null);
    expect(document.documentElement.dataset.theme).not.toBe('memphis');
    expect(getChatTheme()).toBeNull();
  });

  it('resolves the chat’s own "system" against the OS, not the device setting', () => {
    // A chat that chose System means "follow this machine's light/dark", and
    // the device default is irrelevant while that chat is open.
    setChatTheme('system');
    expect(['alucard', 'dracula']).toContain(document.documentElement.dataset.theme);
  });
});
