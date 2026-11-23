import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backToList,
  isChatListPath,
  rendersAppBody,
  rootLanding,
  trackListEntry,
  usesChatList,
} from './mobile-nav';

const PHONE = { isMobile: true, embedded: false };
const DESKTOP = { isMobile: false, embedded: false };
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('where `/` lands', () => {
  it('is the chat list on a phone — the root of the mobile layout', () => {
    expect(rootLanding(PHONE)).toBe('chat-list');
  });

  it('is unchanged on desktop: the first workspace', () => {
    expect(rootLanding(DESKTOP)).toBe('first-workspace');
  });

  it('is unchanged in an embed, phone-sized or not — the host app is its navigation', () => {
    expect(rootLanding({ isMobile: true, embedded: true })).toBe('first-workspace');
    expect(usesChatList({ isMobile: true, embedded: true })).toBe(false);
  });

  it('is what RootRedirect asks, and the route that answers it exists', () => {
    const redirect = read('../pages/RootRedirect.tsx');
    expect(redirect).toContain('rootLanding(');
    expect(redirect).toContain('to: CHAT_LIST_PATH');
    expect(read('../router.tsx')).toMatch(/path: '\/chats'/);
  });
});

describe('isChatListPath', () => {
  it('is exact, with or without a trailing slash', () => {
    expect(isChatListPath('/chats')).toBe(true);
    expect(isChatListPath('/chats/')).toBe(true);
    expect(isChatListPath('/chats/x')).toBe(false);
    expect(isChatListPath('/')).toBe(false);
    expect(isChatListPath('/w/a/t/b')).toBe(false);
  });
});

/**
 * THE KEEP-ALIVE. AppLayout keeps every visited workspace mounted and hidden so
 * a terminal's scroll and an agent's xterm survive navigation. The list must
 * render BESIDE those hosts; handing the column to <Outlet/> instead would
 * unmount them, and every return to a chat would re-attach its terminal.
 */
describe('the list renders beside the kept-alive workspace hosts', () => {
  const base = { wsSlug: null, shellRoute: false, sidebarMode: false };

  it('keeps the app body (and so the hosts) on the list, on a phone', () => {
    expect(rendersAppBody({ ...base, chatList: true, onChatList: true })).toBe(true);
  });

  it('keeps it for Artifacts / Apps on a phone too — they are reached from the list', () => {
    expect(rendersAppBody({ ...base, shellRoute: true, chatList: true, onChatList: false })).toBe(
      true,
    );
  });

  it('still hands `/` to its Outlet — the redirect is not a destination', () => {
    expect(rendersAppBody({ ...base, chatList: true, onChatList: false })).toBe(false);
  });

  it('changes nothing on desktop', () => {
    const desk = { chatList: false, onChatList: false };
    expect(rendersAppBody({ ...base, ...desk, wsSlug: 'w' })).toBe(true);
    expect(rendersAppBody({ ...base, ...desk, shellRoute: true, sidebarMode: true })).toBe(true);
    expect(rendersAppBody({ ...base, ...desk, shellRoute: true })).toBe(false);
    expect(rendersAppBody({ ...base, ...desk })).toBe(false);
  });

  it('is wired that way in AppLayout: hosts HIDDEN on the list, never skipped', () => {
    const src = read('../components/AppLayout.tsx');
    expect(src).toContain(
      'rendersAppBody({ wsSlug, shellRoute, sidebarMode, chatList, onChatList })',
    );
    expect(src).toContain('const hostsHidden = shellRoute || onChatList;');
    expect(src).toMatch(/className="workspace-hosts" hidden=\{hostsHidden\}/);
    // The list is mounted from its first visit, and only its VISIBILITY follows
    // the URL — that is what keeps its scroll and its expanded workspaces.
    expect(src).toMatch(
      /\(listVisited \|\| onChatList\) && \(\s*<MobileChatList\s+visible=\{onChatList\}/,
    );
  });

  it('spends ONE row on chrome on the list: no brand bar above the list’s own', () => {
    const src = read('../components/AppLayout.tsx');
    expect(src).toContain('const showTopBar = chrome.topBar && !onChatList;');
    const nav = read('../components/MobileNav.tsx');
    expect(nav).toContain('<ListHeader />');
    expect(nav).toContain('hideBar={true}');
  });

  it('has replaced the drop-down switcher entirely', () => {
    expect(read('../components/AppLayout.tsx')).not.toContain('MobileNavSwitcher');
  });
});

describe('back from a chat goes BACK to the list, not forward to a new one', () => {
  it('walks history to the list entry when the chat was opened from it', () => {
    let list = trackListEntry(null, '/chats', 0);
    list = trackListEntry(list, '/w/a/t/one', 1);
    expect(backToList(list, 1)).toEqual({ kind: 'go', delta: -1 });
  });

  it('walks past several chats opened in a row (the palette, a mention)', () => {
    let list = trackListEntry(null, '/chats', 2);
    list = trackListEntry(list, '/w/a/t/one', 3);
    list = trackListEntry(list, '/w/b/t/two', 4);
    expect(backToList(list, 4)).toEqual({ kind: 'go', delta: -2 });
  });

  it('replaces a cold-opened chat with the list, so the root has nothing behind it', () => {
    const list = trackListEntry(null, '/w/a/t/one', 0);
    expect(backToList(list, 0)).toEqual({ kind: 'replace' });
  });

  it('forgets the list entry once history is back at or before it on another page', () => {
    // list at 1; OS-back to 0 (a chat); push a chat — it overwrites entry 1.
    let list = trackListEntry(null, '/chats', 1);
    list = trackListEntry(list, '/w/a/t/zero', 0);
    expect(list).toBeNull();
    list = trackListEntry(list, '/w/a/t/new', 1);
    list = trackListEntry(list, '/w/a/t/newer', 2);
    expect(backToList(list, 2)).toEqual({ kind: 'replace' });
  });

  it('re-records the list when it comes back to it', () => {
    let list = trackListEntry(null, '/chats', 0);
    list = trackListEntry(list, '/w/a/t/one', 1);
    list = trackListEntry(list, '/chats', 0);
    list = trackListEntry(list, '/w/b/t/two', 1);
    expect(backToList(list, 1)).toEqual({ kind: 'go', delta: -1 });
  });
});
