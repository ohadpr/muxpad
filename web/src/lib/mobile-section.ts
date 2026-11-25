/**
 * WHICH SECTION THE PHONE'S LIST IS ON — one value, two renderers.
 *
 * The list (MobileChatList) is kept mounted while you are in a chat, so it
 * reads this ONCE at its first mount. The chat's own ribbon
 * (MobileChatSectionBar) is a different component, mounted on the chat. When
 * the ribbon only WROTE the key and navigated, the kept list opened on
 * whatever section it had been on before — tap Unread from inside a chat,
 * arrive at Home. Reproduced by an adversarial review.
 *
 * So the write notifies: whoever is already mounted follows it, and whoever
 * mounts later reads it. sessionStorage is what carries it across a reload of
 * the PWA; the listener set is what carries it across the two renderers. No
 * state lifted through AppLayout, and no prop drilled past the router.
 */
import type { ChatSection } from './chat-sections';
import { CHAT_SECTIONS } from './chat-sections';

const SECTION_KEY = 'muxpad.mobileSection.v1';

/** The tab you were on survives a reload of the PWA, not just a trip into a chat. */
export function readSection(): ChatSection {
  try {
    const v = sessionStorage.getItem(SECTION_KEY);
    return (CHAT_SECTIONS as readonly string[]).includes(v ?? '') ? (v as ChatSection) : 'home';
  } catch {
    return 'home';
  }
}
const sectionListeners = new Set<(s: ChatSection) => void>();

export function writeSection(s: ChatSection): void {
  try {
    sessionStorage.setItem(SECTION_KEY, s);
  } catch {
    // private mode etc. — the in-memory state still holds for this session
  }
  for (const fn of sectionListeners) fn(s);
}

export function subscribeSection(fn: (s: ChatSection) => void): () => void {
  sectionListeners.add(fn);
  return () => {
    sectionListeners.delete(fn);
  };
}
