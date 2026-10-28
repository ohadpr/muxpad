import { useEffect, useState } from 'react';
import { THEME_CHOICES, type ThemeChoice, setChatTheme } from '../settings';
import { cachedAllTabs, subscribeAllTabs } from './all-tabs';

/**
 * THE THEME OF THE CHAT YOU ARE LOOKING AT.
 *
 * A theme used to be one fact — what this browser looks like. It is two now:
 * the device's default (localStorage) and the chat's own, which lives on the
 * tab row so it follows you to every device. The chat wins while you are in
 * it, and `null` means it has no opinion.
 *
 * THE WHOLE WINDOW CHANGES, not just the pane. That is what "switching tabs
 * can switch themes" means, and it is the only coherent option: a theme
 * defines the RAIL's palette as well as the pane's, so a memphis chat beside
 * a tokyo-night rail is a pairing nothing was designed against.
 */

/** A row's stored value, resolved against the themes this build actually has.
 *
 *  An unknown name reads as "no opinion" rather than as an error: the value
 *  is written by whichever client set it, and that client may be newer than
 *  this one (a theme added since) or older (one that has since been renamed).
 *  Neither is worth a broken document. */
export function readChatTheme(raw: string | null | undefined): ThemeChoice | null {
  if (!raw) return null;
  return THEME_CHOICES.some((c) => c.value === raw) ? (raw as ThemeChoice) : null;
}

/**
 * Keep the document pointed at the active chat's theme.
 *
 * Reads the corpus the rail and the mention picker already keep in memory, so
 * switching tabs costs no request — and subscribes to it, because the value
 * can change under you: from another device, or from the picker in this one.
 */
export function useChatTheme(activeTabSlug: string | null): void {
  useEffect(() => {
    const pick = (): void => {
      if (!activeTabSlug) {
        setActiveChat(null);
        setChatTheme(null);
        return;
      }
      for (const group of cachedAllTabs() ?? []) {
        for (const tab of group.tabs) {
          if (tab.slug !== activeTabSlug) continue;
          setActiveChat({ id: tab.id, workspaceId: group.id });
          setChatTheme(readChatTheme(tab.theme));
          return;
        }
      }
      // The corpus has not landed yet (first paint, or a tab created on
      // another device). Leave whatever is showing rather than flashing the
      // default at a chat that may well have its own — the subscription below
      // fires the moment the list arrives.
    };
    pick();
    return subscribeAllTabs(pick);
  }, [activeTabSlug]);
}

/**
 * WHICH CHAT THE THEME PICKER IS ABOUT.
 *
 * The picker is mounted in two places that know nothing about routing — the
 * settings dialog and the rail's footer popover — and threading the active
 * tab through either as a prop means every host of a theme grid has to know
 * about chats.
 *
 * It is not read from the router here either, for a blunter reason: the
 * dialog is tested without one, and a hook that throws outside a RouterProvider
 * makes a settings test a routing test. `useChatTheme` has already resolved
 * the tab — it is the thing that decided what the document is wearing — so it
 * publishes the answer and this reads it. Null on the workspace picker, where
 * there is no chat to set a theme on.
 */
let activeChat: { id: string; workspaceId: string } | null = null;
const chatListeners = new Set<(c: { id: string; workspaceId: string } | null) => void>();

function setActiveChat(next: { id: string; workspaceId: string } | null): void {
  if (activeChat?.id === next?.id) return;
  activeChat = next;
  for (const fn of chatListeners) fn(next);
}

export function useActiveTab(): { id: string; workspaceId: string } | null {
  const [state, setState] = useState(activeChat);
  useEffect(() => {
    setState(activeChat);
    chatListeners.add(setState);
    return () => {
      chatListeners.delete(setState);
    };
  }, []);
  return state;
}
